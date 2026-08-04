# 05 — Agent Harness & Task Orchestration

Scope: the server-side subsystem that turns a user gesture ("continue", "tighten this paragraph",
background "summarize chapter 3") into an assembled prompt (via the context engine or a
handler-owned assembly), one or more model calls against user-configured OpenAI-compatible
endpoints, live events on the per-work SSE stream, committed artifacts (snippet revisions,
section rewrites, summaries, images) written through `StorageService`, and a permanent,
replayable **agent run** record. This doc owns the task taxonomy and specs, model routing, the
runner loop, the lane scheduler, output contracts and commit semantics, run persistence, error
taxonomy, and the harness side of the mock-server strategy.

## Key decisions

- **One runner, many task kinds** — kinds differ only in spec, routing, prompt assembly, output
  contract, and commit function; no bespoke per-kind loops to maintain.
- **Interactive kinds run inside a context-engine session; background kinds never touch it** —
  the engine's ledger/decay machinery is single-session per work, and enrichment/boundary
  prompts need only a section's neighborhood, so the two must not contend.
- **Planning prose is the composition** — a no-tool-call response is never discarded and
  regenerated; the `tools` array is identical on every request of a run, so the prefix cache
  survives the whole loop.
- **Whole-target rewrites in tag blocks, never search/replace** — prose anchoring is fragile;
  harness-designated targets make application a deterministic splice.
- **Direct apply + revision history, no review modal** — snippets already carry rollback; a
  conflict degrades to a durable proposal reconstructed from the run JSONL, never lost to a
  restart.
- **Interactive lane rejects rather than queues** (`409 busy`) — a queue of stale writing
  intents against a moving frontier is a footgun; cancel-and-restart is one click.
- **One task = one run = one JSONL file** — if a model was called there is a run file; every
  artifact points at the run that made it; provenance needs no joins.
- **Routing by task kind, high model never sees images** — enforced in the client types, not by
  convention.
- **All events ride the per-work `WorkEvent` stream** (03 §SSE) — the harness defines no
  private event vocabulary.
- **One token estimator: the engine's** — `/tasks/estimate` wraps `/context/preview` and adds
  cost math only; chars/4 survives solely as the usage fallback when an endpoint omits `usage`.
- **Test without models** — one scriptable mock OpenAI/ComfyUI implementation serves unit,
  integration, and e2e tiers identically.

---

## 1. Principles

1. **The harness never touches files.** All reads go through the context engine or storage
   queries; all writes go through `StorageService` (02 §StorageService).
2. **Cache-frugal.** Conversations are strictly append-only within a run; the system prompt,
   context regions, and the `tools` array are byte-stable across every request of a run, so
   prefix caches on the user's endpoints hit (07 owns region ordering).
3. **Everything is a run.** No anonymous model output anywhere in the system.
4. **Streams are presentation; commits are truth.** Nothing is written to storage until a task's
   commit step; the SSE stream renders pending state only.
5. **The engine owns planning caps and context budgets**; the harness owns transport (timeouts,
   retries, aborts), output parsing, and commits.

---

## 2. Task taxonomy

`TaskKind` is a closed, kebab-case enum. Each row: who initiates it, what it targets, which
model lane it uses (§3), which queue lane it runs on (§6), how its prompt is assembled, and what
it commits.

| Kind | Initiator | Target | Model | Lane | Assembly | Commits |
|---|---|---|---|---|---|---|
| `continue` | user (button / ctrl-enter) | frontier tail | high | interactive | engine session | 1 new snippet (~a "page": target 300–700 words) |
| `instructed-continue` | user (inline instruction box) | frontier tail | high | interactive | engine session | 1 new snippet |
| `quick-edit` | user (select block → short instruction) | one snippet (M1) or one intra-section span (M2) | high | interactive | engine session | 1 snippet revision **or** 1 section-span replacement |
| `edit-task` (M2) | user (detailed edit pane) | explicit set of snippets / section spans | high | interactive | engine session | n revisions / span replacements |
| `enrich-section` | scheduler (post-consolidation, staleness sweep) or user ("refresh summary") | one frozen section | low | background | handler-owned (§4.4) | section title (unless user-pinned), `summary-short.md`, `summary-long.md` — one run |
| `propose-boundaries` | consolidation scheduler (or `POST /consolidate`) | eligible frontier prefix | low | background | handler-owned (§4.4) | nothing — returns a `BoundaryProposal` to the consolidation engine |
| `illustrate-section` | scheduler (after enrich) or user | one frozen section | low (VLM) + ComfyUI | illustration | pipeline-owned (08) | `illustration.png` + `IllustrationMeta` |
| `world-image` | user (world-entry editor) | one world entry | low + ComfyUI | illustration | pipeline-owned (08) | `world/images/<entryId>.png` + sidecar meta |

Semantics:

- **`continue` vs `instructed-continue`** share a template; the latter's instruction travels in
  the prompt's `<task>` region, never as prose (07 §regions). The situation pane, when
  non-empty, is included in both as instruction-marked context (06 §regions).
- **`quick-edit`** is deliberately thin: a selection plus a one-line instruction. The selection
  rule (validated at `POST /tasks`, `400 validation` on violation): the selection must lie
  entirely within **one snippet** (M1) or **one frozen section** (M2, expanded to enclosing
  paragraph boundaries as a contiguous character span). Selections spanning two snippets, or
  straddling the frontier/frozen boundary, are rejected with a message pointing at edit-task.
- **`edit-task`** is the same runner with a richer spec: multiple targets, pinned world entries,
  explicit per-item context selections (validated against the engine's candidates, 06
  §candidates), a long instruction, and a pre-flight estimate (§9). M2.
- **`enrich-section`** produces title + short + long summary in **one** low-model run (one
  assembly, one cache prefix, three tagged output blocks). When the section's
  `titleSource: "user"`, the prompt instructs the model to omit `<title>` and the parser treats
  it as unexpected — a user title is never overwritten.
- **`propose-boundaries`** is invoked by the consolidation scheduler (02 §consolidation) but
  *executes as* a normal queued run so it is recorded, cancellable, and mockable. Its parsed
  `BoundaryProposal` is returned to the caller; Zod-invalid output means the caller defers with
  its capped back-off (02 §boundaries). The harness commits nothing. Clients cannot submit this
  kind directly; `POST /works/:w/consolidate` is the manual trigger (03 §consolidation).
- **Illustration tasks** are *scheduled and recorded* here, *executed* by the illustration
  pipeline (08): the runner hands it a `RunContext` (§13) and the pipeline drives
  compose → ComfyUI → VLM critique inside it. One run file covers the whole loop; the pipeline
  is **budget-aware** — `RunContext.remainingMs()` exposes the task's remaining time budget, and
  the pipeline commits its best-scored candidate when budget or attempts run out rather than
  discarding a scored winner.

### 2.1 Task spec schemas (`packages/shared/src/tasks.ts`)

```ts
import { z } from "zod";
import { Ulid, Hash } from "./ids";
import { Fidelity } from "./context";          // owned by 06

export const TaskKind = z.enum([
  "continue", "instructed-continue", "quick-edit", "edit-task",
  "enrich-section", "propose-boundaries", "illustrate-section", "world-image",
]);

/** A contiguous character span inside a frozen section, valid against baseContentHash's text.
 *  The harness expands a user selection to enclosing paragraph boundaries before building this. */
export const SectionSpan = z.object({
  sectionId: Ulid,
  startChar: z.number().int().nonnegative(),
  endChar: z.number().int().nonnegative(),     // exclusive
  baseContentHash: Hash,                       // section content.md hash at selection time
});

export const EditTarget = z.discriminatedUnion("type", [
  z.object({ type: z.literal("snippet"), snippetId: Ulid,
             baseRev: z.number().int().positive() }),
  z.object({ type: z.literal("sectionSpan"), span: SectionSpan }),   // commits ship M2
]);

export const ContextSelection = z.object({
  id: Ulid,
  kind: z.enum(["section", "snippet", "world"]),   // bare ULIDs + explicit kind, no id prefixes
  fidelity: Fidelity,
});

export const TaskSpec = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("continue") }),
  z.object({ kind: z.literal("instructed-continue"),
             instruction: z.string().min(1).max(4000) }),
  z.object({
    kind: z.literal("quick-edit"),
    instruction: z.string().min(1).max(500),
    target: EditTarget,
    /** exact selected text + char offsets within the target, for the prompt's selection marker */
    selection: z.object({ text: z.string(),
                          start: z.number().int(), end: z.number().int() }),
  }),
  z.object({
    kind: z.literal("edit-task"),                            // M2
    instruction: z.string().min(1).max(20_000),
    targets: z.array(EditTarget).min(1).max(12),
    pinnedWorldEntryIds: z.array(Ulid).max(20).default([]),
    contextSelections: z.array(ContextSelection).default([]), // validated against 06 candidates
  }),
  z.object({ kind: z.literal("enrich-section"), sectionId: Ulid }),
  z.object({ kind: z.literal("propose-boundaries"),
             eligibleSnippetIds: z.array(Ulid).min(1) }),     // internal-only kind
  z.object({ kind: z.literal("illustrate-section"), sectionId: Ulid,
             guidance: z.string().max(500).optional() }),     // regenerate-with-guidance (08)
  z.object({ kind: z.literal("world-image"), entryId: Ulid,
             guidance: z.string().max(500).optional() }),
]);
export type TaskSpec = z.infer<typeof TaskSpec>;

export const TaskStatus = z.enum(["queued", "running", "done", "error", "cancelled"]);
export const QueueLane = z.enum(["interactive", "background", "illustration"]);

export const Task = z.object({
  id: Ulid,                    // taskId == runId once started (1 task : 1 run)
  workId: Ulid,
  spec: TaskSpec,
  lane: QueueLane,
  status: TaskStatus,
  queuedAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  endedAt: z.string().datetime().nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
});
```

`baseRev` / `baseContentHash` exist for the concurrent-edit guard (§5.6). Span offsets are
character-based because that is `replaceSectionSpan`'s contract (02 §concurrency); the prompt
still presents the span with paragraph markers for the model's benefit.

---

## 3. Model routing

Two model lanes, both plain OpenAI-compatible `/v1/chat/completions` with streaming. Endpoint,
key, model name, and sampler defaults live in `~/.cowrite/config.jsonc` under `models.high` /
`models.low` (`ModelEndpoint`, 03 §config); per-kind routing overrides live under `routing`
(`z.partialRecord(TaskKind, z.enum(["high","low"]))`). Nothing model-related is tunable in the
UI beyond the settings screen's endpoint cards — sampler knobs are config-file only.

### 3.1 Routing rules (hard invariants)

- The **high** model never receives image content — enforced by type: the high `LlmClient`'s
  message schema has no image parts. The **low** client is the only one that accepts
  `image_url` content parts (illustration VLM critique, 08 §critique).
- Routing is by `TaskKind` via the table in §2, overridable per kind in config (e.g. flip
  `propose-boundaries` to `"high"` if the low model chops chapters badly). There is no
  per-request routing logic ("use low if the prompt is short") — fiddly and cache-hostile.
- All model calls within one run use the **same** lane — mixed-lane runs would mean two prefix
  caches and double config surface for negligible savings.
- The runner captures a config snapshot at task start; a `PUT /api/config` mid-run never
  switches an in-flight task's endpoint (03 §live-reload).
- Unconfigured lane ⇒ `409 config_missing` at task creation; the task is never enqueued. Works
  stay **fully editable** with zero endpoints configured — only task controls surface the
  callout; nothing gates the editor on model config.

### 3.2 `LlmClient` interface

```ts
export interface LlmClient {
  lane: "high" | "low";
  chat(req: {
    messages: ChatMessage[];        // append-only across the run; low lane may carry image parts
    tools?: ToolDef[];              // OpenAI function-tool JSON schemas — identical every call
    toolChoice?: "auto" | "none";   // decoding-side only; never changes rendered prompt bytes
    maxOutputTokens?: number;       // per-call override (handlers may raise the lane default)
    signal: AbortSignal;
  }): AsyncIterable<LlmStreamEvent>;   // {type:"delta",text} | {type:"toolCall",...}
                                       // | {type:"usage", promptTokens, completionTokens}
}
```

Implementation is a thin `fetch` + SSE parser (~200 lines, no SDK dependency — the OpenAI SDK
drags in retry/timeout policy we want to own). `stream_options: {"include_usage": true}` is
requested; when an endpoint omits usage we fall back to a chars/4 estimate and mark the usage
event `estimated: true`. There are exactly two implementations: real HTTP and the scriptable
mock (§12).

---

## 4. The agent loop

One runner. Interactive kinds (`continue`, `instructed-continue`, `quick-edit`, `edit-task`)
run inside a context-engine session; background kinds (`enrich-section`, `propose-boundaries`)
use a stateless handler-owned assembly; illustration kinds delegate to the pipeline (§13).

### 4.1 Conversation shape (interactive kinds)

```
[system]    stable per-work system prompt (voice rules, markup + output contract)  ← cache-stable
[user]      engine-assembled context: instructions at top, world info, skeleton,
            anchors, expanded items, situation, task, freshest prose at bottom
            (region ordering owned by 07; assembly by 06)                          ← stable-ish
[assistant] tool calls          ┐
[tool]      tool results        │  0..N planning rounds, append-only;
[assistant] tool calls          │  caps owned by the engine (06 §tools)
[tool]      tool results        ┘
[user]      <local-context-refresh> turn (engine-produced; only if tools were used)
[assistant] final output (streamed)
```

Two rules make this loop cheap:

1. **The `tools` array is identical on every request of the run.** Most OpenAI-compatible
   servers render tool definitions into the prompt via the chat template, so dropping `tools`
   for a "writing call" would re-render the prompt and miss the prefix cache from byte 0 on the
   most expensive call of every task. The composition call instead sets `tool_choice: "none"`
   (decoding-side, prompt bytes unchanged) and the refresh turn says "no tool calls now" as
   belt-and-braces. A golden-prefix integration test asserts byte-identical request prefixes
   between planning round N and the composition call (§12).
2. **A no-tool-call response is the composition.** The system prompt (07) tells the model
   "if you already have what you need, just start writing," and the output-format contract
   (which tag blocks to emit, §5.2) is part of the *initial* prompt — there is no stage-2 cue
   whose absence would orphan early prose. Whatever prose the model streams in a tool-free
   response is fed through the `TagBlockParser` and, if it contains the expected block(s),
   committed. Nothing the user watched stream in is ever discarded and re-paid for.

Tool results are injected the standard OpenAI way — an `assistant` message carrying
`tool_calls`, then one `tool` message per call with the engine's rendered result (engine-capped
at **4,096 tokens per result**, 06 §tools). Earlier messages are never rewritten; decay of
expanded items back to summaries applies *across* runs at engine finalize, never within one.

### 4.2 Runner pseudocode (interactive kinds)

```
run(task):
  runId = task.id
  sink  = RunSink(runId)                      # tees RunEvents → run JSONL + EventBus (§7, §8)
  client = llmFor(routing[task.spec.kind])
  handler = handlers[task.spec.kind]          # output contract + commit fn
  orderKey = storage.reserveOrderKey()  if kind is continue-like   # 02 §ordering
  storage.reconcile()                                              # pre-run, 02 §reconciler

  session = engine.beginTask(task.spec)       # 06 §session; lane cap 1 + background bypass
                                              #   guarantee no SessionBusyError in practice
  try:
    { messages, tools, snapshot } = session.assembleInitialPrompt()
    sink.meta(kind, lane, model, spec, contextSnapshot = snapshot)   # §7.1
    parser = TagBlockParser(handler.expectedBlocks(spec))            # §5.2

    loop:                                     # planning caps enforced by the engine
      resp = stream client.chat({ messages, tools, signal })
        # deltas are fed to the parser opportunistically; the parser withholds
        # everything until an expected opening tag, so tool-call responses leak nothing
      if resp has toolCalls:
        if finish_planning among them:
          session.handleToolCall(it)          # engine records `cite`
          refresh = session.compositionRefreshTurn()      # append-only turn, 06 §refresh
          messages += [assistant(resp), tool(ack), user(refresh)]
          resp = stream client.chat({ messages, tools, toolChoice: "none", signal })
          feed resp through parser; break     # sink.stage("writing")
        for tc in resp.toolCalls:
          out = await session.handleToolCall(tc)          # engine enforces budgets/caps
          sink.toolCall(tc, out); messages += [assistant(tc), tool(out)]
        # engine signals "planning cap reached" ⇒ same path as finish_planning
      else:
        break                                 # prose with no tool calls IS the composition

    blocks = parser.finish()
    if blocks invalid and repairAttempts < 1:             # one cheap repair turn (§5.5)
      messages += [assistant(rawOutput), user(REPAIR_CUE)]
      re-run the composition call once (same tools, toolChoice "none")
    artifacts = await handler.commit(blocks, spec)        # storage writes, atomic per target
    await session.finalize("completed")       # citations → ledger, decay, evict, persist (06)
    sink.result("ok", usageTotal, artifacts)
  catch (error | cancel):
    session.abort()                           # no ledger side effects (06)
    sink.result(...)                          # "error" with code, or "cancelled"
    rethrow to the lane scheduler
```

The engine is the single owner of planning caps (max rounds, max tool calls — 06 §tools); the
runner has no round counter of its own. The common case for `continue` near a warm frontier is
zero planning rounds: one call, prose streams, commit.

### 4.3 Streaming to the UI

Composition deltas are published as `task.delta` events (with `target` = `"frontier"` or the
target's ULID) as they clear the tag parser. The frontier pending overlay renders them
token-by-token; targeted-edit targets show a "being rewritten" shimmer and swap atomically at
commit — the wire shape already carries `target`, so inline edit streaming can land later
without an event change (03 §events, 04 §pending state). Planning activity streams as
`task.tool` events ("opened Chapter 7 summary…") so long plans don't look like a hang.
`task.stage` flips `planning → writing` when the first expected block opens or the refresh turn
is issued.

### 4.4 Background assembly (`enrich-section`, `propose-boundaries`)

Background kinds never open an engine session — the ledger, decay, and anchors are untouched by
background work. Their handlers own a simple, stateless assembly from storage reads, one call,
no tools:

- **`enrich-section`**: the section's `content.md`, the short summaries of up to two preceding
  sibling sections (continuity for "previously on"), and the matched world entries for the
  section text (`storage.matchWorldEntries`, capped at 8 entries at name+summary fidelity).
  Using keys to pick these entries is a deliberate, scoped exception to the brief's rule that
  keys are not used for choosing what context to send to the model: it covers only low-model
  background chores (enrichment, illustration), never the high-model writing path, where the
  context engine owns inclusion.
  Output blocks: `<title>` (omitted when user-pinned), `<summary-short>`, `<summary-long>`.
  Handler raises `maxOutputTokens` to **2,048** — three blocks under the low lane's 1,024
  default is truncation bait, and a truncated block would trigger the repair turn and double
  the cost the single-run design saves.
- **`propose-boundaries`**: the eligible prefix's snippet texts (with snippet ids marked) plus
  the short summaries of the last two frozen sections (02 §boundaries). Output: one
  `<boundaries>` block containing `BoundaryProposal` JSON.

Both templates live in `prompts/` with wording owned by 07; both runs are recorded with
`contextSnapshot: null` in their `meta` event (no engine assembly to snapshot).

---

## 5. Edits: application model and output contract

### 5.1 Direct apply + revision history (no propose-then-apply)

**Apply on completion, immediately, with the revision recorded; undo = revert to the previous
revision.** The data model already gives every snippet full-text revision events with one-click
rollback, and gives sections cheap atomic rewrites with derived staleness. A separate
proposal/diff-review state would duplicate that safety net, add a second persistence shape, and
put a modal between the user and the text. The streamed pending overlay *is* the preview; when
the stream finishes the text settles and a toast offers Undo.

*Rejected:* propose-then-apply with diff review (right for code, wrong for prose — the user
reads the result, not the diff); apply-per-paragraph while streaming (partial edits visible on
failure; violates all-or-nothing per target).

One exception: when the concurrent-edit guard trips (§5.6), the completed rewrite becomes a
**proposal** instead of committing — a conflict fallback, not a review workflow. Proposals are
durable by construction: they are reconstructed on demand from the run JSONL via
`POST /works/:w/tasks/:t/proposal/apply|discard` (03 §tasks), with no TTL; any in-memory copy
is only a cache. Apply commits server-side with `authorship: "agent"` + `originRunId`, and the
resolution is appended to the run file so apply/discard is idempotent.

### 5.2 Output contract: whole-target rewrite in tag blocks

Every composition output is one or more **tag blocks**; each block is the *complete replacement
text for a harness-designated target*:

```
<snippet id="new">…full prose of the new snippet…</snippet>                    # continue tasks
<snippet id="01J2P7R9GT5W0ZNXK3M8QAB4CD">…full rewritten snippet…</snippet>    # snippet edits
<span section="01J2KF…" from="1180" to="2440">…full rewritten span…</span>     # section spans
<title>…</title> <summary-short>…</summary-short> <summary-long>…</summary-long>  # enrich
<boundaries>{"boundaries":[{"afterSnippetId":"01J2…","kind":"chapter","title":"…"}]}</boundaries>
```

(The canonical tag grammar is 07's; the harness owns which blocks each kind *expects* and how
they map to commits.)

`TagBlockParser` is a small streaming extractor: it withholds output until the opening tag of
an expected block, streams the interior as deltas, tolerates and discards chatter outside
blocks ("Here's the revised passage:" preambles cost nothing — and planning-path preambles are
common by design, §4.1), and validates on close: every emitted block id/span must match a
declared target; unknown ids are dropped with a warning event; missing mandatory blocks trigger
the repair turn.

**Why whole-target rewrite beats search/replace for prose.** Search/replace relies on the model
reproducing original text *exactly* to anchor the edit. Creative prose is pathological for
this: repeated phrases and refrains make anchors ambiguous; models silently normalize curly
quotes, em-dashes, and ellipses so anchors miss; paragraph-length matches inflate output tokens
to no benefit; and a missed anchor either fails the edit or lands it in the wrong scene. With
whole-target rewrite the *harness* picks the boundaries (snippet id, character span) from
ground truth, so application is a trivial, always-correct splice and validation is "did a block
with this id arrive." Targets are small by construction (snippets are 100–2,000 words; spans
are selection-sized), so the token overhead over minimal diffs is modest and buys determinism.
*Rejected:* search/replace blocks (anchoring fragility); unified diffs (same problem plus
line-orientation that fights reflowed prose); JSON mode for final prose (escaped prose is
token-bloated, kills streaming readability, and `json_schema` support is inconsistent across
OpenAI-compatible endpoints — tags are the lowest common denominator).

### 5.3 Continue tasks

Commit = `storage.appendSnippet(text, { author: "agent", runId, orderKey })` using the key
reserved at task start (02 §ordering: a user append mid-run generates its key *after* the
reservation, so ordering is deterministic; the harness additionally emits a soft notice —
"you added text while it was writing" — since the agent composed without seeing the user's
mid-run snippet). The write instructions pin length ("one page: 300–700 words, end at a natural
beat") and the single `<snippet id="new">` block. Multiple snippets per continue are rejected
for MVP — one page per press keeps the turn-taking rhythm.

### 5.4 Edit tasks (quick-edit, edit-task)

- **Snippet target** → expect `<snippet id=…>`; commit via
  `storage.reviseSnippet(id, text, { author: "agent", runId, baseRev })`.
- **Section-span target** (M2) → expect `<span section=… from=… to=…>` matching the spec's
  span; commit via `storage.replaceSectionSpan(sectionId, {startChar, endChar}, text,
  { runId, baseHash })` — an atomic `content.md` splice that flips summary staleness by the
  data model's rules. The prompt presents the span with numbered paragraph markers and the
  user's selection marked inside it (07 owns the marker tags).
- Multi-target `edit-task` commits apply target-by-target, each atomic; a block that fails
  validation skips only its target and is reported in the result artifact list as `skipped`.
  All-or-nothing across targets was rejected: one bad block shouldn't discard eleven good
  rewrites the user watched stream in.

### 5.5 Output repair

If the composition ends with a mandatory block missing or unclosed, the harness appends the raw
output as an assistant message plus a terse corrective user message ("Your reply contained no
`<snippet>` block. Reply with only the required block(s), no commentary.") and re-runs the
composition call **once** (same `tools`, `toolChoice: "none"`). Second failure → run fails with
`output_invalid`; the raw text is preserved in the run file and offered as copyable text in the
error surface. The mock server exercises this path explicitly.

### 5.6 Concurrent-edit guard

Edit specs carry `baseRev` (snippets) / `baseContentHash` (sections) captured at task creation.
At commit time the storage call re-checks and returns a typed `conflict` result (02
§concurrency) when the target changed — **or was consolidated away** — while the run was in
flight. The run then ends `status: "ok"` with artifact `state: "conflict"`, and the UI offers
the completed rewrite via the proposal routes ("text changed while editing — apply anyway /
discard"; apply-anyway commits a normal revision on top). Two scheduler rules keep this rare:

- The consolidation engine's eligible prefix excludes any snippet that is the target of a
  queued or running task — the harness supplies live target ids to
  `storage.maybeConsolidate({ taskTargetIds })` (02 §trigger) — and any snippet flagged
  editor-open via `POST /works/:w/editing` (03 §editing signal).
- Continue tasks have no guard: append-only, with the reserved order key fixing position.

---

## 6. Execution model: lanes, scheduling, cancellation, timeouts

### 6.1 Lanes

Queue state is in-process and in-memory (*not* persisted; on restart, queued tasks are gone —
cheap to re-issue, and background work re-derives from staleness, §6.5). The `interactive` and
`background` lanes live in a **per-work scheduler**; `illustration` is a **single app-level
queue** that per-work schedulers submit into (ComfyUI is one box).

| Lane | Capacity | Members | Policy |
|---|---|---|---|
| `interactive` | **1** per work | continue, instructed-continue, quick-edit, edit-task | A second interactive submit while one runs → **409 `busy`** with `{runningTaskId}`; the UI offers "cancel current & start". No queueing of writing tasks — a queue of stale writing intents against a moved frontier is worse than a one-click restart. |
| `background` | **2** per work | enrich-section, propose-boundaries | FIFO; `propose-boundaries` jumps the queue (consolidation is waiting on it). Deduped by `(kind, targetId)` — enqueueing an enrich for an already-queued section is a no-op. |
| `illustration` | **1** app-wide | illustrate-section, world-image | FIFO across works; user-initiated jumps ahead of scheduler-initiated. |

Lane capacities are **policy, not configuration**: they live in the shared
`QUEUE_LANE_CAPACITY` constant (consumed by `harness/queue.ts` and `service.ts`), never under
`config.harness` — §6.4 stays timeouts/retries/spend only.

Interactive and background lanes run concurrently — they hit different endpoints (high vs low),
background work never touches the engine session (§4.4), and storage writes serialize on the
per-work mutex (02 §atomicity). One carve-out: while a consolidation apply is in flight,
interactive commits wait on the storage journal (milliseconds), never the reverse.

### 6.2 Scheduler triggers

All presence conditions are server-observable — SSE subscription is the proxy for "app open";
no browser-focus signal exists anywhere in the design.

- **Consolidation applied** (storage `onChange` → `consolidation.applied`): enqueue
  `enrich-section` for each new section — **routed through the same per-window sweep budget**
  as everything else (one spend bound); a batch larger than the remaining budget is drained by
  later sweeps, because missing summaries count as stale (02 §staleness). Enqueueing
  `illustrate-section` after a successful enrich is **Stage 5** (docs/10) — not wired in M1.
- **Staleness sweep**: when the interactive lane has been empty **60 s** and the work has ≥ 1
  SSE subscriber, enqueue refreshes for stale summaries (storage's `staleSections('summary')`
  query) — where *missing* on a frozen leaf section counts as stale (02 §staleness) — capped at
  **4 per sweep window** to bound surprise API spend. **Illustration staleness is deliberately
  skipped until Stage 5** lands the `illustrate-section` pipeline (sweeping it now would
  enqueue a kind with no handler). A **failed enrich arms a per-section cooldown**: exponential
  not-before (base = one sweep window, doubling per consecutive failure, capped ~1 h), reset on
  section content change or a later success — a persistently failing endpoint cannot spin the
  sweep into a spend loop.
- **`enrichment_wanted`** (engine's in-process channel, 03 §in-process channels): the model
  expanded an un-enriched section mid-task; the scheduler enqueues an enrich under the same
  sweep cap (and the same failure cooldown).
- **Consolidation undo**: the scheduler exposes `cancelByTarget(sectionIds)`; undo cancels
  queued/running enrich/illustrate tasks for the un-frozen sections *before* directories are
  touched (02 §undo).
- **Work close** (03 §lifecycle): stop accepting tasks, cancel interactive + illustration,
  **skip the boundary agent** (the next open consolidates), let journal steps finish.
  Correctness never depends on a clean close.

### 6.3 Cancellation

`POST /api/works/:w/tasks/:t/cancel` → resolves the task's `AbortController` → the in-flight
fetch aborts, the engine session gets `abort()`, the run file gets
`result: {status:"cancelled"}`, and `task.cancelled` (with any partial composition text) goes
out on the work stream. Closing the SSE connection does **not** cancel — a refreshed tab must
be able to reattach (03 §resume). Queued tasks cancel by removal.

### 6.4 Timeouts and retries (defaults; all under `config.harness`)

| Knob | Default | Applies to |
|---|---|---|
| `connectTimeoutMs` | 15 000 | TCP/TLS + request write |
| `firstTokenTimeoutMs` | 60 000 | request sent → first stream event |
| `idleTokenTimeoutMs` | 30 000 | gap between stream events |
| `totalTimeoutMs.high` | 300 000 | whole model call (high lane) |
| `totalTimeoutMs.low` | 120 000 | whole model call (low lane) |
| `illustrationBudgetMs` | 600 000 | whole illustration run (pipeline reads it via `remainingMs()`) |
| `retry.maxAttempts` | 3 | per model call (1 initial + 2 retries) |
| `retry.backoffMs` | 1 000 → 4 000 (+ full jitter) | between attempts; honor `Retry-After` on 429 |
| `spendWarnUsd` | 5 (null disables) | per-process cumulative derived spend (§9); crossing it emits a one-time `spend.warning` event + console notice |
| `spendStopUsd` | null (disabled) | crossing it makes NEW task submissions fail `409 spend_stop` until restart or a knob change |

Retryable: network errors, 408/429/5xx, first-token timeout, and mid-stream death during
planning (no user-visible text lost — replay the call; the engine's `handleToolCall` is
read-only and idempotent, so already-obtained tool results are kept). Non-retryable: 400/401/403
(`config`/`auth`), `output_invalid` after repair, abort, total timeout.

### 6.5 Partial failure: stream dies mid-composition

If the composition stream dies, the harness retries the composition call (same messages) up to
the attempt budget — the pending overlay resets, shown as `task.retrying`. If all attempts
fail:

- **Continue tasks:** nothing was committed. The run ends `error`; `task.failed` carries
  `partialText` (the longest partial from any attempt). The UI offers **Keep partial as
  draft** via `POST …/proposal/apply` — reconstructed from the run JSONL, so it survives
  restarts and lunch breaks, and the commit carries agent provenance (`originRunId`). Losing
  three good paragraphs to a router hiccup is the #1 rage moment in this category of app; this
  affordance removes it durably.
- **Edit tasks:** strictly all-or-nothing per target; partial rewrites are never offered (a
  half-rewritten paragraph is worse than none). The partial text still lives in the run file.
- **Enrichment/boundary:** fail quietly to the activity log; staleness persists and the sweep
  retries later (boundary deferral back-off is the consolidation engine's, 02 §boundaries).
- **Illustration:** the pipeline records which attempt failed and commits the best-scored
  candidate so far if one exists (08 §loop); the section otherwise keeps its previous image
  (replacement is atomic overwrite at commit only).

Restart recovery: interrupted run files are finalized as `crash` at the next work open (02
§runs); queued tasks are not resurrected — background work re-derives from staleness
(missing-counts-as-stale closes the orphan window), and the client recovers interactive
state via `resync` + `GET /runs/:r` + the proposal routes (03 §restart recovery).

---

## 7. Run persistence & retention

One task = one run = one JSONL file at `runs/<YYYY-MM>/<runId>.jsonl`, written through
`storage.recordRun(runId)`'s append sink (02 §runs). Schemas live in
`packages/shared/src/runs.ts`, owned here.

### 7.1 Schemas

```ts
import { TaskKind, TaskSpec } from "./tasks";
import { Fidelity } from "./context";

/** Produced by the engine at assembleInitialPrompt (06); null for background/illustration
 *  runs, which have no engine assembly. Feeds the provenance region view and usage rollups. */
export const ContextSnapshot = z.object({
  regions: z.array(z.object({ name: z.string(), tokens: z.number().int() })),
  items: z.array(z.object({
    id: Ulid,
    kind: z.enum(["section", "snippet", "world", "situation", "anchor"]),
    fidelity: Fidelity,
    tokens: z.number().int(),
    source: z.enum(["default", "tool", "cite", "user", "target"]),
  })),
});

export const RunArtifact = z.object({
  kind: z.enum(["snippet", "snippet-revision", "section-span", "section-title",
                "summary-short", "summary-long", "illustration", "world-image", "boundary"]),
  snippetId: Ulid.optional(), sectionId: Ulid.optional(), entryId: Ulid.optional(),
  rev: z.number().int().optional(),
  state: z.enum(["committed", "conflict", "skipped"]).default("committed"),
});

export const RunEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("meta"), runId: Ulid, kind: TaskKind,
             lane: z.enum(["high", "low"]),          // model lane — the cost-split index column
             model: z.string(), spec: TaskSpec,
             params: z.record(z.string(), z.unknown()),
             contextSnapshot: ContextSnapshot.nullable(),
             startedAt: IsoTime }),
  z.object({ type: z.literal("message"), role: z.enum(["system","user","assistant","tool"]),
             text: z.string() }),
  z.object({ type: z.literal("stage"), stage: z.enum(["planning","writing"]),
             round: z.number().int() }),
  z.object({ type: z.literal("toolCall"), name: z.string(), input: z.unknown(),
             output: z.string(), durationMs: z.number() }),
  z.object({ type: z.literal("output"), text: z.string() }),   // flushed ≥ every 2 s / 2 KB
  z.object({ type: z.literal("attempt"), n: z.number().int(), reason: z.string() }),
  z.object({ type: z.literal("usage"), promptTokens: z.number().int(),
             completionTokens: z.number().int(), estimated: z.boolean().default(false),
             call: z.enum(["planning", "writing", "pipeline"]) }),
  z.object({ type: z.literal("proposal"),                       // appended by apply/discard
             resolution: z.enum(["applied", "discarded"]), at: IsoTime }),
  z.object({ type: z.literal("result"), status: z.enum(["ok","error","cancelled"]),
             error: z.object({ code: z.string(), message: z.string() }).optional(),
             usageTotal: z.object({ promptTokens: z.number().int(),
                                    completionTokens: z.number().int() }),
             partialText: z.string().nullable().default(null),
             artifacts: z.array(RunArtifact), endedAt: IsoTime }),
]);

export const RunSummary = z.object({                            // list endpoints; no transcript
  runId: Ulid, kind: TaskKind, lane: z.enum(["high","low"]), model: z.string(),
  status: z.enum(["ok","error","cancelled"]), startedAt: IsoTime, endedAt: IsoTime.nullable(),
  usageTotal: z.object({ promptTokens: z.number().int(), completionTokens: z.number().int() }),
});
```

This is exactly what the provenance UI needs: **GET a run → replay meta (spec + context
snapshot) → messages → tool calls → output → artifacts** renders "the prompt/process that gave
rise to this version" with zero joins beyond `run_artifacts` (02 §index ingests only the `meta`
and `result` lines). Composition deltas are buffered and flushed as consolidated `output`
events (≥ every 2 s or 2 KB) so run files stay one-line-per-meaningful-event.

### 7.2 Retention (with honest numbers)

Run files are permanent by default and are *not* collapsed at consolidation — deliberately:
consolidation discards intermediate snippet texts but keeps every `runId` in `history.jsonl`,
and those ids must keep resolving for provenance on frozen prose. **Size honesty:** each run
persists its fully assembled prompt (~30k tokens ≈ 120+ KB of message text) plus the snapshot;
a 300k-word novel written a page at a time is 600–1,000 runs, on the order of **100+ MB of run
files per work**. The brief accepts duplication, and this is cold storage on the user's disk —
but the number is stated so the default is chosen with eyes open. The
`retention.pruneRunsAfterMonths` knob (default **off**; M2) deletes run files whose ids no
longer appear in any `history.jsonl`, revision log, or enrichment metadata.

---

## 8. API surface and events

Routes are registered by the API layer (03 §tasks/runs); the harness implements the handlers.
Recap of the harness-owned surface:

| Method & path | Purpose | Notes |
|---|---|---|
| `POST /api/works/:w/tasks` | enqueue; body = `TaskSpec` | `202 Task`; `409 busy` (interactive), `409 config_missing`, `400 validation` (quick-edit selection rule). `propose-boundaries` not client-submittable. |
| `GET /api/works/:w/tasks` · `GET …/tasks/:t` | queue + running + last 50 terminal | in-memory; empty/404 after restart by design — recovery reads runs |
| `POST /api/works/:w/tasks/:t/cancel` | cancel queued/running | idempotent |
| `POST /api/works/:w/tasks/estimate` | pre-flight estimate for the edit-task pane | **M2**; wraps `POST /context/preview`, adds cost math (§9) |
| `POST /api/works/:w/tasks/:t/proposal/apply` · `…/discard` | keep-partial & conflict resolution | reconstructed from run JSONL; durable, idempotent (§5.1, §6.5) |
| `POST /api/works/:w/consolidate` | manual consolidation trigger | enqueues internal `propose-boundaries` |
| `GET /api/works/:w/runs/:r` | parsed `RunEvent[]` | provenance timeline + region view |
| `GET /api/works/:w/runs?artifact=<kind>:<id>` | runs touching an artifact | via `run_artifacts` index |
| `GET /api/works/:w/usage?since=…` | token/cost rollups | M2 (per-run figures ship M1) |

**Events.** The harness publishes exclusively through the canonical `WorkEvent` union
(`packages/shared/src/events.ts`, presented in 03 §SSE): `task.queued`, `task.started` (carries
the **queue lane** and target, so the client can route interactive vs background state),
`task.stage`, `task.tool`, `task.delta` (throttled ≤ 30/s, always with `target`),
`task.retrying`, `task.progress` (illustration phases, 08's enum), `task.artifact`,
`task.usage`, `task.completed`, `task.cancelled`, `task.failed`. Reconnect resume, per-target
`task.snapshot` synthesis (the bus accumulates streamed text per target), and resync are the
bus's job (03 §resume) — the harness just publishes.

---

## 9. Cost & token accounting

- **Actuals:** every model call's `usage` (or the chars/4 fallback, flagged `estimated`) is
  recorded as a `usage` run event and summed into `result.usageTotal`; storage mirrors the
  totals into `agent_runs` index columns (`lane`, `prompt_tokens`, `completion_tokens`).
  `GET /usage` (M2) serves per-work, per-kind, per-day rollups; per-run figures show in the
  provenance view from M1.
- **Cost:** derived at read time as `tokens × costPerMTok` from current config (never stored —
  prices change, token counts don't). Unset prices ⇒ the UI shows tokens only.
- **Pre-run estimate (edit-task pane, M2):** `POST /tasks/estimate` calls the engine's
  `POST /context/preview` with the spec's selections and targets — the engine's estimator is
  the **only** tokenizer in the system (06 §estimation; the web renders server-computed
  numbers) — and adds output headroom and cost:

```ts
export const TaskEstimate = z.object({
  promptTokens: z.number().int(),            // engine preview total
  perRegion: z.record(z.string(), z.number().int()),
  maxCompletionTokens: z.number().int(),     // Σ target sizes + headroom
  overSoft: z.boolean(), overHard: z.boolean(),
  costUsd: z.number().nullable(),            // null when prices unconfigured
});
```

Estimates are ±10 % by the engine's own contract; the UI renders them with "~".
Planning-stage tool expansion isn't estimable pre-run; the initial assembly dominates.

---

## 10. Module layout

```
apps/server/src/harness/
  service.ts              # AgentHarness: submit/cancel/list, spend guard, wires lanes ↔ runner ↔ bus
  queue.ts                # per-work lanes (interactive/background) + app-level illustration queue,
                          #   dedupe & jump rules, AbortControllers (capacities: QUEUE_LANE_CAPACITY)
  runner.ts               # §4.2 loop; session lifecycle; retry/timeout policy; repair turn
  tasks.ts                # per-kind task plans: expectedBlocks, targets, commit paths
  proposals.ts            # reconstruct-from-run-JSONL apply/discard (§5.1); run-file listing
  routes.ts               # Fastify plugin for §8 (registered by 03)
  mockLlm.ts              # COWRITE_MOCK_LLM overlay: point both lanes at @cowrite/mock-llm (09 §2.3)
apps/server/src/models/
  client.ts               # LlmClient interface + OpenAI-compatible fetch/SSE impl
  lanes.ts                # buildClients (high/low from config), resolveHarnessKnobs
  usage.ts                # normalizeUsage, chars/4 estimate, derived cost (§9)
apps/server/src/prompt/
  tags.ts  regions.ts     # tag grammar + region/item renderers (07 owns wording)
  renderer.ts             # template-backed PromptRenderer (the engine's `renderer` dep)
  outputParser.ts         # streaming tag-block parser (§5.2)
  imagePrompt.ts          # Stage-5 constants + compose-only regions (08)
  templates/              # .md templates with {{slots}}; wording owned by 07; loader.ts hashes
    loader.ts  system.md  #   the set into meta.params.promptsHash
    continue.md  quick-edit.md            # <instructions> bodies (interactive kinds)
    continue-task.md  quick-edit-task.md  # <task> regions, split per kind
    instructed-continue-task.md
    enrich.md  boundaries.md  refresh.md  repair.md   # edit-task templates land with M2
packages/shared/src/
  task-kind.ts            # the TaskKind enum leaf (breaks the tasks ⇄ context import cycle)
  tasks.ts                # TaskSpec, EditTarget, SectionSpan, Task, TaskEstimate; re-exports TaskKind
  runs.ts                 # RunEvent, RunArtifact, RunSummary, ContextSnapshot
packages/mock-llm/        # §12; shared with 09
  src/server.ts  src/scenario.ts  src/comfy.ts  src/base.ts  src/png.ts
  src/standalone.ts  src/index.ts  src/testUtil.ts
```

Model endpoint config, `${env:}` interpolation, and hot-reload live in the API layer's
`ConfigService` (03 §config); the harness consumes a config snapshot per task.

---

## 11. Error surfaces

`ErrorCode` is the closed enum in `packages/shared/src/api.ts` (03 §errors); the same codes
appear in HTTP error envelopes and in `task.failed` events. Harness-relevant rows and their
fixed presentations:

| Code | Cause | UI surface |
|---|---|---|
| `config_missing` | lane endpoint unset/invalid (or routed ComfyUI workflow failed registry validation) | blocking callout on the task control + link to settings; task not enqueued |
| `auth` | 401/403 from endpoint | same callout: "check your API key for the high/low model" |
| `endpoint_unreachable` | DNS/conn refused after retries | toast + one-click retry (local endpoints flap) |
| `rate_limited` | 429 exhausted retries | toast "endpoint is rate-limiting; retried 3×" + retry |
| `timeout` | first-token/idle/total | toast naming which timeout tripped + retry |
| `output_invalid` | no valid blocks after repair turn | inline card with raw model text (copyable) + retry |
| `busy` | interactive lane occupied | inline "already writing — cancel & restart?" |
| `conflict` | §5.6 guard (edited or consolidated under the run) | proposal apply/discard (toast + actions M1; card polish M2) |
| `pipeline` | ComfyUI/pipeline failure | badge on the section's image slot + detail from 08 |
| `crash` | server died mid-run (startup finalizer) | provenance view only |
| `internal` | anything else (bug) | toast + run id for the log |

Rules: interactive-task errors are loud (toast/inline, always with a one-click retry that
re-submits the same spec); background-task errors are quiet (staleness badge persists; detail
in an activity-log popover); nothing silently swallows a failed run — the run file always says
why. `retryable: true` on `task.failed` is what enables the retry button.

---

## 12. Mock-server strategy

Every behavior in this doc must run against `packages/mock-llm` with zero real models. (09 owns
the full test plan; the mock's design lives here because its fidelity requirements come from
the runner.)

**A scriptable OpenAI-compatible Fastify server + in-process scenario API.** A *scenario* is an
ordered list of steps; each step matches the next `/v1/chat/completions` request by predicate
and answers with scripted behavior:

```ts
export const MockStep = z.object({
  match: z.object({                       // all optional; assert-fail on mismatch
    model: z.string().optional(),
    lastMessageIncludes: z.string().optional(),
    hasTools: z.boolean().optional(),
    toolChoice: z.enum(["auto", "none"]).optional(),
  }).default({}),
  respond: z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), text: z.string(),
               tokenDelayMs: z.number().default(0), usage: z.boolean().default(true) }),
    z.object({ type: z.literal("toolCalls"),
               calls: z.array(z.object({ name: z.string(), input: z.unknown() })) }),
    z.object({ type: z.literal("error"), status: z.number(),
               retryAfterMs: z.number().optional() }),
    z.object({ type: z.literal("dieMidStream"), afterChars: z.number() }),
    z.object({ type: z.literal("hang"), forMs: z.number() }),    // exercises timeouts
  ]),
});
```

Usage tiers:

1. **Unit (runner):** `LlmClient` swapped for a pure in-memory fake — no HTTP. Covers the tag
   parser (property-tested against split-anywhere chunk boundaries), the prose-is-composition
   path, repair turn, retry ladder, abort propagation, session finalize/abort ordering, and
   commit/conflict logic.
2. **Integration (Vitest):** the real Fastify app + mock-llm in-process on an ephemeral port,
   both lanes pointed at it with distinct model names (`mock-high` / `mock-low`) so routing is
   assertable. Golden scenarios ship as fixtures: `continue-happy` (zero rounds, prose
   composed in the first response), `continue-with-tools` (2 planning rounds +
   `finish_planning` + refresh turn), `edit-multi-target`, `format-miss-then-repair`,
   `429-then-ok`, `die-mid-write-keep-partial` (including apply-after-restart against the run
   file), `hang-first-token`, `boundary-garbage` (invalid `<boundaries>` JSON → consolidation
   defers), and the **golden-prefix scenario** asserting byte-identical request prefixes (and
   an identical `tools` array) between planning round N and the composition call. Each test
   drives the real REST+SSE surface and asserts: `WorkEvent` sequence, run-file contents
   (parsed against `RunEvent`), storage artifacts, and index rows.
3. **E2E (Playwright) & manual dev:** `COWRITE_MOCK_LLM=1` boots the same servers with a
   default "improviser" scenario (deterministic seeded-RNG prose, 20 ms token delay) so the
   whole app demos offline; `mock:comfy` returns fixture PNGs after scripted delays with
   mirrored fault modes.

Determinism rule: scenarios are strictly ordered and any unmatched request fails the test
loudly — permissive fallthrough is how mock tests rot. *Rejected:* VCR-style record/replay
(creative-prose responses aren't stable enough to record once); per-test HTTP interception
(doesn't cover the e2e/manual tier; one mock for all tiers keeps behavior identical).

---

## 13. Illustration handoff

The harness owns the illustration tasks' queue slot, run record, cancellation, and time budget;
the pipeline (08) owns everything between:

```ts
export interface RunContext {
  lowClient: LlmClient;                  // accepts image_url content parts (low lane only)
  emit(e: RunEvent): void;               // recorded on the harness's run file
  progress(p: { phase: PipelinePhase;   // 08's enum; forwarded as task.progress WorkEvents
                attempt: number; maxAttempts: number; pct: number | null }): void;
  signal: AbortSignal;
  remainingMs(): number;                 // remaining illustrationBudgetMs — the pipeline checks
}                                        //   this before each attempt and commits its best
                                         //   scored candidate rather than overrunning
```

`runSectionIllustration(sectionId, guidance, ctx)` / `runWorldImage(entryId, guidance, ctx)`
commit PNGs through storage themselves and return `RunArtifact[]` for the run's `result`.
Image-gen attempts and VLM critiques appear as `toolCall`/`usage` events on the same run, so
provenance shows the whole loop.

---

## 14. MVP cut

**M1 (ships first)** — the frontier loop end-to-end:

- Task kinds: `continue`, `instructed-continue`, `quick-edit` (one-snippet targets),
  `enrich-section`, `propose-boundaries` (internal + manual `/consolidate`),
  `illustrate-section`, `world-image`
- Two-lane model routing from config; the session-driven runner with engine planning tools,
  prose-is-composition, refresh-turn handoff, tag-block output contract + one repair turn;
  direct-apply commits with revision recording; concurrent-edit guard with durable proposals
  (keep-partial + conflict apply/discard routes)
- Lanes and scheduler as specced (interactive 1/work, background 2/work, illustration 1
  app-wide), presence-gated sweeps, cancel + cancel-by-target, timeouts, retry ladder
- Full run persistence (`RunEvent` with typed `ContextSnapshot`), crash finalization,
  provenance endpoints, per-run token accounting
- Publishing on the per-work `WorkEvent` stream; error taxonomy; mock-llm + mock-comfy with
  the golden scenarios (including golden-prefix)

**M2:**

- `edit-task` (pane, multi-target commits, `contextSelections`) + `POST /tasks/estimate`;
  `quick-edit`/`edit-task` on frozen-section spans (`replaceSectionSpan` consumers go live)
- Multi-select selections; conflict-card UI polish (M1 uses toast + apply/discard actions);
  illustration candidate picker (08)
- Run pruning (`retention.pruneRunsAfterMonths`); review-mode consolidation (02);
  `GET /usage` rollups

**Structured-for, deferred beyond M2:** per-kind routing overrides UI (config-file only),
persisted SSE buffers (rejected — the run file is the durable record), mixed high/low staged
runs (rejected, §3.1), multi-snippet continues.

The cut keeps M1 to the brief's core rhythm — press continue, watch a page stream in, edit a
selection, and let the background quietly name, summarize, and illustrate what you've
finished — with every run auditable and every behavior testable offline.

---

## 15. Contracts

Shared schemas this subsystem **owns** (in `packages/shared/src/`):

| Schema | File | Consumers |
|---|---|---|
| `TaskKind`, `TaskSpec`, `EditTarget`, `SectionSpan`, `ContextSelection`, `Task`, `TaskEstimate` | `tasks.ts` | 03 §tasks (routes), 04 §task store, 06 §session specs |
| `RunEvent`, `RunArtifact`, `RunSummary` | `runs.ts` | 02 §runs (sink + index ingestion of `meta`/`result`), 03 §runs, 04 §provenance |
| `ContextSnapshot` | `runs.ts` (values produced by 06 §assembly) | 04 §provenance region view, run `meta` events |
| `HarnessKnobs` (timeouts/retries + `spendWarnUsd`/`spendStopUsd`, §6.4) | `config.ts` fragment | 03 §config (`config.harness`) |
| `LlmClient`, `RunContext` (interfaces, `apps/server`) | — | 08 §pipeline, 09 §mocks |

Shared schemas and services this subsystem **consumes**:

| Contract | Owner | Used for |
|---|---|---|
| `WorkEvent` (canonical SSE union; `task.*` members incl. `lane` on `task.started`) | 03 §SSE | all harness event publishing; bus handles resume/snapshots |
| `ErrorCode`, `ApiErrorBody` | 03 §errors | HTTP + `task.failed` taxonomy |
| `AppConfig` (`models`, `routing`, `harness`, `retention`) | 03 §config | endpoint config snapshots per task |
| Engine session API: `beginTask` → `assembleInitialPrompt` / `handleToolCall` / `compositionRefreshTurn` / `finalize` / `abort`; planning caps; `preview` | 06 §session | interactive assembly (§4.2); estimates (§9); `handleToolCall` must stay read-only/idempotent (planning-retry rule, §6.4) |
| `Fidelity`, candidate/preview DTOs | 06 §schemas | `contextSelections` validation, `TaskEstimate` |
| `StorageService`: `appendSnippet`, `reviseSnippet`, `replaceSectionSpan`, `restoreSnippet`, `putSummary`, `setSectionTitle`, `reserveOrderKey`, `recordRun`/`readRun`/`queryRunsByArtifact`, `matchWorldEntries`, `maybeConsolidate({taskTargetIds})`, `reconcile`, `onChange` | 02 §StorageService | all commits, run persistence, scheduler triggers, consolidation guards |
| `BoundaryProposal`, `ConsolidatedSnippet` | 02 §schemas | `propose-boundaries` output validation |
| `IllustrationMeta`, `ComfyConfig`, pipeline phase enum, `runSectionIllustration`/`runWorldImage` | 08 | illustration handoff (§13) |
| Prompt markup: region ordering, tag grammar, template wording | 07 | `prompts/*.md`, `<task>`/selection markers, output tag grammar (§5.2 defines only which blocks each kind expects) |
| `enrichment_wanted` / `enrichment.completed` in-process channels | 03 §in-process channels | scheduler triggers (§6.2) |

Cross-subsystem touchpoints: the harness supplies live task-target ids to
`maybeConsolidate` and exposes `cancelByTarget` for consolidation undo (02 §undo); the editing
signal that guards consolidation is 03's route feeding 02's marker; work open/close semantics
are 03 §lifecycle.
