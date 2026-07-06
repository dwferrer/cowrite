# Smart Context Management Engine — Design Proposal

Subsystem design for **cowrite** (working name: Illustrated Cowriter).
Baseline stack per the brief: TypeScript pnpm monorepo (`apps/server` Fastify 5, `apps/web` Vite +
React 19, `packages/shared` Zod schemas), files on disk as source of truth, REST + SSE, single-user,
localhost.

This document specifies the engine that decides *what the model sees* for every agentic task
(continue, instructed continue, quick edit, edit task), how the model can pull in more, how usage is
tracked, and how the whole thing stays cheap and cache-friendly.

---

## 1. Overview

The engine's job, per task:

1. **Assemble** a prompt that always covers the *whole work* top-to-bottom via hierarchical
   summaries, with real prose near the frontier (~10k tokens including "voice anchors" from earlier
   in the work).
2. **Serve tools** during the model's planning stage: expand a section's fidelity, open a world-info
   entry, search the manuscript. "Just start writing" ends planning.
3. **Track usage**: items the model opened (or explicitly cited) stay elevated for the next few
   tasks, then decay back to summaries.
4. **Enforce a budget**: a soft token budget with a progressive penalty (accelerated decay +
   score-based eviction) and a hard cap.
5. **Stay cache-friendly**: append-only within a task's agent loop; stable, stability-ordered
   regions across tasks.

Design ethos, matching the brief: one mechanism shared by all task types, no vector RAG, no fiddly
per-entry activation rules, everything on disk in human-readable JSON, and every piece of derived
state rebuildable from the manuscript.

---

## 2. Core concepts and fidelity model

### 2.1 Context items

Everything that can occupy prompt space is a **context item** with a stable ID:

| Item kind        | ID prefix | Fidelity levels available                       |
|------------------|-----------|-------------------------------------------------|
| Section          | `sec_`    | `name` → `short` → `long` → `full`               |
| World-info entry | `wi_`     | `name` → `short` (its one summary) → `full`      |
| Frontier snippet | `snip_`   | always `full` (never summarized while a snippet) |
| Situation pane   | `situation` (singleton) | always `full`                       |
| Voice anchor     | `anchor_` (derived, points at a section range) | always `full` |

Fidelity is a total order. `expand` moves up one or more levels; decay moves down to the item's
**default fidelity** (never below it — the skeleton always covers the whole work).

```ts
// packages/shared/src/context/schema.ts
import { z } from "zod";

export const Fidelity = z.enum(["name", "short", "long", "full"]);
export type Fidelity = z.infer<typeof Fidelity>;

export const FIDELITY_ORDER: Fidelity[] = ["name", "short", "long", "full"];
```

### 2.2 The context state (the "ledger")

The persistent per-work record of which items are elevated above their default fidelity, why, and
for how long. Default-fidelity items are *not* stored — the default is computed from the section
tree every task (see §5), so the ledger stays tiny and the whole structure is rebuildable.

```ts
export const ElevationSource = z.enum([
  "tool",        // model opened it via tool call during planning
  "cite",        // model listed it in finish_planning citations
  "user",        // user selected it in the edit-task pane
  "target",      // it is/contains the passage an edit task targets
]);

export const ElevatedItem = z.object({
  id: z.string(),                 // sec_* | wi_*
  fidelity: Fidelity,             // elevated level (above computed default)
  ttl: z.number().int().min(0),   // remaining "actions" (completed tasks) before decay
  source: ElevationSource,
  elevatedAtTask: z.number().int(),   // monotonically increasing task counter
  lastCitedTask: z.number().int(),
  tokens: z.number().int(),           // estimated token cost at this fidelity
});

export const ContextState = z.object({
  version: z.literal(1),
  taskCounter: z.number().int(),      // count of *completed* tasks ("actions")
  elevated: z.array(ElevatedItem),    // append-ordered by elevatedAtTask (stable order!)
  anchors: z.object({
    refreshedAtTask: z.number().int(),
    frontierSectionId: z.string().nullable(), // chapter-level section current at refresh time
    excerpts: z.array(z.object({
      id: z.string(),                 // anchor_<n>
      sectionId: z.string(),
      // half-open char range into the section's markdown source
      start: z.number().int(),
      end: z.number().int(),
      tokens: z.number().int(),
      moodTag: z.string().optional(), // from enrichment metadata if available
    })),
  }),
});
export type ContextState = z.infer<typeof ContextState>;
```

Notes:

- `elevated` is **append-only in order**: new elevations are pushed to the end; decayed items are
  removed in place. This ordering is what makes the `<expanded-context>` prompt region append-only
  across tasks (§6).
- One `ElevatedItem` per id. Re-elevation to a higher fidelity replaces the entry **in place**
  (same position) — the prompt bytes for that slot change, but everything after it is preserved.

### 2.3 Per-task session state (ephemeral)

During one task's agent loop the engine also tracks, in memory only:

```ts
interface TaskContextSessionState {
  taskId: string;
  taskType: "continue" | "instructed_continue" | "quick_edit" | "edit_task";
  openedThisTask: Map<string, Fidelity>;  // tool opens, before they're committed to the ledger
  citations: Set<string>;                 // from finish_planning
  toolCallCount: number;
  assembledTokens: number;                // running estimate incl. transcript growth
}
```

Nothing here persists if the task is aborted — aborted tasks are not "actions" and cause no decay
and no elevation.

---

## 3. On-disk layout and persistence

Context state **persists between tasks**, per work, as human-readable JSON next to the manuscript.
It is a *derived cache*: if it's missing, corrupt, or schema-mismatched, the engine regenerates
defaults and logs a warning — never a fatal error.

```
works/<work-slug>/
  work.json                    # owned by data-model subsystem
  manuscript/ ...              # owned by data-model subsystem (sections, snippets)
  world-info/ ...              # owned by data-model subsystem
  context/
    state.json                 # ContextState (the ledger + anchors) — atomic tmp+rename writes
    usage.jsonl                # append-only usage/profiling events (§8.4)
```

Write policy: `state.json` is rewritten once per **completed** task (in `finalize`, §11), via
write-to-temp + `rename`. Single process, single user — no locking needed; we assert a single
engine instance per work in the server.

`usage.jsonl` is append-only and never read by the engine itself; it exists because the brief says
"we'll need to do profiling to refine the exact way this will function." A `--no-usage-log` flag
disables it.

---

## 4. Default fidelity: covering the whole work

At every task start the engine computes a **default fidelity map** for the section tree, then
overlays the ledger's elevations. The default mirrors the UI's scroll-back folding, so what the
model sees matches the user's mental model.

Rules (walking the tree, frontier-relative):

1. **Frontier window**: trailing snippets/sections as raw prose until `frontierProseTokens` (6,000)
   is consumed. Always full, never evictable. For edit tasks the window is re-centered on the
   target passage instead (§10.2).
2. **Adjacent finished sections**: the 2 chapter-level sections immediately before the window get
   `long` summaries.
3. **Same parent (current part/arc)**: remaining earlier chapter-level siblings get `short`.
4. **Everything else**: highest-level sections (book/part) get `short`; their chapter children get
   `name`; anything deeper is omitted from the prompt (still expandable by ID via search results or
   the skeleton's named ancestors).
5. **World-info**: every entry at `short` (name + its one summary). If the world-info summary block
   exceeds `worldInfoSummaryBudget` (3,000), demote entries to `name` starting from the least
   recently cited (per ledger history) until it fits.
6. **Situation pane**: always included, full, if non-empty.

"Chapter-level" means: the deepest section level that the enrichment subsystem has produced
summaries for along the frontier path. We don't hardcode level names, matching the brief.

If the skeleton (rules 2–4) exceeds `skeletonSummaryBudget` (6,000) — very long works — demote
uniformly: rule-3 `short` → `name` first, then rule-2 `long` → `short`. Deterministic, oldest
(document-order-earliest) first.

### 4.1 Voice anchors

The brief wants ~10k tokens of real prose, *not* just the latest writing — "a range of pieces from
different moods across the work." Split: 6k frontier tail + 4k **voice anchors** (3–5 excerpts of
600–1,200 tokens each).

Selection algorithm (no embeddings, deterministic given inputs):

```
selectAnchors(tree, budget = 4000):
  candidates = all *finished* scene-level sections with full text available,
               excluding anything already inside the frontier window
  if candidates is empty: return []            # young work; frontier tail is all we have

  # 1. Stratify: divide the manuscript (by cumulative token position) into
  #    K = min(4, len(candidates)) equal spans; pick one candidate per span.
  # 2. Within a span, score candidates:
  #      +2 if enrichment moodTag differs from all already-picked anchors' tags
  #      +1 if dialogueRatio differs by >0.25 from the frontier window's ratio
  #         (dialogueRatio = fraction of lines that are dialogue; cheap regex count,
  #          computed at enrichment time)
  #      tie-break: highest token count section (richer prose), then document order
  # 3. From each winner, take a contiguous excerpt from the section START
  #    (scene openings establish voice fastest), sized budget/K, cut at a
  #    paragraph boundary.
```

`moodTag` is a single-word tone label ("tense", "wry", "elegiac"…) that we ask the enrichment
subsystem to produce alongside summaries (low model, ~1 extra token of output). If it's absent, the
scorer degrades gracefully to pure positional stratification + dialogue-ratio diversity — that
alone satisfies "range of pieces across the work."

**Refresh policy** (cache-critical): anchors are *pinned* — recomputed only when
(a) a new chapter-level section finishes enrichment (the frontier crossed a chapter boundary),
(b) the user hits "refresh anchors" in a debug/settings pane, or
(c) an anchor's source text was edited. Between refreshes the anchor bytes are identical, so the
`<voice-anchors>` region never invalidates the cache on ordinary tasks.

Rejected alternatives: random sampling per task (destroys prompt caching, non-reproducible);
letting the high model pick anchors during planning (spends expensive tokens on a job heuristics do
fine); embedding-based diversity (brief explicitly bans vector RAG for now).

---

## 5. Prompt assembly and ordering (cache-friendliness)

### 5.1 Region order — by decreasing stability

The single most important rule: **more stable content earlier**. Prefix caching then survives the
churn, which is concentrated at the bottom.

```not-xml
<instructions>            # static per task type; changes only on app upgrade
</instructions>
<world-info>              # all entries at ledger fidelity; STABLE ORDER = entry creation order
  <entry id="wi_mara" name="Mara Voss" fidelity="short"> ... </entry>
</world-info>
<global-context>          # section skeleton, document order, default fidelities ONLY
  <section id="sec_b1" name="Book One" fidelity="short"> ... nested ... </section>
</global-context>
<voice-anchors>           # pinned excerpts; changes ~once per chapter
  <excerpt id="anchor_1" from="Book One › Ch. 3 › The Ferry" tokens="1043"> prose </excerpt>
</voice-anchors>
<expanded-context>        # ledger elevations, APPEND-ORDERED by elevatedAtTask
  <section id="sec_ch7" name="Chapter 7" fidelity="full"> ... </section>
  <entry id="wi_mara" fidelity="full"> ... </entry>
</expanded-context>
<situation>               # user's scene outline; changes when the user edits it
</situation>
<task>                    # this task's user instruction (instructed-continue text,
</task>                   # edit instructions, or the standing "continue" directive)
<local-context>           # frontier prose (or edit-target neighborhood), snippet
</local-context>          # boundaries lightly marked; LAST, per the brief
```

Key decision: **elevated content lives in a separate `<expanded-context>` region, not folded into
`<global-context>` in document order.** The skeleton therefore stays byte-identical across tasks
(until a chapter freezes or a summary is edited), and new elevations are pure appends to the
expanded region. Each expanded block carries its full section path so the model can situate it.

*Rejected alternative*: folding expansions into the skeleton at their document position — reads
more naturally, but every elevation/decay would invalidate the cache from the middle of the prompt.
The duplication cost (a `short` summary in the skeleton plus `full` text in expanded-context) is a
few hundred tokens — cheap next to a cache miss over 20k+ tokens.

### 5.2 Within one task's agent loop — pure appends

The assembled prompt above is the first user message. Every planning round appends
assistant-tool-call + tool-result messages. Nothing earlier is ever rewritten, so each round and
the final composition call reuse the full cached prefix.

### 5.3 The composition hand-off ("frontier at the bottom")

The brief requires the frontier prose to sit as near the bottom as possible *during composition*.
If the model used planning tools, tool chatter now sits below `<local-context>`. Fix: when planning
ends, the harness appends one final user turn:

```not-xml
<local-context-refresh>
  # last ~1,000 tokens of the frontier prose, verbatim
</local-context-refresh>
Begin writing now. Continue directly from the prose above. Output only story prose.
```

This is a pure append (cache-perfect), costs ≤1k duplicated tokens, and puts real prose
immediately above the generation point — exactly the mitigation the brief describes for
reasoning-model voice collapse. If the model wrote prose on its very first response (zero tool
calls — the common case for plain "continue"), no refresh is needed: `<local-context>` was already
at the bottom.

*Rejected alternative*: rebuilding a fresh prompt for composition with expansions folded in —
cleaner transcript, but discards the entire cached planning prefix and doubles plumbing.

### 5.4 What unavoidably breaks the cache (accepted)

| Event | Invalidated from | Frequency |
|---|---|---|
| Frontier grows (every task) | `<situation>`/`<task>`/`<local-context>` tail | every task — by design, it's the cheapest region |
| Item decays out / eviction | its position in `<expanded-context>` | batched at task finalize; only under budget pressure or ttl=0 |
| Re-elevation to higher fidelity | that item's slot in `<expanded-context>` | occasional |
| Chapter freezes (prose → summary) | `<global-context>` | ~once per chapter |
| Anchor refresh | `<voice-anchors>` | ~once per chapter |
| User edits world-info entry / summary / instructions template | that region | user-driven; the brief accepts "update world-info slowly = cache friendly" |

The engine emits a `cache_break` usage event with the region name whenever a region's bytes change,
so profiling can quantify real-world hit rates.

---

## 6. Planning-stage tool interface

Registered with the agent harness for the high model. All tools are cheap, local, synchronous.

| Tool | Args | Returns |
|---|---|---|
| `context_expand` | `{ id: string, level?: "long" \| "full" }` | The requested content (default: one level up from current), wrapped with the item's path + a budget line |
| `context_open_entry` | `{ id: string }` | World-info entry full text (sugar for `context_expand` on `wi_*`; kept separate so prompts read naturally) |
| `context_search` | `{ query: string, wholeWord?: boolean, scope?: string /* sec_* id */ }` | Up to 20 matches: `{ sectionPath, sectionId, line, excerpt (~40 tokens around match) }` |
| `finish_planning` | `{ cite?: string[], notes?: string }` | Ends planning; `cite` lists item IDs actually relied on |

Mechanics:

- **Search is in scope** — plain text, not vector. MVP: case-insensitive literal substring with an
  optional whole-word flag, scanned over the section markdown files (a novel is a few MB; a linear
  scan is milliseconds — no index needed). Matches report section IDs so the model can follow up
  with `context_expand`. This is exactly the "grabbing precise info" case the brief says vector
  search is bad at. *Deferred*: full regex (would need RE2 or pattern sandboxing to avoid
  catastrophic backtracking — not worth it for MVP).
- **Ending planning.** Two paths, both supported: calling `finish_planning`, or simply responding
  with prose and no tool calls (the harness treats any non-tool assistant message as the start of
  composition). The system prompt says: *"If you already have what you need, just start writing."*
  `finish_planning` exists mainly to carry `cite` (§7); the prompt asks the model to use it when it
  opened anything.
- **Caps**: max 4 planning rounds (`quick_edit`: 2), max 10 tool calls total. On hitting a cap, the
  harness injects the `<local-context-refresh>` turn and forces composition.
- **Budget feedback**: every `context_expand` result ends with a status line, e.g.
  `-- context: 29,400 / 32,000 soft budget; opening more will evict older items --`.
  If an expansion would exceed `hardCap × 0.9`, the tool refuses:
  `"Too large to open in full (4,800 tokens). Try level:'long' (610 tokens) or narrow with context_search."`
- **Unknown/invalid IDs**: tool returns a polite error listing nearest valid IDs (prefix match);
  never throws into the loop.
- Every tool call emits an SSE-visible event (`context_item_opened`, etc.) via the task runner so
  the UI can show "opened Chapter 7" progress lines.

---

## 7. Citation tracking and decay

### 7.1 What counts as "used"

Pragmatic, zero-extra-LLM-cost definition for MVP:

1. **Opened via tool** during the task → cited, `ttl = defaultTtl (3)`, fidelity as opened.
2. **Listed in `finish_planning.cite`** → cited (covers "I already had it in expanded-context and
   relied on it again" — the *re-cite* path that resets ttl without a redundant re-open).
3. **User-selected in the edit-task pane** → cited, `source: "user"`.
4. Opened but explicitly *not* in a provided `cite` list → `ttl = 1` (it gets one grace task; if
   the model listed citations at all, we trust the omission).

*Deferred (structured for)*: a post-hoc "attribution pass" where the low model checks the generated
prose against opened items to score actual influence. The `usage.jsonl` events capture everything
needed to build and evaluate this later; it is not needed to ship.

### 7.2 Decay algorithm (runs in `finalize`, once per completed task)

```
finalizeTask(session, state):
  state.taskCounter += 1
  # 1. Commit this task's opens/cites into the ledger (append or replace-in-place, §2.2)
  for (id, fidelity) in session.openedThisTask:
      upsertElevated(id, fidelity, ttl = citedThisTask(id) ? DEFAULT_TTL : 1,
                     lastCitedTask = state.taskCounter)
  for id in session.citations where already elevated:
      elevated[id].ttl = DEFAULT_TTL           # re-cite resets the clock
      elevated[id].lastCitedTask = state.taskCounter

  # 2. Progressive-penalty decay step
  S = estimateAssembledTokens(state)           # next task's prompt, estimated
  overage = clamp((S - SOFT_BUDGET) / (HARD_CAP - SOFT_BUDGET), 0, 1)
  step = 1 + floor(2 * overage)                # 1 normally; 2 or 3 past the soft budget
  for item in state.elevated where item.lastCitedTask < state.taskCounter:
      item.ttl -= step
  state.elevated = state.elevated.filter(i => i.ttl > 0)   # decay back to default fidelity

  # 3. Hard-cap safety eviction (rare; see §8.2)
  persist(state)   # atomic write of context/state.json
```

Properties: items opened in task T survive tasks T+1..T+3 by default ("several actions"); any
re-open or re-cite resets to 3; budget pressure shortens everyone's clock symmetrically (oldest
items, having lower remaining ttl, fall out first — "accelerates dropping of older items" exactly
as the brief asks). Aborted tasks never reach `finalize`, so they neither elevate nor decay.

---

## 8. Token budgets: soft penalty, hard cap, defaults

### 8.1 Default numbers and reasoning

Assumption: "big and powerful" high model with ≥128k context, but per-token cost is the real
constraint (the brief: "obviously pretty expensive").

| Knob | Default | Reasoning |
|---|---|---|
| `frontierProseTokens` | 6,000 | Continuity backbone; with anchors totals the brief's ~10k prose |
| `anchorTokensTotal` | 4,000 | 3–5 excerpts × 600–1,200; enough to sample distinct moods |
| `skeletonSummaryBudget` | 6,000 | ~30–60 chapters at 100–150-token short summaries + a few longs |
| `worldInfoSummaryBudget` | 3,000 | ~40 entries at name+short; beyond that, demote to name-only |
| `softBudget` | 32,000 | Baseline skeleton ≈ 17–20k ⇒ ~12–15k of free headroom (≈ 4–6 full scenes or many entries) before penalties bite. Well inside cheap-cache territory for hosted models. |
| `hardCap` | 64,000 | 2× soft; generous for edit tasks touching many sections; still ≤50% of a 128k window, leaving room for the planning transcript + output |
| `defaultTtl` | 3 actions | "several subsequent actions" |
| decay step | 1 → 3 (linear in overage) | §7.2 |
| planning rounds | 4 (quick edit 2) | keeps loops snappy |
| tokenizer safety margin | 10% | counts are estimates (§8.3) |

All knobs live in one exported object in `packages/shared/src/context/budget.ts` and can be
overridden per work in `work.json` (`contextOverrides`). No UI for tuning in MVP — a JSON field is
enough for a hobby app, and profiling should pick the numbers before we build sliders.

### 8.2 Assembly-time eviction (the enforcement backstop)

Decay is the primary pressure valve; eviction is the backstop when a single task overshoots
(e.g., the model opened four full chapters, or an edit-task selection is huge):

```
enforce(state, requiredIds /* current task's user/target selections */):
  S = estimateAssembledTokens(state)
  while S > HARD_CAP * 0.9:
      victims = state.elevated where id not in requiredIds
      if victims empty: break                     # see below
      v = argmin over victims of keepScore(v)
      remove v; S = re-estimate
  if S still > HARD_CAP:                          # pathological: selection itself too big
      fail the task with a structured error the UI renders as
      "Selection exceeds the context limit (~71k of 64k). Deselect items or use summaries."

keepScore(v) = v.ttl / max(1, v.tokens / 1000)    # keep fresh & cheap; evict stale & fat
               tie-break: lower elevatedAtTask evicted first (older first)
```

Never evicted: frontier window, skeleton, anchors, situation, task instructions, and the current
task's `user`/`target` items. The soft budget is *not* enforced by eviction — exceeding it is
allowed (brief requirement) and only accelerates decay and triggers the tool-result warnings.

*Rejected alternative*: a per-token "rent" score with continuous half-life decay — more elegant on
paper, harder to reason about, debug, and display; TTL-in-actions is legible in `state.json` and in
the UI ("this item leaves in 2 tasks").

### 8.3 Token estimation

- Exact tokenization is impossible across arbitrary OpenAI-compatible backends. We standardize on
  `gpt-tokenizer` (cl100k) as a *consistent estimator*, and treat all counts as ±10% — hence the
  `0.9 × hardCap` enforcement line.
- Counts per fidelity (`tokens.name/short/long/full`) are computed and stored by the enrichment
  subsystem when summaries are (re)generated, so budget math and the edit-task UI never tokenize on
  the hot path. The engine tokenizes lazily and caches (keyed on content hash) for anything missing
  counts (e.g., un-enriched text, the situation pane).

### 8.4 Usage log (profiling hook)

One JSONL event per record, `works/<slug>/context/usage.jsonl`:

```ts
export const UsageEvent = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("task_start"), task: z.number(), taskType: z.string(),
             assembledTokens: z.number(), regions: z.record(z.string(), z.number()), ts: z.string() }),
  z.object({ kind: z.literal("tool_call"), task: z.number(), tool: z.string(),
             itemId: z.string().optional(), resultTokens: z.number(), ts: z.string() }),
  z.object({ kind: z.literal("task_end"), task: z.number(), cited: z.array(z.string()),
             decayed: z.array(z.string()), evicted: z.array(z.string()),
             finalTokens: z.number(), planningRounds: z.number(), ts: z.string() }),
  z.object({ kind: z.literal("cache_break"), task: z.number(), region: z.string(), ts: z.string() }),
]);
```

---

## 9. One engine, four task types

The engine is task-type-agnostic; task types differ only in three inputs:

| Task type | Target region (`<local-context>`) | Planning | Extra elevations |
|---|---|---|---|
| Continue | frontier tail (6k) | full (4 rounds) | — |
| Instructed continue | frontier tail (6k) | full | — (`<task>` carries the instruction) |
| Quick edit | selected snippet(s) + ~1k surrounding prose, frontier tail shrunk to 3k | capped at 2 rounds | selection as `target`, full |
| Edit task | target passage(s) + neighborhood; frontier tail included at `long` summary if target is far from frontier | full | user-pane selections as `user`, target as `target` |

For quick edit / edit task, the sections *adjacent to the target* are auto-elevated to `long` for
the duration of the task (source `target`, ttl 1) so edits respect their local surroundings.

### 9.1 What the edit-task UI needs

The edit-task pane shows candidate sections + world-info entries with token estimates and a running
total. It consumes two endpoints (below) and needs **no engine internals** — just the candidate
tree with per-fidelity token counts, current ledger fidelity, and a preview total.

### 9.2 REST endpoints (all under `/api/works/:workId/context`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/state` | Current `ContextState` + computed default fidelity map (debug pane, edit-task initial checkmarks) |
| GET | `/candidates` | Section tree + world-info list; per item: `{ id, name, path, defaultFidelity, currentFidelity, tokens: { name, short, long, full } }` |
| POST | `/preview` | Body: `{ selections: [{ id, fidelity }], taskType, targetIds? }` → `{ totalTokens, perRegion, overSoft, overHard }` — powers the live token meter |
| POST | `/reset` | Wipe ledger + anchors back to defaults (troubleshooting) |
| GET | `/usage?limit=100` | Recent usage events (future profiling view) |

Task *execution* endpoints belong to the task-runner subsystem; it calls the engine in-process.

---

## 10. Engine API and code layout

```
packages/shared/src/context/
  schema.ts          # Zod: Fidelity, ContextState, UsageEvent, candidate/preview DTOs
  budget.ts          # default knobs + per-work override merge
apps/server/src/context/
  engine.ts          # ContextEngine: load/beginTask/finalize/persist
  defaults.ts        # default fidelity map computation (§4)
  anchors.ts         # voice-anchor selection + refresh triggers (§4.1)
  assemble.ts        # prompt-region rendering, stability ordering (§5)
  tools.ts           # tool definitions + handlers (§6)
  search.ts          # literal manuscript search
  decay.ts           # finalize-time decay + eviction (§7, §8.2)
  estimate.ts        # token estimation + content-hash cache (§8.3)
  routes.ts          # Fastify routes (§9.2)
  __tests__/ ...
```

```ts
// apps/server/src/context/engine.ts — the surface other subsystems touch
export class ContextEngine {
  static async load(workDir: string, deps: EngineDeps): Promise<ContextEngine>;
  beginTask(spec: TaskSpec): TaskContextSession;      // throws if a session is already open
  candidates(): CandidateTree;                        // for GET /candidates
  preview(sel: PreviewRequest): PreviewResponse;      // for POST /preview
}

export interface TaskContextSession {
  assembleInitialPrompt(): PromptParts;               // ordered regions, ready for the harness
  tools(): ToolDefinition[];                          // §6, bound to this session
  handleToolCall(call: ToolCall): Promise<ToolResult>;
  compositionRefreshTurn(): string | null;            // §5.3; null if no tools were used
  finalize(outcome: "completed"): Promise<void>;      // citations → ledger, decay, evict, persist
  abort(): void;                                      // discard session state, no side effects
}

export interface EngineDeps {                         // everything injected = everything mockable
  manuscript: ManuscriptReader;   // data-model subsystem (§13 A1)
  worldInfo: WorldInfoReader;
  onEvent?: (e: UsageEvent) => void;   // task runner forwards to SSE + usage.jsonl
  now?: () => Date;
  knobs?: Partial<BudgetKnobs>;
}
```

The task runner's loop is: `beginTask` → `assembleInitialPrompt` → LLM rounds with
`handleToolCall` → `compositionRefreshTurn` → generate → `finalize("completed")` (or `abort`).

---

## 11. Failure modes

| Failure | Behavior |
|---|---|
| `state.json` missing/corrupt/old schema | Regenerate defaults, log warning, emit `cache_break:all`. It's a cache; the manuscript is truth. |
| Model never stops planning | Round/tool caps force composition (§6) |
| Model opens something enormous | Tool refuses past `0.9 × hardCap`, suggests `long` (§6) |
| Model cites unknown ID | Ignored + logged; never fails the task |
| Edit-task selection alone exceeds hard cap | Structured task failure surfaced in the UI meter (§8.2); the preview endpoint warns *before* launch |
| Un-enriched far section requested at `short`/`long` | `context_expand` returns full text if ≤1,500 tokens, else the first 1,500 + a note; emits an `enrichment_wanted` event for the enrichment subsystem |
| Anchor source text edited/deleted | Content-hash check at assembly; stale anchor triggers a refresh of just that excerpt |
| Token estimates drift from provider truth | 10% margin + hard cap ≤ 50% of model window keeps failures theoretical; API-level context errors bubble as ordinary task failures |
| Concurrent tasks on one work | `beginTask` throws `SessionBusyError`; the task runner serializes per work (single user) |

---

## 12. Testability

- **Pure core**: `defaults.ts`, `anchors.ts`, `assemble.ts`, `decay.ts` are pure functions of
  (tree, ledger, knobs) — table-driven Vitest units. Decay/eviction get exhaustive small-case tests
  (ttl math, overage steps, eviction order determinism).
- **Golden prefix tests** (the cache contract): assemble prompt for state A; elevate one item;
  reassemble; assert byte-identical prefix through `<voice-anchors>` and that the change is a pure
  append inside `<expanded-context>`. Same test across a simulated frontier-growth task. These
  goldens are the regression fence for cache-friendliness.
- **Property tests**: for random trees/ledgers — assembled estimate ≤ hardCap after `enforce`;
  every section reachable at ≥ `name` fidelity via some ancestor; decay is monotone; ledger
  round-trips through `state.json`.
- **Agent-loop integration**: mock OpenAI-compatible server (baseline stack) scripted to emit tool
  calls (`expand → search → finish_planning`); assert ledger, ttl values, usage events, and the
  refresh turn.
- **e2e (Playwright)**: edit-task pane token meter matches `/preview` within tolerance; launching a
  task with selections shows them cited in `/state`.

---

## 13. MVP cut

**Ships in MVP** — everything needed for the flagship loop:

- 4-level fidelity model, ledger, `state.json` persistence, default-map computation
- Voice anchors with positional stratification + dialogue-ratio diversity (moodTag consumed if
  present)
- Prompt assembly with stability ordering, `<expanded-context>` append region, composition refresh
  turn
- Tools: `context_expand`, `context_open_entry`, `context_search` (literal, whole-word),
  `finish_planning` with `cite`
- Tool-open + explicit-cite tracking; TTL decay with overage acceleration; hard-cap eviction
- Shared engine across all four task types; `/candidates` + `/preview` for the edit-task meter
- `usage.jsonl` event log

**Structured-for but deferred** (hooks exist; no code paths to maintain yet):

- Low-model post-hoc attribution pass (usage log already captures training data for it)
- Regex search (RE2), search result ranking
- moodTag generation itself (enrichment subsystem's call; anchors degrade gracefully without it)
- Persistent user pins ("always include this entry") — `ElevationSource` enum has room
- Budget-tuning UI (JSON overrides only in MVP) and a profiling dashboard over `usage.jsonl`
- Cross-work/global world-info sharing

---

## 14. Interface assumptions (cross-check with other subsystems)

**A1 — Data model / manuscript store** provides:
- A section tree with stable IDs (`sec_*`), document order, parent links, and per-section markdown
  source retrievable by ID; frontier snippets (`snip_*`) with authorship metadata; world-info
  entries (`wi_*`) with name/keys/body/summary. Read interface here called `ManuscriptReader` /
  `WorldInfoReader`.
- A "finished/frozen" flag per section (frontier snippets collapse into sections as the frontier
  moves away, per the brief) and a change event or content hash so the engine can detect edits.

**A2 — Enrichment subsystem** produces per section: `name`, `shortSummary`, `longSummary`,
pre-computed token counts per fidelity, optionally `moodTag` and `dialogueRatio`; emits an event
when a chapter-level section finishes enrichment (anchor-refresh trigger); accepts an
`enrichment_wanted` hint from this engine.

**A3 — Task runner / agent harness** owns the LLM loop and SSE streams; calls the engine hook
sequence in §10; distinguishes the four task types; passes edit-task selections and target ranges;
serializes tasks per work; forwards `onEvent` to SSE and `usage.jsonl`.

**A4 — Shared package** hosts the Zod schemas above and the `gpt-tokenizer`-based estimator so web
and server compute identical token numbers for the edit-task meter.

**A5 — Settings**: `work.json` (data model's file) tolerates an optional `contextOverrides` object
matching `Partial<BudgetKnobs>`.

**A6 — Prompting/templates subsystem** (if separate): owns the literal text inside
`<instructions>`; this engine owns region ordering and everything below instructions. Instructions
must remain static per task type for cache stability.
