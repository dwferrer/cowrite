# Cross-Subsystem Coherence Review — Cowrite

**Reviewed:** `docs/00-overview.md` (authoritative brief) against all six subsystem proposals and
their critiques in `docs/design/` (2026-07-06).

> **Process notes.** (1) The review-task paths resolved to `undefined`; per the convention the
> sibling docs established, the brief is `docs/00-overview.md` and this report lives at
> `docs/design/coherence.md`. (2) **`context-engine-critique.md` does not exist** — the context
> engine is the only subsystem that never received an adversarial review, and, as the findings
> below show, it is the hub of the most severe cross-subsystem conflicts (F1, F2, F7, F14, F15,
> F16, F20, F21). Commissioning that critique should accompany the fixes here.

Findings are in priority order. Tags: `[conflict]` two proposals assume incompatible things;
`[gap]` no proposal owns it; `[lifecycle]` an end-to-end flow breaks; `[tension]` critiques pull
in opposite directions. Severity is the ordering.

---

## Blockers

### F1. [conflict] The context-engine ↔ harness seam does not exist as specified
**Subsystems:** context-engine, agent-harness (also data-model, frontend downstream).

The harness runner (§4.2, §13.1) is written against a stateless
`contextEngine.assemble(workId, req) → {messages, tools, execTool, snapshot}`. The engine (§10)
actually exposes a stateful `beginTask() → TaskContextSession` with
`assembleInitialPrompt / handleToolCall / compositionRefreshTurn / finalize / abort`, where
`beginTask` **throws `SessionBusyError` if a session is open**. Three concrete breaks
(harness-critique #1, confirmed):

- The runner never calls `finalize`/`abort`, so the citation→TTL→decay ledger — the flagship
  behavior the brief names ("decays expanded items back to summaries") — never runs, and the
  **second task on any work throws** because the first session was never closed.
- Harness §6.1 runs interactive + background lanes concurrently per work and routes *every*
  `TaskKind` through the engine; the engine permits one session per work. Unimplementable together.
- The runner ignores `finish_planning`/`cite` (which feeds decay) and duplicates planning-round
  caps the engine already owns (4 vs 6 rounds).

**Resolution.** Adopt the engine's session API verbatim in the harness. Runner calls
`finalize("completed")` on success and `abort()` on error/cancel, forwarding `finish_planning.cite`.
Only interactive kinds (`continue`, `instructed-continue`, `quick-edit`, `edit-task`) use engine
sessions; background kinds use F2's path. One owner for planning caps: the engine.

### F2. [gap] Nobody owns prompt assembly for `enrich-section` / `propose-boundaries`
**Subsystems:** agent-harness, context-engine.

The engine models only the four interactive task types. The harness routes all eight kinds
through `contextEngine.assemble`. The illustration pipeline explicitly opts out and assembles its
own brief (illustration §13.3). Enrichment and boundary tasks — which run constantly in the
background — have no specified prompt-assembly owner, and if forced through the engine they
collide with F1's single-session rule.

**Resolution.** The harness task handlers for `enrich-section` and `propose-boundaries` own a
simple, stateless assembly (section text + neighbor short summaries + relevant world entries via
storage reads), mirroring the illustration pipeline's pattern. Document it in harness §2 and
engine §14/A3 so the engine's ledger is never touched by background work.

### F3. [conflict] Four incompatible SSE event vocabularies
**Subsystems:** agent-harness, api-deployment, frontend, illustration.

- Harness §8: per-**task** stream `GET /tasks/:t/events`, `TaskEvent` union, 512-event ring.
- API §7 (D1): per-**work** stream `GET /works/:w/events`, `WorkEvent` union — supersedes the
  harness, sign-off pending.
- Frontend §4.3: its own table — missing `task.stage` (yet `taskStore.phase` needs it), a
  `task.delta` without `target` (yet edits stream per-target), and an `enrichment.updated`
  payload `{sectionId, kind}` that cannot perform its stated cache patch (API fixed by inlining
  `SectionRow`; frontend doc not updated).
- Illustration §8: a `pipeline` TaskEvent variant with 7 phases + `pct`; API §7.2 instead defines
  `task.progress` with **3 different stage names and no `pct`** — the frontend's
  "Generating (attempt 2/3, 64 %)" caption has no data source under the API's shape.

**Resolution.** Declare API §7.2 `WorkEvent` canonical (per-work stream is right — background
events must reach a client that started nothing). Then patch it: replace `task.progress` with the
illustration doc's phase enum + `pct` + `maxAttempts`; keep `task.stage` and `task.delta.target`.
Harness §8 and frontend §4.3 rewrite to import the shared union. Carry harness-critique #7's fix
into the API `EventBus`: on reconnect, emit one synthetic per-target **snapshot** event
(accumulated stage-2 text) before live deltas — the raw ring buffer alone cannot replay a page of
streaming regardless of its size (4,096 events ≈ 2 min at 30 deltas/s).

### F4. [conflict] Frontend's single-slot task store is corrupted by the harness's concurrent lanes
**Subsystems:** frontend, agent-harness.

`taskStore.active` holds exactly one task ("one active generation at a time"), but the harness
runs interactive + background + illustration lanes concurrently and consolidation auto-enqueues
enrichment the moment a chapter freezes — i.e. precisely while the user streams a continue. An
`enrich-section` `task.started` overwrites the in-flight continue's stream state
(frontend-critique blocker, confirmed). This breaks the flagship loop routinely.

**Resolution.** As the frontend critique specifies: one `interactiveTask` slot (streaming block +
button disabling) plus a `Map<taskId, …>` for background/illustration progress; the SSE reducer
routes `task.*` by lane/kind (the `task.started` payload must therefore carry the lane — add it
to `WorkEvent`). Reword frontend A5 to "one *interactive* task per work."

---

## Major

### F5. [conflict] Consolidation vs. everything concurrent — a four-way race cluster with no owner
**Subsystems:** data-model, agent-harness, frontend, context-engine.

Four independent critiques converge on the same unowned responsibility:

1. **Undo-grace double truth** (data-model-critique #4): for 5 minutes, consumed snippet files
   remain in `frontier/` *and* the new section holds the same text. The reconciler runs before
   every agent run and knows nothing of `pending-ops.json`, so the context engine assembles the
   frozen chapter **twice** (as section + as "last-N snippets") on the very next Continue.
2. **Lost edit mid-consolidation** (data-model-critique #5): a snippet revision landing between
   plan and purge is silently destroyed.
3. **Target consolidated under a running edit / open editor** (harness-critique #5,
   frontend-critique §2): quick-edit commits against a purged snippet; the frontend editor,
   selection, and crash-copy dangle on a dead id. The data-model's "never frozen out from under
   them" active-window rule only protects the *tail*, not the passage being edited.
4. **Undo races auto-enrichment** (data-model-critique #14): undo deletes a section directory
   that a just-enqueued enrich/illustrate run is writing into.

**Resolution** (assign all four to the consolidation engine, i.e. the storage subsystem, with one
new API hook): (1) move consumed files to `.cowrite/undo/<opId>/` at apply time — atomic, and the
reconciler needs no journal awareness; (2) one in-process write mutex + purge-time hash check
against `history.jsonl`, mismatch ⇒ fold the newer text in as a normal edit; (3) the eligible
prefix excludes any snippet that is the target of a queued/running task **or** flagged
editor-open by the client (a lightweight `POST /works/:w/editing {snippetId|null}` signal — this
is a **new API route** no doc currently has), and commits against consolidated targets degrade to
the existing `conflict` artifact state; (4) undo cancels pending enrich/illustrate tasks for the
un-frozen section ids (harness needs cancel-by-target).

### F6. [conflict] [tension] Keep-partial / conflict recovery: three mechanisms, none survives its own failure mode
**Subsystems:** agent-harness, frontend, api-deployment.

- Harness §8: server-side proposal **in memory, 30 min TTL**, `POST /tasks/proposals/:t/apply`
  (the only non-work-scoped route). Its critique (#6): a restart or a lunch break silently loses
  the recovery even though the text is durably in the run file.
- Frontend §8.3/A5: keep the **client** buffer, commit via plain `POST /snippets` — its critique
  shows this destroys agent provenance (`authorship: "user"`, no `originRunId`).
- API §7.3: after restart, re-derive from `GET /tasks/:t` — which its own critique proves is
  in-memory and 404s after restart; the API critique then recommends the client-buffer path the
  frontend critique just rejected. **The two critiques pull in exactly opposite directions.**

**Resolution.** One mechanism: work-scoped `POST /works/:w/tasks/:t/proposal/apply|discard` that
**reconstructs the proposal from the run JSONL** (partialText / conflict block + spec are all
recorded there), no TTL, in-memory copy as cache only. The commit path records
`authorship: "agent"` + `originRunId` server-side. The client buffer remains a display fallback
while the SSE stream is dead, never a commit source. Update harness §8, frontend §8.3/A5, API
§3.6/§7.3 together.

### F7. [conflict] Edit-task: wire format and MVP milestone disagree
**Subsystems:** frontend, agent-harness, context-engine, api-deployment.

- **Wire format:** frontend A4 sends `{selections: [{id, fidelity}], targetIds}` on `POST /tasks`;
  the harness's `edit-task` `TaskSpec` has `targets` + `pinnedWorldEntryIds` and **no
  selections/fidelity fields**; the engine expects user selections to arrive through
  `beginTask(spec)` with `source: "user"`. No schema anywhere carries per-item fidelity choices.
- **Milestone:** frontend §15 ships the edit-task pane (with meter and Playwright spec 7) in
  **M1**; harness §14 and API §12 defer `edit-task`, `/tasks/estimate`, and the proposal routes
  to **M2**. As cut, the frontend ships a pane whose backend doesn't exist.

**Resolution.** Extend the shared `TaskSpec` edit-task variant with
`contextSelections: [{id, fidelity}]` (validated against engine candidates). Pick one milestone —
recommend deferring the pane to M2 with the harness (quick-edit exercises the machinery in M1),
and moving frontend e2e spec 7 to M2; `/context/preview` still ships M1 for the meter per API D7.

### F8. [conflict] Two irreconcilable ComfyUI config schemas — one is the design the other explicitly rejected
**Subsystems:** api-deployment, illustration.

Illustration §2.2/§3: injection points are `%marker%` node titles; the mapping is *derived* from
the workflow file; config is `ComfyConfig` with `workflowsDir`, `route`, `loop {maxAttempts,
acceptScore}`, per-workflow `execTimeoutMs`. It explicitly **rejects** a hand-written
node-id → field mapping ("node ids are unstable … the mapping silently rots"). API §8.2 then
defines `ComfyWorkflow { promptNodeId, promptField, timeoutMs }` — exactly that rejected mapping —
with different default workflow names (`scene-v1`/`portrait-v1` vs `default`), a `use` block
instead of `route`, no `loop`, no seed concept; and D9 self-contradicts by saying workflow files
are "only referenced, never parsed" while its schema demands a node id that only parsing can
validate. The API critique adds that the dangling `use` defaults make an env-only Docker start
either fatal or silently broken.

**Resolution.** The illustration doc owns this domain: API §8.2 imports `ComfyConfig` from
`packages/shared/src/illustration.ts` verbatim. Keep only the API's file-location decision
(`~/.cowrite/workflows/`). Per the API critique, `route` ↔ `workflows` cross-reference failures
are task-time `config_missing`, never startup-fatal.

### F9. [conflict] RunEvent/RunKind: two schemas for the same JSONL file, and an index that can't ingest the real one
**Subsystems:** data-model, agent-harness.

Data-model §10 drafts `RunKind` (`draft`,`revise`,…) and a 5-event `RunEvent`; the harness §7
supersedes it (RunKind = TaskKind, adds `lane`/`stage`/`attempt`/`usage`/`spec`/`contextSnapshot`,
9 artifact kinds with `state`), honestly flagged for sign-off. But the data-model's SQLite tables
still encode the draft: `agent_runs` has `input_tokens/output_tokens` (harness emits
`promptTokens/completionTokens`), no `lane` column (the brief's high/low cost split is then
unqueryable), and `run_artifacts.artifact_kind` lists 5 kinds where the harness commits 9 with a
`state` field. (Data-model-critique #8, confirmed.)

**Resolution.** Grant the sign-off: harness owns `RunEvent`/`TaskKind`/`RunArtifact` in
`packages/shared`; data-model owns file location, sink semantics, retention, and index tables —
updated to `lane`, `prompt_tokens/completion_tokens`, widened artifact enum + `state`. Delete
data-model §10's draft. Also adopt data-model-critique #17: rebuild parses only each run file's
`meta` + `result` lines, or the <2 s rebuild promise is false.

### F10. [conflict] Illustration enrichment metadata: unrepresentable states, uncomputable staleness
**Subsystems:** data-model, illustration.

Three convergent defects: (a) data-model `EnrichmentMeta.runId` is required, so user uploads
(`source:"user"`, no run) fail Zod (data-model-critique #7); (b) illustration's
delete-with-suppression writes a `suppressed` flag into a slot the same sentence nulls, and
`IllustrationMeta` cannot represent the tombstone (illustration-critique M3); (c) the >15 %
word-delta staleness rule is uncomputable from `sourceHash` alone, so `illustration_stale`
degenerates to any-change-is-stale — a GPU-burning violation of "files are the truth"
(data-model-critique #6 and illustration-critique M6, independently).

**Resolution** (all three critiques already agree — adopt as one change): the section's
illustration slot becomes a discriminated union
`null | IllustrationMeta | { suppressed: true, deletedAt }`; `IllustrationMeta` gains
`source: "agent"|"user"`, nullable `runId`, `sourceWordCount`, and (per illustration-critique M4)
`entities: Ulid[]` recorded at compose time so established-imagery lookup works by entity id
instead of text-matching prompts the no-names rule scrubbed. Data-model §10 adopts it; the sweep
skips `source:"user"` and tombstones.

### F11. [gap] Situation: brief-mandated, consumed by three subsystems, stored by none
**Subsystems:** data-model, context-engine, frontend, api-deployment.

The frontend persists it (`GET/PUT /situation`, `situation.changed`), the engine always includes
it full-fidelity, the API invents `<work>/situation.md` (D4) — and the data model has no file,
schema, StorageService op, or reconciler entry (its critique's blocker #1). The engine's
`EngineDeps` also has no situation reader — only `manuscript` and `worldInfo` — so even its own
`<situation>` region has no specified data source.

**Resolution.** Adopt API D4: `situation.md` at the work root, `getSituation/putSituation` on
`StorageService` (atomic write), reconciler-tracked, `contentHash` in index `meta`. Add a
`situation` reader to `EngineDeps`. Per the frontend critique, the `PUT` carries `baseUpdatedAt`
so an external edit surfaces the theirs/mine prompt instead of silent last-writer-wins.

### F12. [tension] World-info keys: one critique deletes the machinery another proposal depends on
**Subsystems:** data-model, context-engine, illustration, frontend.

The brief: keys are *optional* and entries are *not key-gated* — the engine confirms (every entry
at `short`, no key scan). Data-model requires `keys.min(1)` and builds `world_keys` "for the
context engine" — wrong consumer. Its critique therefore says **drop the `world_keys` table**
"unless the context-engine owner asks." But the *illustration* owner already asked:
`matchWorldEntries(text)` via the `world_keys` scan is its §13.2c interface for building intent
briefs, and the frontend consumes `keys[]` client-side (Aho–Corasick highlighting). Following the
data-model critique verbatim breaks the illustration pipeline's consistency mechanism.

**Resolution.** Keys become optional (`.default([])`) per the brief — that part stands. Keep a
server-side match capability *for illustration* (the table, or an in-memory scan over the loaded
entry list — at ≤ a few hundred entries either is trivial); rename its documented consumer from
"context engine" to "illustration pipeline." Frontend matching is unaffected (it gets keys from
`GET /world`). Note M4's entity-id recording (F10) reduces, but does not remove, this dependency
— the initial match of section text → entries still needs key matching.

### F13. [conflict] "Work close" is required, cancelled, and undefined — by three different docs
**Subsystems:** data-model, agent-harness, api-deployment.

Data-model runs consolidation "always on work close" and purges undo journals on close. Harness
"work close cancels everything in that work's lanes" — including the boundary run consolidation
synchronously awaits (harness-critique #4: close both requires and kills the run). The API layer,
which is the only place that could observe closing, has **no close concept at all** (its critique,
lifecycle gap #2): works are touched implicitly by GETs and an SSE subscription.

**Resolution.** Define once, in the API doc: *close* = the work's SSE subscriber count is zero
for N minutes, or server shutdown (SIGINT/SIGTERM/console-close on Windows). On close: stop
accepting tasks, cancel interactive+illustration, **skip the boundary agent** (the harness
critique's simpler MVP cut — the next open consolidates), finish journal steps, release the lock.
Correctness never depends on close (the journal covers hard kills — data-model-critique #13).

### F14. [gap] The provenance viewer's headline feature has no typed data source
**Subsystems:** frontend, agent-harness, context-engine.

Frontend §7.4 renders "Prompt (5 regions, 6.4k tokens)" with per-region collapse — "exactly what
the model saw." Run `message` events are flat `{role, text}`; the only region-shaped data is
harness `meta.contextSnapshot: z.unknown()`, and the engine's session API **never produces a
snapshot at all** (the harness assumed one from the interface it imagined, F1). Frontend-critique
§4 flags it; no doc resolves it.

**Resolution.** Define `ContextSnapshot` in `packages/shared`:
`{ regions: [{ name, tokens }], items: [{ id, fidelity, tokens, source }] }`, produced by the
engine at `assembleInitialPrompt` time and returned to the runner for the `meta` event. This also
gives the usage log's `regions` record a shared shape.

### F15. [conflict] [tension] Token estimation: two estimators, one meter, and a dead 2 MB dependency
**Subsystems:** context-engine, agent-harness, frontend, api-deployment.

The engine standardizes on `gpt-tokenizer` (cl100k) with per-fidelity counts, and A4 requires web
and server to "compute identical token numbers." The harness's `/tasks/estimate` uses chars/4 and
*rejects* real tokenizers. The same edit-task pane would show a chars/4 pre-launch line next to a
cl100k live meter — numbers that disagree by 20–40 % on prose. Meanwhile the frontend bundles
`gpt-tokenizer` (per engine A4) but never calls it — its critique says drop it; engine A4 says
keep it: opposite pulls.

**Resolution.** One estimator: the engine's. API D7 already points the way — `/tasks/estimate`
wraps `POST /context/preview` and adds cost math only; delete the harness's chars/4 (retain it
solely as the usage fallback when an endpoint omits `usage`). Drop `gpt-tokenizer` from
`apps/web`; rewrite engine A4 to "the server computes; the web renders" — the meter is
server-fed, so the identical-numbers requirement is satisfied trivially.

### F16. [gap] Per-fidelity token counts, `dialogueRatio`, `moodTag`: assigned to an "enrichment subsystem" that doesn't do them
**Subsystems:** context-engine, agent-harness, data-model.

Engine A2 assumes enrichment produces per-fidelity token counts, `dialogueRatio` ("computed at
enrichment time" — used by the MVP anchor scorer), and optionally `moodTag`. The harness's
`enrich-section` handler produces title + short + long only; the data-model's `EnrichmentMeta`
has no fields for any of these. Nobody computes them.

**Resolution.** The engine computes and caches token counts itself — it already specifies a
hash-keyed lazy path (§8.3); make that the only path and delete the A2 expectation.
`dialogueRatio` is a cheap regex the engine runs at anchor-selection time over text it already
loaded. `moodTag` stays deferred (the engine already degrades gracefully). No data-model change.

### F17. [gap] Browser-only facts (focus, "app focused") drive server-side schedulers, with no plumbing
**Subsystems:** data-model, agent-harness, frontend, api-deployment.

The reconciler triggers on "window focus"; the idle enrichment sweep requires "app focused." A
Fastify console server observes neither, and no doc defines the signal (data-model-critique #2,
harness-critique #14 both flag; neither the frontend nor the API provides it).

**Resolution.** Simplest: drop focus conditions — reconcile at start, pre-agent-run, and on a 30 s
timer *while the work has ≥1 SSE subscriber*; the idle sweep keys off "interactive lane empty
60 s + ≥1 SSE subscriber." SSE presence is a server-observable proxy for "app open" that needs
zero new endpoints.

### F18. [gap] Restart recovery leans on staleness semantics the data model doesn't define
**Subsystems:** agent-harness, data-model.

Queued tasks die on restart, "re-derived from staleness" — but staleness is
`sourceHash ≠ hash(content.md)` over an *existing* enrichment. A crash between consolidation and
enrich (or enrich and illustrate) leaves a section with no summary/illustration and nothing
stale: orphaned forever (harness-critique #15). Related: after a crash-restart within 2 minutes,
the old lockfile is < 2 min old, so the *same server restarting* opens its own work read-only
until the lock ages out — data-model §9.3 checks staleness by age only, never pid liveness.

**Resolution.** Data-model states: the sweep treats a *missing* enrichment/illustration on a
frozen, non-suppressed section as stale. Lock acquisition additionally treats a lock whose pid is
dead (same host) as stale immediately; pair with the nonce re-validation fix from
data-model-critique #10.

---

## Minor

### F19. [conflict] Context-engine on-disk state contradicts the data-model's layout rules
**Subsystems:** context-engine, data-model. The engine writes `works/<slug>/context/state.json` +
`usage.jsonl` into user-visible space and calls them "derived cache … regenerate if missing." The
data-model's rule: everything outside `.cowrite/` is user-facing truth; derived, deletable state
lives in `.cowrite/`. The engine also says `world-info/` where the data-model says `world/`, and
the reconciler doesn't track a `context/` dir (it would be flagged as unrecognized).
**Resolution:** move to `.cowrite/context/`; use `world/`.

### F20. [conflict] ID scheme: `sec_*/snip_*/wi_*` prefixes vs bare ULIDs
**Subsystems:** context-engine vs data-model/frontend/api. Everyone else uses bare ULIDs in DTOs,
paths, and events; the engine's item ids, ledger, tool args, and `/candidates` payloads use
prefixed ids. The edit-task pane pipes `/candidates` ids straight into task specs that Zod-check
`Ulid`. **Resolution:** define once in `packages/shared`: engine item id = `"<kindPrefix><ulid>"`
with parse/format helpers, or drop prefixes and carry an explicit `kind` field. Either — but one.

### F21. [tension] The fold ladder's "mirrors the model's view" invariant is false and couples the wrong knobs
**Subsystems:** frontend, context-engine. The frontend claims its distance-based fold ladder
mirrors the engine's default fidelity map; the frontend critique shows they differ in metric
(sections vs tokens), values, and shape, and the coupling ("if its defaults move, FOLD_DEFAULTS
moves with them") is unimplementable across units. **Resolution:** accept the critique's option
(a): own the fold ladder as pure UI ergonomics, delete the mirroring claim and the coupling.

### F22. [lifecycle] Quick edit on 2 snippets is impossible in MVP, and no doc says so
**Subsystems:** frontend, agent-harness, context-engine. Frontend MVP selection is one block
(multi-select deferred); harness `quick-edit` takes exactly one `EditTarget` (and its critique
#17 notes cross-boundary selections are undefined); the engine's table says "selected
snippet(s)". **Resolution:** write the MVP rule down: quick-edit = one snippet or one
intra-section span; multi/boundary-crossing selections are rejected with a hint pointing to
edit-task (M2). Engine table drops the plural.

### F23. [gap] The engine's `enrichment_wanted` and anchor-refresh events have no publisher/subscriber
**Subsystems:** context-engine, agent-harness, data-model. The engine emits `enrichment_wanted`
"for the enrichment subsystem" and refreshes anchors "when a chapter-level section finishes
enrichment" — no doc subscribes to the former or emits the latter in-process. **Resolution:**
route both through the API's `EventBus`/D6 storage hook: harness scheduler subscribes to
`enrichment_wanted` (enqueue with the idle-sweep cap); enrich-task commit publishes an in-process
`enrichment.completed` the engine's anchor logic subscribes to.

### F24. [conflict] Small contract mismatches to sweep in one pass
**Subsystems:** various — each already has a stated resolution; listed so they're tracked:
- Task-kind casing: kebab-case canonical (API D2); frontend and engine snake_case sketches update.
- Illustration cache-busting: API D5 derives `illustrationVersion` from enrichment `sourceHash`;
  illustration §8 says `generatedAt`. Pick D5's (regenerate-with-same-content still bumps —
  actually it doesn't: use the PNG's content hash, which handles both).
- `qk.worldEntry` needs `GET /world/:e` or a "derive from list" D-item (API critique).
- Frontend Playwright config: port 8787 vs server 2697, and inline shell env violating API §9.3's
  own Windows rule (both critiques flag; fix in frontend §14.2).
- `guidance` on illustrate/world-image `TaskSpec`, `pipeline` low-client `image_url` support:
  flagged sign-offs (illustration §13.1) — grant them.
- `SnippetDto.revisionCount` and image pixel dimensions need index columns (API D5); data-model
  §7.1 lacks both.
- Interactive lane 409-no-queue deviates from the brief's "tasks are queued" glossary wording —
  good call, but record the sign-off (harness-critique #13); frontend already assumes it.
- `reserveOrderKey()` visibility rule for mid-run user appends: specify in data-model
  (harness-critique #9).
- `replaceSectionSpan` / `reviseSnippet(baseRev)` / `restoreSnippet`: required by harness +
  frontend, absent from `StorageService` — adopt data-model-critique #9's signatures.
- Config file: `~/.cowrite/config.jsonc` (API D8) wins over harness's repo-root
  `cowrite.config.json`; harness §3.1 updates.

---

## Lifecycle walkthroughs (traces behind the findings)

**(a) User hits Continue; a snippet streams in.** POST task → harness reconciles + reserves an
orderKey (API missing in storage, F24) → context assembly hits the nonexistent `assemble` (F1) →
planning: a no-tool prose response is discarded and re-paid, and stage 2 drops `tools`, likely
cold-cache on every writing call (harness-critique #2/#3 — intra-harness but they break the
brief's cost principles on this exact path) → deltas ride whichever of four event vocabularies
(F3) → a background enrich starting mid-stream corrupts the frontend's single slot (F4) → commit
OK → `finalize` never runs, so **the second Continue throws `SessionBusyError`** (F1). Broken at
four seams.

**(b) A chapter drifts behind the frontier → consolidate + summarize + illustrate.** Debounced
trigger (owner: storage — but note a "pure library" can't run background timers; the consolidation
scheduler needs a named home in `apps/server`) → boundary run needs a prompt nobody assembles
(F2) and, via the engine, would collide with any open interactive session (F1) → journal applies;
for 5 minutes the reconciler can resurrect consumed snippets into the next prompt (F5.1) →
`onSectionsFrozen` → enrich (F2 again; token counts never stored, F16) → illustrate: world
matching depends on machinery one critique deletes (F12), established-imagery matching is
self-defeating until F10's `entities` fix, the internal timeout budget can exceed the harness's
10-minute cap and throw away a scored winner (illustration-critique M2), and progress events
don't match what the frontend renders (F3). Undo during any of this races the enrichment writes
(F5.4).

**(c) User selects 2 snippets and runs a quick edit.** Impossible as designed (F22): frontend
selection is single-block, harness quick-edit is single-target. Even the edit-task fallback is
M2-vs-M1 contested (F7). Single-snippet quick edit works except its mid-document deltas have no
rendering path (frontend critique — resolved as shimmer-until-done if written down) and its
target can be consolidated away mid-run (F5.3).

**(d) User hand-edits a frozen section's text.** External edit: reconciler catches it on the 30 s
poll — but the "focus" trigger is unplumbed (F17), the SSE fan-out for reconciler adoptions needs
the D6 storage hook the data-model doesn't yet expose, and illustration staleness is uncomputable
without `sourceWordCount` (F10). In-app edit via `PATCH …/content {baseHash}` works. Stale
summaries wait for a sweep whose "app focused" condition is unobservable (F17) and whose
`enrichment_wanted` fast-path has no subscriber (F23). Works, leakily.

**(e) Edit task with explicit context selection.** The pane's selections have no field in
`TaskSpec` (F7); its two estimate sources disagree numerically (F15); selections only enter the
ledger via `finalize`, which the runner never calls (F1); section-span commits need
`replaceSectionSpan`, which storage doesn't define (F24). And the pane itself is M1 in one doc,
M2 in two others (F7).

**(f) Server restarts mid-task.** Run file finalized as `crash` (good). Client reconnects →
`resync` → re-derives task state from `GET /tasks`, which is empty in-memory (API critique) →
keep-partial dead-ends across three inconsistent designs (F6). Re-derivation of lost background
work fails because missing enrichments aren't "stale" (F18). The restarting server may lock
itself out read-only for up to 2 minutes (F18). Consolidation journal replay itself is sound.

---

## Summary of resolution ownership

| Fix cluster | Docs to change |
|---|---|
| F1/F2/F14/F16 engine seam, snapshots, counts | agent-harness §4/§13.1, context-engine §10/§14, shared `ContextSnapshot` |
| F3/F4/F6 events + recovery | api-deployment §7 (canonical), agent-harness §8, frontend §4.3/§8.3, illustration §8 |
| F5/F13/F18 consolidation & lifecycle | data-model §6/§8/§9, agent-harness §6, new `POST /editing` route in api-deployment |
| F7/F15/F22 edit-task & estimates | shared `TaskSpec`, harness §2/§9, frontend §9.2/§15, api-deployment §3.6 |
| F8 ComfyUI config | api-deployment §8.2 imports illustration's `ComfyConfig` |
| F9/F10/F11/F12/F24 storage contracts | data-model §2.4/§5.2/§7/§10/§13 (largest single batch of edits) |
| F19/F20/F21/F23 | context-engine §3/§2.1, frontend §5.3 |

**Overall:** the six proposals share a sound architecture (files-as-truth + rebuildable index,
one two-stage runner, per-work SSE, marker-driven ComfyUI, one Zod contract) and the critiques
caught most intra-subsystem defects — but the set is not implementable together until the
engine↔harness session seam (F1/F2), the event vocabulary (F3/F4), and the consolidation
concurrency cluster (F5) are reconciled, and the data model absorbs the ~10 contract extensions
its siblings assume (F9–F12, F24). The context engine urgently needs the adversarial critique it
never received.
