# Agent Harness & Task Orchestration — Subsystem Design

**App:** Cowrite — a local-first, illustrated long-form co-writing tool ("simple, modern, snappy")
**Subsystem owner:** Agent harness & task orchestration
**Status:** Proposal v1 (2026-07-06)

> **Provenance note.** The product-brief path supplied to this task resolved to `undefined`. The
> repository contains `docs/00-overview.md`, which carries the product description, glossary,
> fixed constraints, and the fixed baseline stack; this design treats that document as the
> authoritative brief. The output path also resolved to `undefined`; this file is placed at
> `docs/design/agent-harness.md`, alongside the sibling design `docs/design/data-model.md`,
> whose contracts (§10 there) this design consumes and, where noted, extends.

---

## 1. Scope and principles

The agent harness is the server-side subsystem that turns a user gesture ("continue", "tighten
this paragraph", background "summarize chapter 3") into: an assembled prompt (via the context
engine), one or more model calls against user-configured OpenAI-compatible endpoints, a live
SSE stream to the UI, committed artifacts (snippet revisions, summaries, images) written through
the storage layer, and a permanent, replayable **agent run** record.

Design principles, inherited from the brief:

1. **One loop, many tasks.** Every task kind runs through the same two-stage runner
   (plan-with-tools → write). Task kinds differ only in their spec, routing, prompt template,
   output contract, and commit function. No per-task bespoke loops.
2. **The harness never touches files.** All reads go through the context engine or storage
   queries; all writes go through `StorageService`. (Data-model doc §13.4 requires this.)
3. **Cache-frugal.** Conversations are strictly append-only within a run; system prompts and
   context prefixes are stable across turns so prefix caches on the user's endpoints hit.
4. **Everything is a run.** If a model was called, there is a run file. If an artifact exists,
   it points at the run that made it. No anonymous model output anywhere in the system.
5. **Test without models.** The harness depends on an `LlmClient` interface with exactly two
   implementations: real OpenAI-compatible HTTP, and the scriptable mock (§12).

Out of scope here (owned elsewhere, consumed via interfaces in §13): prompt markup and wording
(07-prompting), context selection/expansion logic (06-context-engine), ComfyUI mechanics and the
VLM image feedback loop (08-illustration), on-disk formats (data-model).

---

## 2. Task taxonomy

`TaskKind` is a closed enum. Each row: who initiates it, what it targets, which model lane it
runs on (§3), which queue lane (§6), and what it commits.

| Kind | Initiator | Target | Model | Lane | Commits |
|---|---|---|---|---|---|
| `continue` | user (big button / hotkey) | frontier tail | high | interactive | 1 new snippet (~a "page": target 300–700 words) |
| `instructed-continue` | user (inline instruction box) | frontier tail | high | interactive | 1 new snippet |
| `quick-edit` | user (select text → short instruction) | one snippet, or a paragraph span of one frozen section | high | interactive | 1 snippet revision **or** 1 section-span replacement |
| `edit-task` | user (detailed edit pane) | explicit set: snippets and/or sections, chosen world entries pinned into context | high | interactive | n snippet revisions / section-span replacements |
| `enrich-section` | scheduler (post-consolidation, staleness sweep) or user ("refresh summary") | one frozen section | low | background | section `title` (if agent-owned), `summary-short.md`, `summary-long.md` — one run produces all three |
| `propose-boundaries` | consolidation engine | eligible frontier prefix | low | background | a `BoundaryProposal` (consumed by consolidation, not written directly) |
| `illustrate-section` | scheduler (after enrich) or user | one frozen section | low (prompt-writing + VLM check) + ComfyUI | illustration | `illustration.png` + prompt metadata |
| `world-image` | user (world-entry editor) | one world entry | low + ComfyUI | illustration | `world/images/<entryId>.png` |

Notes on semantics:

- **`continue` vs `instructed-continue`** share a template; the latter injects the user's text
  inside an explicit `<instructions>` block (never as prose), per the brief's "clearly delineated
  as instructions" rule. The Situation pane content, when present, is included in *both* as
  instruction-marked context (context engine's job).
- **`quick-edit`** is deliberately thin: selection + one-line instruction, no options. The
  harness derives the target: if the selection lies in a frontier snippet, the target is that
  whole snippet; if it lies in a frozen section, the target is the selection expanded to
  enclosing paragraph boundaries (a contiguous span). See output contract, §5.4.
- **`edit-task`** is the same runner with a richer spec: multiple explicit targets, user-pinned
  world entries (bypassing the context engine's own selection for those), a free-form multi-line
  instruction, and a pre-run token estimate (§9). It is the only task with a pre-flight UI.
- **`enrich-section`** produces name + short + long summary in **one** low-model run (one context
  assembly, one cache prefix, three tagged output blocks). A user-set title (`titleSource:
  "user"`) is never overwritten; the run then emits only summaries.
- **`propose-boundaries`** is invoked *synchronously by* the consolidation engine (data-model
  §6.3) but *executes as* a normal queued run so it is recorded, cancellable, and mockable. Its
  output is returned to the caller, validated against `BoundaryProposal`; the harness commits
  nothing itself.
- **Illustration tasks** are *scheduled and recorded* here, *executed* by the illustration
  pipeline: the runner hands the pipeline a `RunContext` (event sink + abort signal + low-model
  client) and the pipeline drives prompt-writing → ComfyUI → VLM check inside it. One run file
  covers the whole loop, including image-gen attempts as tool-call events.

### 2.1 Task spec schemas (`packages/shared/src/agents.ts`)

```ts
import { z } from "zod";
import { Ulid } from "./ids";              // shared with data-model schemas

export const TaskKind = z.enum([
  "continue", "instructed-continue", "quick-edit", "edit-task",
  "enrich-section", "propose-boundaries", "illustrate-section", "world-image",
]);

/** A contiguous paragraph span inside a frozen section (paragraph = blank-line block). */
export const SectionSpan = z.object({
  sectionId: Ulid,
  fromParagraph: z.number().int().nonneg(),   // inclusive
  toParagraph: z.number().int().nonneg(),     // inclusive
  baseContentHash: z.string(),                // section content.md hash at selection time
});

export const EditTarget = z.discriminatedUnion("type", [
  z.object({ type: z.literal("snippet"), snippetId: Ulid, baseRev: z.number().int().positive() }),
  z.object({ type: z.literal("sectionSpan"), span: SectionSpan }),
]);

export const TaskSpec = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("continue") }),
  z.object({ kind: z.literal("instructed-continue"), instruction: z.string().min(1).max(4000) }),
  z.object({
    kind: z.literal("quick-edit"),
    instruction: z.string().min(1).max(500),
    target: EditTarget,
    /** exact selected text + offsets, for the prompt's <selected> marker */
    selection: z.object({ text: z.string(), start: z.number().int(), end: z.number().int() }),
  }),
  z.object({
    kind: z.literal("edit-task"),
    instruction: z.string().min(1).max(20_000),
    targets: z.array(EditTarget).min(1).max(12),
    pinnedWorldEntryIds: z.array(Ulid).max(20).default([]),
  }),
  z.object({ kind: z.literal("enrich-section"), sectionId: Ulid,
             parts: z.array(z.enum(["title","short","long"])).min(1) }),
  z.object({ kind: z.literal("propose-boundaries"),
             eligibleSnippetIds: z.array(Ulid).min(1) }),
  z.object({ kind: z.literal("illustrate-section"), sectionId: Ulid }),
  z.object({ kind: z.literal("world-image"), entryId: Ulid }),
]);
export type TaskSpec = z.infer<typeof TaskSpec>;

export const TaskStatus = z.enum(["queued", "running", "done", "error", "cancelled"]);

export const Task = z.object({
  id: Ulid,                    // taskId == runId once started (1 task : 1 run)
  workId: Ulid,
  spec: TaskSpec,
  lane: z.enum(["interactive", "background", "illustration"]),
  status: TaskStatus,
  queuedAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  endedAt: z.string().datetime().nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
});
```

`baseRev` / `baseContentHash` on edit targets exist for the concurrent-edit guard (§5.6).

---

## 3. Model routing

Two lanes, both plain OpenAI-compatible `/v1/chat/completions` with streaming. Separate endpoint,
key, and model name for each; nothing else is user-tunable in the UI (brief principle: "agentic
quality, not parameter quality" — sampler knobs live in the config file only).

### 3.1 Configuration

`cowrite.config.json` (app-level, not per-work; `${env:VAR}` interpolation for secrets):

```jsonc
{
  "models": {
    "high": {                                  // prose + heavyweight agentic; TEXT-ONLY
      "baseUrl": "https://api.example.com/v1",
      "apiKey": "${env:COWRITE_HIGH_KEY}",
      "model": "big-writer-70b",
      "maxOutputTokens": 2048,
      "temperature": 0.8,
      "promptCostPerMTok": 3.0,                // optional, for cost display (§9)
      "completionCostPerMTok": 15.0
    },
    "low": {                                   // VLM; summaries, image prompts, cheap agentic
      "baseUrl": "http://localhost:8081/v1",
      "apiKey": "${env:COWRITE_LOW_KEY}",
      "model": "small-vlm-8b",
      "maxOutputTokens": 1024,
      "temperature": 0.3
    }
  },
  "routing": {                                 // per-kind overrides; defaults shown in §2 table
    "propose-boundaries": "low"                // e.g. flip to "high" if low model chops badly
  },
  "harness": { /* §6 timeouts/limits, all optional */ }
}
```

Validated at startup with Zod (`ModelEndpointConfig`); a missing/invalid model config surfaces as
`config_missing` on first task attempt (§11), not as a crash — the app must still open works
read-only without any endpoints configured.

### 3.2 Routing rules (hard invariants)

- The **high** model never receives image content — enforced in `LlmClient` by type: the high
  client's message schema has no image parts. The **low** model is the only one that may get
  `image_url` parts (illustration VLM check, world-image reference art).
- Routing is by `TaskKind` via the table in §2, overridable per kind in config. There is no
  per-request routing logic ("use low if the prompt is short" etc.) — rejected as fiddly and
  cache-hostile.
- Planning and writing stages of one run always use the **same** lane (mixed-lane runs rejected:
  two prefix caches, double config surface, negligible savings since planning tokens are small).

### 3.3 `LlmClient` interface

```ts
export interface LlmClient {
  lane: "high" | "low";
  chat(req: {
    messages: ChatMessage[];                 // append-only across the run
    tools?: ToolDef[];                       // OpenAI function-tool JSON schemas
    maxOutputTokens?: number;
    signal: AbortSignal;
  }): AsyncIterable<LlmStreamEvent>;         // {type:"delta",text} | {type:"toolCall",...}
                                             // | {type:"usage", promptTokens, completionTokens}
}
```

Implementation is a thin `fetch` + SSE parser (~200 lines, no SDK dependency — the OpenAI SDK
drags in retries/timeouts we want to own ourselves). `stream_options: {"include_usage": true}`
is requested; when an endpoint omits usage we fall back to the chars/4 estimator and mark usage
`estimated: true` in the run record.

---

## 4. The agent loop

One runner, two stages. Stage 1 (**planning**) lets the model orient itself in the work via
context-engine tool calls; stage 2 (**writing**) forces final output, tools disabled.

### 4.1 Conversation shape

```
[system]    stable per-work system prompt (voice rules, markup contract)     ← cache-stable
[user]      context block from contextEngine.assemble(): instructions at
            top, world info, summaries, freshest prose at bottom            ← cache-stable-ish
[assistant] (tool calls)     ┐
[tool]      (tool results)   │  0..maxToolRounds planning rounds, append-only
[assistant] (tool calls)     │
[tool]      (tool results)   ┘
[user]      stage-2 cue: "Write now. Output format: …"                       ← tiny, templated
[assistant] final output (streamed)
```

Tool-call output is injected the standard OpenAI way — an `assistant` message carrying
`tool_calls` followed by one `tool` role message per call containing the engine's rendered
result (markdown text, engine-capped at **4,096 tokens per result**). We never rewrite earlier
messages to "merge" expansions into the context block; that would invalidate the prefix cache
every round. Decay of expanded items back to summaries (the engine's soft-budget feature)
applies *across* runs, not within one.

### 4.2 Runner pseudocode

```
run(task):
  runId = task.id
  sink  = RunSink(runId)                       # tees events → run JSONL + SSE bus (§7, §8)
  client = llmFor(routing[task.spec.kind])
  handler = handlers[task.spec.kind]           # prompt template + output contract + commit fn

  asm = contextEngine.assemble(workId, handler.contextRequest(spec))
      # → { messages, tools, execTool(name,input) → string, snapshot }  (§13.1)
  sink.messages(asm.messages)

  # ---- Stage 1: planning (skipped when handler.maxToolRounds == 0) ----
  msgs = asm.messages
  for round in 1..handler.maxToolRounds:
      resp = await client.chat({ messages: msgs, tools: asm.tools, signal })
      if resp has no toolCalls: break                     # model is ready; discard any
      for tc in resp.toolCalls:                           #  planning-stage prose it emitted
          out = await asm.execTool(tc.name, tc.input)     # engine enforces budgets
          sink.toolCall(tc, out)
          msgs += [assistant(tc), tool(out)]
  # exceeding maxToolRounds is not an error: proceed to stage 2 regardless

  # ---- Stage 2: writing ----
  msgs += [ user(handler.writeCue(spec)) ]                # includes output-format contract
  stream = client.chat({ messages: msgs, signal })        # NO tools
  parsed = TagBlockParser(handler.expectedBlocks(spec))   # §5.2
  for ev in stream:
      if ev.delta: parsed.push(ev.delta); sink.delta(parsed.drainVisible())
      if ev.usage: sink.usage(ev.usage)
  blocks = parsed.finish()

  if blocks invalid and repairAttempts < 1:               # one cheap repair turn (§5.5)
      msgs += [assistant(rawOutput), user(REPAIR_CUE)]
      retry stage 2 once
  artifacts = await handler.commit(blocks, spec)          # storage writes, atomic per target
  sink.result("ok", usage, artifacts)
```

Defaults: `maxToolRounds` — `continue`/`instructed-continue` **6**, `quick-edit` **2**,
`edit-task` **6**, `enrich-section` **2**, `propose-boundaries` **2**, illustration tasks **0**
(the pipeline makes its own low-model calls, recorded as tool-call events on the same run).
Planning rounds that return zero tool calls end stage 1 early — the common case for `continue`
near a warm frontier is 0–1 rounds.

### 4.3 Streaming to the UI

Stage-2 deltas stream over the task's SSE channel (§8) as they clear the tag parser, so the UI
renders prose token-by-token into a **pending** overlay (a ghost snippet at the frontier, or a
highlighted replacement region for edits). Planning-stage activity streams as compact
`tool_call` events ("read chapter 2 summary…") so long plans don't look like a hang. Nothing is
written to storage until commit (§5.6) — the stream is presentation, the commit is truth.

---

## 5. Edits: application model and output contract

### 5.1 Decision: direct apply + revision history (no propose-then-apply)

**Recommendation: apply on completion, immediately, with the revision recorded; undo = revert to
previous revision.** The data model already gives every snippet full-text revision events with
one-click rollback, and gives sections cheap atomic rewrites with derived staleness. A separate
proposal/diff-review state would duplicate that safety net, add a second persistence shape
("pending proposals"), and put a modal between the user and the text — the opposite of snappy.
The streamed pending overlay *is* the preview; when the stream finishes the text settles and a
toast offers Undo.

*Rejected:* **propose-then-apply with diff review** (adds a state machine and UI mode for safety
we already have via revisions; right for code, wrong for prose where the user reads the result,
not the diff). **Apply-per-paragraph while streaming** (partial edits visible on failure;
violates all-or-nothing per target).

One exception: when the concurrent-edit guard trips (§5.6), the completed edit degrades into a
proposal card instead of committing — that is a conflict fallback, not a review workflow.

### 5.2 Decision: output contract = **whole-target rewrite in tag blocks**, never search/replace

Every writing-stage output is one or more **tag blocks**; each block is the *complete replacement
text for a harness-designated target*:

```
<snippet id="new">…full prose of the new snippet…</snippet>              # continue tasks
<snippet id="01J2P7R9GT5W0ZNXK3M8QAB4CD">…full rewritten snippet…</snippet>   # edits
<span section="01J2KF…" from="4" to="6">…full rewritten paragraphs 4–6…</span>
<title>…</title> <summary-short>…</summary-short> <summary-long>…</summary-long>   # enrich
<boundaries>{"boundaries":[{"afterSnippetId":"01J2…","kind":"chapter","title":"…"}]}</boundaries>
<image-prompt>…</image-prompt>                                            # illustration tasks
```

The harness's `TagBlockParser` is a small streaming extractor: it withholds output until the
opening tag of an expected block, streams the interior as deltas, tolerates and discards any
chatter outside blocks ("Here's the revised passage:" preambles cost nothing), and validates on
close: every emitted block id/span must match a declared target; unknown ids are dropped with a
warning event; missing mandatory blocks trigger the repair turn (§5.5).

**Why whole-target rewrite beats search/replace blocks for prose.** Search/replace relies on the
model reproducing the original text *exactly* to anchor the edit. Creative prose is pathological
for this: repeated phrases and refrains make anchors ambiguous; models silently normalize curly
quotes, em-dashes, and ellipses so anchors miss; paragraph-length matches inflate output tokens
to no benefit; and a missed anchor either fails the whole edit or — worse — lands in the wrong
scene. With whole-target rewrite the *harness* picks the boundaries (snippet id, paragraph span)
from ground truth, so application is a trivial, always-correct splice, and validation is just
"did a block with this id arrive." Targets are small by construction (snippets are 100–2,000
words; spans are selection-sized), so the token overhead vs. minimal diffs is modest and buys
determinism. *Rejected:* search/replace blocks (anchoring fragility above); unified diffs (same
anchoring problem plus line-orientation that fights reflowed prose); function-calling / JSON
mode for final prose (JSON-escaped prose is token-bloated, kills streaming readability, and
`json_schema` support is inconsistent across OpenAI-compatible endpoints — tags are the lowest
common denominator).

### 5.3 Continue tasks

Commit = `storage.appendSnippet({ text, authorship: "agent", originRunId })`. The write cue pins
length ("one page: 300–700 words, end at a natural beat, do not resolve the scene unless
instructed") and the single `<snippet id="new">` block. Multiple snippets per continue are
rejected for MVP (one page per press keeps the turn-taking rhythm the product is built on).

### 5.4 Edit tasks (quick-edit, edit-task)

- **Snippet target** → expect `<snippet id=…>`; commit via
  `storage.reviseSnippet(snippetId, text, { author: "agent", runId, baseRev })`.
- **Section-span target** → expect `<span section=… from=… to=…>` matching the spec's span;
  commit via `storage.replaceSectionSpan(span, text, { runId })` — an atomic `content.md`
  rewrite that flips summary staleness by the data model's own rules. Paragraph indices are
  computed against `baseContentHash`; the prompt shows the span with numbered paragraph markers
  and the user's `<selected>…</selected>` region inside it.
- Multi-target `edit-task` commits are applied target-by-target, each atomic; a block that fails
  validation skips only its target and is reported in the result artifact list as `skipped`.
  (All-or-nothing across targets was rejected: one bad block shouldn't discard eleven good
  rewrites the user watched stream in.)

### 5.5 Output repair

If stage 2 ends with a mandatory block missing/unclosed, the harness appends the raw output as
an assistant message plus a terse corrective user message ("Your reply contained no
`<snippet id="…">` block. Reply with only the required block(s), no commentary.") and re-runs
stage 2 **once**. Second failure → run fails with `output_invalid`, raw text preserved in the
run file and offered in the error surface as copyable text. In mock-server testing this path is
exercised explicitly; in practice one repair turn fixes the vast majority of format misses.

### 5.6 Concurrent-edit guard

Edit specs carry `baseRev` (snippets) / `baseContentHash` (sections) captured at task creation.
At commit time the runner re-checks via storage: if the user edited the target while the run was
in flight, the commit is withheld, the run ends `status: "ok"` with artifact state
`conflict`, and the UI shows the completed rewrite as a card ("Text changed while editing —
apply anyway / discard"). Apply-anyway commits a normal revision on top. Continue tasks have no
guard (append-only; a user snippet typed mid-run simply precedes the new one — the pending
overlay already sits at a fixed orderKey reserved at task start).

---

## 6. Execution model: queue, cancellation, timeouts, retries

### 6.1 Queue semantics

Per-work scheduler, in-process, in-memory (queue state is *not* persisted; on restart, queued
tasks are gone — cheap to re-issue, and background tasks re-derive from staleness). Three lanes:

| Lane | Capacity | Members | Policy |
|---|---|---|---|
| `interactive` | **1** per work | continue, instructed-continue, quick-edit, edit-task | New interactive submission while one runs → **409 `busy`** with the running task id; the UI offers "cancel current & start". No silent preemption, no queueing of writing tasks (a queue of stale writing intents is a footgun). |
| `background` | **2** per work | enrich-section, propose-boundaries | FIFO; `propose-boundaries` jumps the queue (consolidation is waiting on it). Deduped by `(kind, targetId)` — enqueueing an enrich for a section already queued is a no-op. |
| `illustration` | **1 global** (ComfyUI is one box) | illustrate-section, world-image | FIFO across works; user-initiated jumps ahead of scheduler-initiated. |

Interactive and background lanes run concurrently — they mostly hit different endpoints
(high vs low), and storage writes are serialized in-process. One carve-out: while a
`propose-boundaries`/consolidation apply is in flight, interactive `continue` commits wait on
the storage-level consolidation journal (milliseconds), never the other way around.

Scheduler triggers for background work: consolidation completes → enqueue `enrich-section` for
each new section, then `illustrate-section` after its enrich succeeds; reconciler flags stale
enrichments → idle sweep (app focused, interactive lane empty for **60 s**) enqueues refreshes,
capped at **4 per sweep** to keep surprise API spend bounded.

### 6.2 Cancellation

`POST /api/works/:workId/tasks/:taskId/cancel` → resolves the task's `AbortController` → the
in-flight fetch aborts, the run file gets `result: {status:"cancelled"}`, the SSE stream emits
`cancelled` with any partial stage-2 text (§6.4). Closing the SSE connection does **not** cancel
(a refreshed tab must be able to reattach, §8.2). Queued tasks cancel by removal. Work close
cancels everything in that work's lanes.

### 6.3 Timeouts and retries (defaults; all in `config.harness`)

| Knob | Default | Applies to |
|---|---|---|
| `connectTimeoutMs` | 15 000 | TCP/TLS + request write |
| `firstTokenTimeoutMs` | 60 000 | request sent → first stream event |
| `idleTokenTimeoutMs` | 30 000 | gap between stream events |
| `totalTimeoutMs.high` | 300 000 | whole model call (high lane) |
| `totalTimeoutMs.low` | 120 000 | whole model call (low lane) |
| `retry.maxAttempts` | 3 | per model call (1 initial + 2 retries) |
| `retry.backoffMs` | 1 000 → 4 000 (+ full jitter) | between attempts; honor `Retry-After` on 429 |

Retryable: network errors, 408/429/5xx, first-token timeout, **and mid-stream death during
planning** (no user-visible text lost — replay the call; tool results already obtained are kept,
`execTool` is read-only/idempotent). Non-retryable: 400/401/403 (`config`/`auth` errors),
`output_invalid` after repair, abort, total timeout.

### 6.4 Partial failure: stream dies mid-write

If the stage-2 stream dies (network drop, idle timeout) the harness retries the *writing call
only* (same messages) up to the attempt budget — the pending overlay resets, which the UI shows
as "retrying…". If all attempts fail:

- **Continue tasks:** nothing was committed. The run ends `error`, and the error event carries
  `partialText` (the best partial from any attempt, longest wins). The UI offers **Keep partial
  as draft** — accepting commits it as a normal user-side snippet revision citing the run — or
  discard. Losing three good paragraphs to a router hiccup is the #1 rage moment in this
  category of app; this one affordance removes it.
- **Edit tasks:** strictly all-or-nothing per target; partial rewrites are never offered (a
  half-rewritten paragraph is worse than none). Partial text still lives in the run file for the
  curious.
- **Enrichment/boundary:** fail silently to the log + staleness remains; the sweep retries later
  (with the 50 % threshold growth rule for boundaries owned by consolidation).
- **Illustration:** the pipeline reports which attempt failed; the run records it; section keeps
  its previous image (replacement is atomic overwrite at commit only).

---

## 7. Run persistence & retention

One task = one run = one JSONL file at `runs/<YYYY-MM>/<runId>.jsonl` (data-model §5.2), written
through `storage.recordRun(runId)` which returns an append sink. The harness extends the
data-model `RunEvent` union (superseding its draft in data-model §10 — flagged in §13):

```ts
export const RunKind = TaskKind;             // unify: run kinds ARE task kinds
export const RunEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("meta"), runId: Ulid, kind: TaskKind, lane: z.enum(["high","low"]),
             model: z.string(), spec: TaskSpec, params: z.record(z.string(), z.unknown()),
             contextSnapshot: z.unknown(),    // engine's report: what was included & why (§13.1)
             startedAt: IsoTime }),
  z.object({ type: z.literal("message"), role: z.enum(["system","user","assistant","tool"]),
             text: z.string() }),
  z.object({ type: z.literal("stage"), stage: z.enum(["planning","writing"]), round: z.number().int() }),
  z.object({ type: z.literal("toolCall"), name: z.string(), input: z.unknown(),
             output: z.string(), durationMs: z.number() }),
  z.object({ type: z.literal("output"), text: z.string() }),   // flushed ≥ every 2s / 2KB
  z.object({ type: z.literal("attempt"), n: z.number().int(), reason: z.string() }), // retries
  z.object({ type: z.literal("usage"), promptTokens: z.number().int(),
             completionTokens: z.number().int(), estimated: z.boolean().default(false),
             call: z.enum(["planning","writing","pipeline"]) }),
  z.object({ type: z.literal("result"), status: z.enum(["ok","error","cancelled"]),
             error: z.object({ code: z.string(), message: z.string() }).optional(),
             usageTotal: z.object({ promptTokens: z.number().int(),
                                    completionTokens: z.number().int() }),
             artifacts: z.array(RunArtifact), endedAt: IsoTime }),
]);
export const RunArtifact = z.object({
  kind: z.enum(["snippet","snippet-revision","section-span","section-title",
                "summary-short","summary-long","illustration","world-image","boundary"]),
  snippetId: Ulid.optional(), sectionId: Ulid.optional(), entryId: Ulid.optional(),
  rev: z.number().int().optional(),
  state: z.enum(["committed","conflict","skipped"]).default("committed"),
});
```

This is exactly what the provenance UI needs: **GET a run → replay meta (spec + context
snapshot) → messages → tool calls → output → artifacts** renders "the prompt/process that gave
rise to this version" with zero joins beyond `run_artifacts` (data-model §7.1). Deltas are
buffered and flushed as consolidated `output` events (≥ every 2 s or 2 KB) so run files stay
one-line-per-meaningful-event, not one-line-per-token.

**Retention.** Run files are permanent by default and are *not* collapsed at consolidation —
this is deliberate and consistent: consolidation discards *intermediate snippet texts* (cheap to
regret, expensive to keep in the hot path) but keeps every `runId` in `history.jsonl`, and those
ids must keep resolving for the provenance UI on frozen prose. Runs are small (tens of KB of
text) and month-sharded. Two bounded exceptions: runs whose `result` never got written (crash)
are finalized at startup as `status:"error", code:"crash"`; and a config knob
`retention.pruneRunsAfterMonths` (default **off**) deletes run files whose ids no longer appear
in any `history.jsonl` / revision log / enrichment meta — structured-for, deferred.

---

## 8. API surface (Fastify routes) and SSE

All request/response schemas live in `@cowrite/shared`; Fastify handlers parse with Zod on both
sides of the wire.

| Method & path | Purpose | Notes |
|---|---|---|
| `POST /api/works/:workId/tasks` | enqueue a task; body = `TaskSpec` | → `202 {task}`; `409 {code:"busy", runningTaskId}` for the interactive lane |
| `GET /api/works/:workId/tasks` | current queue + running tasks | UI status strip |
| `GET /api/works/:workId/tasks/:taskId/events` | **SSE** stream of `TaskEvent`s | resumable via `Last-Event-ID` (§8.2) |
| `POST /api/works/:workId/tasks/:taskId/cancel` | cancel queued/running | idempotent |
| `POST /api/works/:workId/tasks/estimate` | dry-run context assembly → token/cost estimate | body = `TaskSpec`; §9 |
| `GET /api/works/:workId/runs/:runId` | parsed `RunEvent[]` for provenance view | reads the JSONL |
| `GET /api/works/:workId/runs?artifact=<kind>:<id>` | runs that touched an artifact | via `run_artifacts` |
| `GET /api/works/:workId/usage?since=…` | token/cost rollups | via `agent_runs` sums |
| `POST /api/tasks/proposals/:taskId/apply` `…/discard` | conflict-card resolution (§5.6) and keep-partial (§6.4) | proposal held in memory 30 min |

### 8.1 SSE event schema (`TaskEvent`)

```ts
export const TaskEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("queued"),  position: z.number().int() }),
  z.object({ type: z.literal("started") }),
  z.object({ type: z.literal("stage"),   stage: z.enum(["planning","writing"]) }),
  z.object({ type: z.literal("tool"),    name: z.string(), label: z.string() }), // human label
  z.object({ type: z.literal("delta"),   target: z.string(), text: z.string() }),// target = block id
  z.object({ type: z.literal("retrying"), attempt: z.number().int(), reason: z.string() }),
  z.object({ type: z.literal("usage"),   promptTokens: z.number().int(),
             completionTokens: z.number().int(), costUsd: z.number().nullable() }),
  z.object({ type: z.literal("artifact"), artifact: RunArtifact }),
  z.object({ type: z.literal("done") }),
  z.object({ type: z.literal("cancelled"), partialText: z.string().nullable() }),
  z.object({ type: z.literal("error"), code: ErrorCode, message: z.string(),
             partialText: z.string().nullable(), retryable: z.boolean() }),
]);
```

Each event carries a monotonically increasing `id:` (per task). Heartbeat comment every 15 s.

### 8.2 Resumability

Every emitted event is kept in an in-memory ring buffer per task (last 512 events) for the
task's lifetime + 5 minutes. A client reconnecting with `Last-Event-ID` replays from the buffer;
if the task already finished, the replay ends with the terminal event and closes. A fully
restarted server can't replay (buffer is memory-only) — the UI then falls back to
`GET /runs/:runId` to show the outcome. Rejected: persisting the SSE buffer (the run file
already is the durable record; double-writing it for a rare tab-refresh race isn't worth it).

---

## 9. Cost & token accounting

- **Actuals:** every model call's `usage` (or chars/4 fallback, flagged `estimated`) is recorded
  as a `usage` run event and summed into `result.usageTotal`; storage mirrors the totals into
  the `agent_runs` index columns. `GET /usage` serves per-work, per-kind, per-day rollups; the
  UI shows a lifetime + this-session figure in settings and a per-run figure in provenance view.
- **Cost:** derived at read time as `tokens × costPerMTok` from the current config (never stored
  — prices change; token counts don't). If prices are unset, the UI shows tokens only.
- **Pre-run estimate (edit-task pane):** `POST /tasks/estimate` runs
  `contextEngine.assemble(spec, { dryRun: true })` — full selection, no model call — and returns:

```ts
export const TaskEstimate = z.object({
  promptTokens: z.number().int(),           // Σ ceil(chars/4) over assembled messages
  maxCompletionTokens: z.number().int(),    // Σ target sizes + headroom
  items: z.array(z.object({ label: z.string(), tokens: z.number().int() })), // per context item
  costUsd: z.number().nullable(),           // null when prices unconfigured
  accuracy: z.literal("rough"),             // UI must render with "~"
});
```

The chars/4 heuristic is deliberately crude and labeled as such. *Rejected:* bundling real
tokenizers per model (endpooints are user-chosen and arbitrary; tiktoken is wrong for most
open-weights models anyway, and "rough" is the honest contract the pane was speced for).
Planning-stage tool expansion isn't in the estimate; the estimate covers the initial assembly,
which dominates.

---

## 10. Module layout

```
apps/server/src/agents/
  index.ts                # AgentService: submit/cancel/list, wires lanes ↔ runner ↔ SSE bus
  queue.ts                # Lane scheduler (capacity, dedupe, jump rules), AbortControllers
  runner.ts               # §4.2 two-stage loop; retry/timeout policy; repair turn
  llm/
    client.ts             # LlmClient interface + OpenAI-compatible fetch/SSE impl
    config.ts             # ModelEndpointConfig Zod + ${env:} interpolation
  output/
    tagBlocks.ts          # streaming TagBlockParser (§5.2)
  tasks/                  # one handler per TaskKind: contextRequest, writeCue,
    continue.ts           #   expectedBlocks, commit
    quickEdit.ts
    editTask.ts
    enrichSection.ts
    proposeBoundaries.ts
    illustrateSection.ts  # thin: delegates to illustration pipeline with RunContext
    worldImage.ts
  runsink.ts              # tees RunEvents → storage.recordRun + SSE ring buffer
  estimate.ts             # dry-run estimator (§9)
  routes.ts               # Fastify plugin: table in §8
  sse.ts                  # SSE plumbing: ring buffer, Last-Event-ID replay, heartbeats
prompts/                  # .md templates with {{slots}}; hot-reloaded in dev (tsx watch)
  system.md  continue.md  quick-edit.md  edit-task.md  enrich.md  boundaries.md  repair.md
packages/shared/src/
  agents.ts               # TaskKind, TaskSpec, Task, TaskEvent, RunEvent, TaskEstimate, ErrorCode
packages/mock-llm/        # §12
  src/server.ts  src/scenario.ts  src/comfy.ts  scenarios/*.json
```

---

## 11. Error surfaces

Closed `ErrorCode` enum shared with the UI; every code has a fixed presentation:

| Code | Cause | UI surface |
|---|---|---|
| `config_missing` | lane endpoint unset/invalid | blocking callout on the task control + link to settings; task not enqueued |
| `auth` | 401/403 from endpoint | same callout, "check your API key for the high/low model" |
| `endpoint_unreachable` | DNS/conn refused after retries | toast + retry button (local endpoints flap; make retry one click) |
| `rate_limited` | 429 exhausted retries | toast "endpoint is rate-limiting; retried 3×", retry button |
| `timeout` | first-token/idle/total | toast with which timeout tripped; retry button |
| `output_invalid` | no valid blocks after repair turn | inline card with raw model text (copyable) + retry |
| `busy` | interactive lane occupied | inline "already writing — cancel & restart?" |
| `conflict` | §5.6 guard | proposal card (apply anyway / discard) |
| `pipeline` | ComfyUI/pipeline failure | badge on the section's image slot + detail from pipeline |
| `crash` | server died mid-run (startup finalizer) | provenance view only |
| `internal` | anything else (bug) | toast + run id for the log |

Rules: interactive-task errors are loud (toast/inline, always with a one-click retry that
re-submits the same spec); background-task errors are quiet (staleness badge persists, error
visible in a small activity log popover); nothing ever silently swallows a failed run — the run
file always says why. `retryable: true` on the SSE error event is what enables the retry button.

---

## 12. Mock-server strategy

Everything in this doc must run against `packages/mock-llm` with zero real models
(brief principle 6).

**Design: a scriptable OpenAI-compatible Fastify server + in-process scenario API.** A
*scenario* is an ordered list of steps; each step matches the next incoming
`/v1/chat/completions` request by predicate and answers with scripted behavior:

```ts
export const MockStep = z.object({
  match: z.object({                       // all optional; assert-fail on mismatch
    model: z.string().optional(),
    lastMessageIncludes: z.string().optional(),
    hasTools: z.boolean().optional(),
    stage: z.enum(["planning","writing"]).optional(),   // inferred: tools present ⇒ planning
  }).default({}),
  respond: z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), text: z.string(),
               tokenDelayMs: z.number().default(0), usage: z.boolean().default(true) }),
    z.object({ type: z.literal("toolCalls"),
               calls: z.array(z.object({ name: z.string(), input: z.unknown() })) }),
    z.object({ type: z.literal("error"), status: z.number(), retryAfterMs: z.number().optional() }),
    z.object({ type: z.literal("dieMidStream"), afterChars: z.number() }),
    z.object({ type: z.literal("hang"), forMs: z.number() }),   // exercise timeouts
  ]),
});
```

Usage tiers:

1. **Unit (runner):** `LlmClient` swapped for a pure in-memory fake — no HTTP at all. Covers
   the tag parser (property-tested against split-anywhere chunk boundaries), repair turn, retry
   ladder, abort propagation, commit/conflict logic.
2. **Integration (Vitest):** real Fastify app + mock-llm started in-process on an ephemeral
   port, `cowrite.config.json` pointing high *and* low lanes at it with distinct model names
   (`mock-high` / `mock-low`) so routing is assertable. Golden scenarios ship as fixtures:
   `continue-happy.json`, `continue-with-tools.json` (2 planning rounds), `edit-multi-target`,
   `format-miss-then-repair`, `429-then-ok`, `die-mid-write-keep-partial`, `hang-first-token`,
   `boundary-garbage` (invalid JSON in `<boundaries>` → deferred consolidation). Each test
   drives the real REST+SSE surface and asserts: SSE event sequence, run-file contents (parsed
   against `RunEvent`), storage artifacts, and index rows.
3. **E2E (Playwright) & manual dev:** `pnpm mock:llm` runs the same server standalone on :8081
   with a default "improviser" scenario (echo-ish deterministic prose from a seeded RNG, 20 ms
   token delay) so the whole app is demoable offline. `pnpm mock:comfy` serves the mock ComfyUI:
   accepts a workflow, waits a scripted delay, returns a fixture PNG; fault modes mirror
   mock-llm. Determinism: scenarios are strictly ordered and any unmatched request fails the
   test loudly (no permissive fallthrough — silent mismatch is how mock tests rot).

*Rejected:* recording/replaying real API traffic (VCR-style) — creative-prose responses aren't
stable enough to record once and keep; hand-scripted scenarios are smaller and readable. Nock
per-test HTTP interception — doesn't cover the e2e/manual tier; one mock implementation for all
three tiers keeps behavior identical.

---

## 13. Interface assumptions (cross-check with sibling designs)

1. **Context engine (06)** exposes:
   `assemble(workId, req: ContextRequest, opts?: {dryRun}) → { messages: ChatMessage[], tools:
   ToolDef[], execTool(name, input) → Promise<string>, snapshot: unknown, itemEstimates }`.
   `ContextRequest` lets a task handler declare focus (frontier tail / target section / world
   entry), pinned world entries, and instruction text; the engine owns markup, ordering
   (instructions top, freshest prose bottom), world-info selection, per-tool-result token caps,
   and cross-run decay of expansions. `execTool` is read-only and idempotent (required by the
   planning-retry rule, §6.3). The `snapshot` is JSON-serializable for the run file.
2. **Storage (data-model doc)** provides, in-process:
   `appendSnippet`, `reviseSnippet(id, text, {author, runId, baseRev})` (baseRev check — **new
   requirement** on top of data-model §10), `replaceSectionSpan(span, text, {runId})` (**new**:
   atomic content.md paragraph-span splice + staleness flip), `writeEnrichment(sectionId, part,
   text|png, {runId, sourceHash})`, `recordRun(runId) → append sink`, `readRun(runId)`,
   `queryRunsByArtifact`, usage-rollup queries over `agent_runs`, and `reserveOrderKey()` for
   the pending-snippet overlay position. The reconciler runs before every agent run
   (data-model §8) — the harness calls `storage.reconcile(workId)` at task start.
3. **RunEvent / RunKind unification:** this doc's §7 schema supersedes the draft `RunKind`
   (`draft`,`revise`,…) and `RunEvent` in data-model §10 — run kinds are task kinds, and events
   gain `stage`/`attempt`/`usage`/`spec`/`contextSnapshot`. Same JSONL envelope, same file
   layout, write-once discipline preserved. Needs sign-off from the data-model owner.
4. **Consolidation engine** (data-model §6) calls
   `agents.runBoundaryProposal(eligibleSnippetIds) → BoundaryProposal` and treats Zod-invalid
   output as "defer + grow thresholds". It emits `onSectionsFrozen(sectionIds)` which this
   scheduler subscribes to for enrichment/illustration enqueueing.
5. **Illustration pipeline (08)** exposes `runSectionIllustration(sectionId, ctx: RunContext)`
   and `runWorldImage(entryId, ctx)`, where `RunContext = { lowClient: LlmClient, emit(RunEvent),
   signal: AbortSignal }`; it commits the PNG through storage and returns artifacts. The harness
   owns its queue slot, timeout (default 10 min total), and run record.
6. **API layer (03)** mounts `agents/routes.ts` under `/api`; all schemas come from
   `@cowrite/shared` (Zod v4, consumed as TS source per the stack table). SSE is the streaming
   transport per the brief — no WebSockets.
7. **Frontend (04)** implements: pending overlay for streamed drafts/edits, busy/cancel
   affordance for the interactive lane, conflict & keep-partial proposal cards, error surfaces
   per §11, provenance view fed by `GET /runs/:runId`, and the edit-task pane calling
   `/tasks/estimate` (rendering estimates with "~").
8. **Prompting (07)** owns the wording of `prompts/*.md`, the `<instructions>`/`<selected>`
   markup, and voice-preservation rules; this doc fixes only the *output* tag contract (§5.2)
   and the message-ordering/caching constraints (§4.1).

---

## 14. MVP cut

**Ships first (M1):**
- `continue`, `instructed-continue`, `quick-edit` (snippet targets), `enrich-section`,
  `propose-boundaries`, `illustrate-section`, `world-image`
- Two-lane model routing with config file; two-stage runner with planning tools; tag-block
  output contract + one repair turn; direct-apply commits with revision recording
- Lanes/queue as specced (interactive 1, background 2, illustration 1); cancel; timeouts;
  retry ladder; keep-partial for continue
- Full run persistence + provenance endpoints; token accounting with actuals; `/usage` rollup
- SSE with ring-buffer resume; error taxonomy; mock-llm + mock-comfy with the golden scenarios

**Structured-for, deferred:**
- `edit-task` pane and multi-target commits + `/tasks/estimate` (M2 — the spec, runner path,
  and estimate endpoint are designed above; only the pane and multi-block parser wiring land
  later; quick-edit exercises the same machinery single-target from day one)
- `quick-edit` on frozen-section spans (`replaceSectionSpan`) — M2, ships with edit-task
- Conflict proposal cards (M1 behavior: conflict → error toast with copyable text; card UI in M2)
- Run pruning knob; per-kind routing overrides UI (config-file only in MVP); SSE buffer
  persistence (explicitly rejected for now, §8.2); mixed high/low staged runs (rejected, §3.2)

The cut keeps the M1 surface to the brief's core rhythm — press continue, watch a page stream
in, edit a selection, and let the background quietly name, summarize, and illustrate what you've
finished — with every run auditable and every behavior testable offline.
