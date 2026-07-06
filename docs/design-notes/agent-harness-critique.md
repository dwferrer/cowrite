# Critique — Agent Harness & Task Orchestration (Proposal v1)

**Reviewed:** `docs/design/agent-harness.md` (2026-07-06)
**Brief:** `docs/00-overview.md` (the task-supplied brief path resolved to `undefined`; this repo
document carries the product description, fixed constraints, and fixed baseline stack, and the
proposal itself declares it authoritative — accepted for this review). The output path also
resolved to `undefined`; this critique is placed alongside the sibling
`docs/design/data-model-critique.md`.

**Cross-checked against:** `docs/design/data-model.md`, `docs/design/context-engine.md`,
`docs/design/illustration.md`.

Overall: the skeleton is right-sized — one two-stage runner, a closed task taxonomy, tag-block
output, three lanes, one JSONL run file per task, one mock server for all test tiers. The serious
problems are concentrated in one place: the harness was written against an **imagined context-engine
interface** instead of the one the sibling design actually specifies, and two details of the
two-stage loop (discarded stage-1 prose, tools dropped in stage 2) quietly break the brief's
cost/caching principles on the hottest path.

---

## Blockers

### 1. [blocker] §13.1 / §4.2 — the context-engine interface the runner is built on does not exist

The harness assumes a stateless call:

> `assemble(workId, req: ContextRequest, opts?: {dryRun}) → { messages, tools, execTool, snapshot, itemEstimates }`

The context-engine design (`context-engine.md` §10) actually exposes a **stateful session**:
`beginTask(spec) → TaskContextSession` with `assembleInitialPrompt()`, `handleToolCall()`,
`compositionRefreshTurn()`, `finalize("completed")`, `abort()` — and `beginTask` **throws
`SessionBusyError` if a session is already open**; its failure table says "the task runner
serializes per work." This is not a naming quibble; three concrete things break:

- **Concurrency conflict.** Harness §6.1 runs interactive and background lanes *concurrently* per
  work, and routes every `TaskKind` — including `enrich-section` and `propose-boundaries` —
  through `contextEngine.assemble`. With a single-session engine, a background enrich running
  during an interactive continue throws. One of the two designs must move; as written they cannot
  be implemented together.
- **The decay ledger never updates.** The engine's citation→ttl→decay pipeline (its flagship
  behavior, per the brief's "context engine … decays expanded items back to summaries") runs only
  in `finalize`, and `abort` is what guarantees no side effects on cancel. The runner pseudocode
  (§4.2) never calls either. Cross-run decay — which §4.1 explicitly relies on ("Decay … applies
  *across* runs") — silently never happens, and the second task on a work throws `SessionBusyError`
  because the first session was never closed.
- **No owner for background-task prompts.** The engine's session state only models
  `continue | instructed_continue | quick_edit | edit_task`. Who assembles the prompt for
  `enrich-section` / `propose-boundaries` is specified nowhere.

**Fix:** adopt the session interface verbatim; add `finalize`/`abort` to the runner's success,
error, and cancel paths; decide explicitly that background tasks use a separate, simple, stateless
assembly path (they need a section's text + neighbors, not the ledger) so they don't contend for
the interactive session; delete `execTool`/`snapshot` in favor of the engine's real names and add
the engine's `snapshot`-equivalent to `finalize`'s contract if the run file needs it.

---

## Major

### 2. [major] §4.2 — a no-tool-call planning response is discarded and regenerated: double cost and latency on the most common path

The runner: *"if resp has no toolCalls: break — model is ready; **discard any planning-stage prose
it emitted**"*, then appends the write cue and runs stage 2. But the engine doc says the opposite
and designed for it: *"simply responding with prose and no tool calls (**the harness treats any
non-tool assistant message as the start of composition**)"*, and its system prompt tells the model
*"If you already have what you need, just start writing."* The harness itself notes the common case
for `continue` is **0–1 planning rounds** — i.e., in the normal case the model will emit a full
page of prose in stage 1, the harness throws it away (up to `maxOutputTokens` = 2048 tokens of
high-model output paid for), then pays again in stage 2. That doubles the cost and the
time-to-first-visible-token of the core "press continue" gesture, violating both "snappy" and
brief principle 5 ("churn costs real money"). There is also no output-token cap on planning calls,
so the waste is unbounded up to config.

**Fix:** feed stage-1 deltas through the `TagBlockParser` too; if a no-tool-call response contains
the expected block(s), it *is* the final output — commit it. Only issue the stage-2 cue when
planning actually consisted of tool rounds. Cap planning-call `maxOutputTokens` low (~256) as a
backstop, and align with the engine's `finish_planning` tool (see issue 8), which the runner
currently doesn't model at all.

### 3. [major] §4.2 — dropping `tools` in stage 2 likely destroys the prefix cache the whole design is built to protect

Stage 2 sends the grown message list with **no tools**. On most OpenAI-compatible servers
(vLLM, llama.cpp, TGI, many routers), tool definitions are rendered *into the prompt* by the chat
template — usually near the system message. Removing the `tools` array therefore re-renders the
entire prompt without the tool text and the prefix cache misses **from byte 0 on every single
writing call** — the most expensive call of every task. This defeats §4.1's careful append-only
discipline and directly contradicts brief principle 5 and the harness's own principle 3. The
engine doc assumes the opposite: *"each round and the final composition call reuse the full cached
prefix"* (§5.2).

**Fix:** send the identical `tools` array in stage 2 with `tool_choice: "none"` (verify the target
servers keep the rendered prefix stable under `tool_choice`; they generally do since `tool_choice`
is decoding-side), plus the write cue's "no tool calls now" instruction as belt-and-braces. Add a
golden-prefix integration test (mock server asserting byte-identical request prefixes between
planning round N and the writing call).

### 4. [major] §6.2 vs data-model §6.2 — work close both *requires* and *cancels* the boundary run

Data-model: consolidation is evaluated "always on work close." Harness §2/§13.4: consolidation
synchronously awaits `propose-boundaries`, which "executes as a normal queued run." Harness §6.2:
"Work close cancels everything in that work's lanes." Put together: close triggers consolidation,
consolidation enqueues a boundary run, close cancels it, consolidation can never complete at close
time — the one moment the data model most wants it. Nobody specified shutdown ordering.

**Fix:** define work-close as a small state machine: stop accepting tasks → cancel interactive +
illustration → *drain* (not cancel) any boundary run consolidation is awaiting, with a hard cap
(e.g. 30 s) after which consolidation defers exactly as it does for an invalid proposal. Or,
simpler MVP cut: skip the boundary agent at close and let the next open consolidate.

### 5. [major] §5.6 — the concurrent-edit guard ignores the other writer: consolidation

`quick-edit`/`edit-task` guard against *user* edits via `baseRev`/`baseContentHash`, but a frontier
snippet targeted by an in-flight edit can be **consolidated away** mid-run (the debounce is 30 s
after the last frontier write, and continue tasks keep writing). At commit, `reviseSnippet` targets
a snippet whose file is deleted or pending purge — behavior unspecified, and the §6.1 carve-out
only covers `continue` commits waiting on the consolidation journal, not edits, and not the reverse
direction. On a 100k+-word work where consolidation fires constantly behind an active frontier,
this race is routine, not exotic.

**Fix:** two rules: (a) the consolidation engine's eligible prefix excludes any snippet that is a
target of a queued/running interactive task; (b) a commit against a missing/consolidated target
degrades to the existing `conflict` artifact state (the proposal card already handles "text changed
under you" — "text got frozen under you" is the same UX).

### 6. [major] §8 — keep-partial / conflict proposals held "in memory 30 min" re-creates the exact rage moment §6.4 says it removes

The doc's own words: losing three good paragraphs "is the #1 rage moment in this category of app."
Yet the recovery affordance is an in-memory object with a 30-minute TTL. A server restart, or a
user who walks away from the error toast and comes back after lunch, silently loses Apply — even
though **the text is already durably persisted in the run file**. Holding volatile state for data
that exists on disk is a pure own-goal. Separately, `POST /api/tasks/proposals/:taskId/apply` is
the only route not scoped under `/api/works/:workId/…` — inconsistent and ambiguous in a
multi-work server.

**Fix:** make apply/discard reconstruct the proposal from the run file (`partialText` /
conflict-block text + target spec are all in there); drop the TTL entirely; scope the route under
the work. The in-memory copy becomes a cache, not the source.

### 7. [major] §8.2 — a 512-*event* ring buffer cannot replay one page of streaming: resume breaks in the common case

A 300–700-word continue at typical SSE chunk granularity (a few tokens per delta event) produces
well over 512 delta events, plus tool/stage/usage events. A tab refresh mid-write — the exact
scenario resumability exists for — replays only the tail; the head of the pending-overlay text is
gone, the UI shows garbled partial prose, and nothing repairs it until commit. Sizing the buffer in
events instead of reconstructable state is the flaw.

**Fix:** cheapest correct version: keep the accumulated stage-2 text per block in the task record
and, on reconnect, emit one synthetic `snapshot` event (full text so far, per target) followed by
live deltas. Then the ring buffer can stay small or disappear. (This also fixes replay after the
buffer's 5-minute post-task window without touching disk.)

---

## Minor

### 8. [minor] §4.2 — planning caps contradict the engine and `finish_planning` is unmodeled

Harness: `maxToolRounds` 6/2/6/2/2. Engine (§6): "max 4 planning rounds (`quick_edit`: 2), max 10
tool calls total," plus a `finish_planning` tool carrying `cite` (which feeds decay). The runner's
loop has no total-call cap and treats `finish_planning` as just another tool call, so it would
execute it and keep looping. Pick one owner for the caps (the engine, which enforces budgets
anyway) and make the runner break on `finish_planning`, forwarding `cite` to `finalize`.

### 9. [minor] §5.6 — `reserveOrderKey()` semantics are hand-waved

"A user snippet typed mid-run simply precedes the new one" only holds if the storage layer's
`appendSnippet` *knows about* the in-memory reservation when generating the user snippet's key —
otherwise both keys are generated "after current last" and the interleaving is luck (ULID
tie-break). Data-model §10 has no such API; it's listed as a new requirement but with no
visibility rule. Also unacknowledged: the agent's continuation was generated *without* the user's
mid-run text, yet lands after it — a narrative discontinuity. Specify the reservation contract,
and consider treating "frontier grew during continue" like a soft conflict (toast: "you added text
while it was writing").

### 10. [minor] §6.1 — "per-work scheduler" contradicts "1 global" illustration lane

The scheduler is introduced as "Per-work scheduler, in-process, in-memory," but the illustration
lane is "**1 global** (ComfyUI is one box) … FIFO across works." That requires an app-level
scheduler component that the module layout (§10) doesn't show. One sentence fixes it: lanes
`interactive`/`background` live per work; `illustration` is a single app-level queue that per-work
schedulers submit into.

### 11. [minor] §2 / §3.1 — `enrich-section`'s one-run-three-outputs collides with the low lane's 1,024-token default

Title + short summary + a "few paragraphs" long summary in one response, under
`maxOutputTokens: 1024`, is truncation-prone — and a truncated `<summary-long>` triggers the
repair turn, doubling the cost the single-run design was meant to save. Raise the default or give
handlers a per-kind output budget. Related duplication: the spec carries `parts:
["title","short","long"]` *and* §2 says the runner independently suppresses title when
`titleSource: "user"` — two mechanisms for one decision; keep the runtime check, drop `parts` (or
vice versa).

### 12. [minor] §7 — "runs are small (tens of KB)" is off by ~10×; say so and reconsider default-off pruning

Every run persists the fully-assembled prompt (the engine budgets ~30k+ tokens ≈ 120+ KB of
message text) plus `contextSnapshot`. A 300k-word novel written a page at a time is ~600–1,000
runs → on the order of **100+ MB** of permanent run files per work. The brief allows it
("duplication is acceptable"), so keeping them is fine — but the size claim is wrong, and
"permanent by default with the pruning knob off" deserves a stated number so the decision is made
with eyes open.

### 13. [minor] §6.1 — the interactive lane's 409-no-queue deviates from the brief's glossary

Brief: "**Task** — one unit of agentic work … Tasks are **queued**, streamed, cancellable." The
harness refuses to queue interactive tasks (409 `busy`). The rationale (stale writing intents are
a footgun) is genuinely good — but this is a deliberate deviation from the brief's wording and
should be flagged as such for sign-off, not presented silently.

### 14. [minor] §6.1 — "app focused" is a browser fact used as a server-side scheduler condition

The idle sweep triggers when "app focused, interactive lane empty for 60 s." The server can't see
focus. Specify the plumbing (e.g., the UI's SSE/status connection carries a focus heartbeat; no
connection ⇒ not focused) or drop the focus condition and rely on the interactive-idle timer alone.

### 15. [minor] §6.1 — restart recovery depends on "never generated" counting as stale, which the data model doesn't say

Queued tasks die on restart ("re-derive from staleness"), and `illustrate-section` is only enqueued
"after its enrich succeeds." Data-model staleness is `sourceHash !== hash(content.md)` on an
*existing* enrichment — a section with no summary or no illustration at all has nothing to be
stale. Crash between consolidation and enrich (or between enrich and illustrate) then orphans the
section forever. State explicitly: the sweep treats *missing* enrichments/illustrations on frozen
sections as stale.

### 16. [minor] §3.1 — "open works read-only without any endpoints configured" gates the wrong thing

No model endpoints means no *agent tasks*; the user can still type, edit, reorder, and manage
world entries — the files are theirs. "Read-only" invites an implementer to lock the editor behind
model config. Reword: works open fully editable; task controls surface `config_missing`.

### 17. [minor] §2 — quick-edit selections that cross a boundary are undefined

"If the selection lies in a frontier snippet / in a frozen section" — and if it spans two
snippets, or straddles the frontier/frozen boundary (both easy to do with a drag)? Define it:
either reject with a hint ("select within one passage") or split into multiple targets via the
edit-task path. Rejection is the right MVP answer; it just has to be written down.

### 18. [minor] §9 vs engine §9.2 — two dry-run estimate surfaces

The harness adds `POST /tasks/estimate`; the engine already exposes `POST /preview` for the same
edit-task pane. One dry-run pathway should exist (the harness route delegating to the engine's
preview is fine — but then `TaskEstimate` and `PreviewResponse` are one schema, not two).

---

## What was checked and found sound

(Recorded only so the next reviewer doesn't re-litigate; no praise intended.)
High/low routing with the image-parts type wall matches the brief's "never receives images";
whole-target tag-block rewrites over search/replace is the right call for prose and well-argued;
direct-apply + revisions instead of propose-then-apply matches "simple, modern, snappy" and the
data model's existing safety net; the single mock-server strategy satisfies brief principle 6;
the MVP cut (edit-task, span edits, conflict cards to M2) is disciplined; run-kind/RunEvent
supersession of data-model §10 is honestly flagged for sign-off rather than smuggled in.

## Verdict

The architecture is the right shape and the MVP discipline is real, but v1 is not implementable
as written: the runner is coded against a context-engine API that its sibling design contradicts
on interface, concurrency, lifecycle, and planning-termination — and two loop details (discarded
stage-1 prose, tools dropped in stage 2) break the brief's cost/cache principles on the core
"continue" path. Fix the integration seam (issues 1, 2, 3, 8) and the four lifecycle/race holes
(4–7) and the rest stands.
