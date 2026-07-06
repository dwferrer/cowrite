# Contract-Consistency Verification — Final Doc Set

Verified 2026-07-06 against `docs/design/RESOLUTIONS.md` (register) and `coherence.md` F1–F24.
Scope: docs 00, 02–09 (01/10 skimmed for milestone/lifecycle agreement).

**Verdict: no blockers.** The set is implementable together. Every register §2 settled choice is
present and consistent (bare ULIDs + `kind` fields, positional-only anchors with no
`dialogueRatio`/`moodTag` anywhere, total frontier coverage documented on both sides of the
02↔06 coupling, tools-stay-in-request with `tool_choice:"none"`, shimmer-not-inline for targeted
edits, `%output%` marker + whitelist fallback with task-time `config_missing`, budget-aware
best-of illustration commit). All coherence.md lifecycle seams spot-checked and present: engine
session API driven by 05 §4.2 (`finalize`/`abort`), background assembly owned by 05 §4.4,
`.cowrite/undo/<opId>/` staging (02 §6.4), `POST /works/:w/editing` (03 §3.4 → 02 §6.2),
proposal reconstruction from run JSONL (03 §3.7 / 05 §5.1 / 04 §8.4), situation storage +
`SituationReader` (02 §2.2 / 06 §9.3), illustration tombstone union (02 §10.3 / 08 §6), close
semantics defined once in 03 §4.2 and referenced by 02 §9.4 / 05 §6.2, SSE-presence triggers
everywhere. Event vocabulary, task kinds, ports, directory layout, shared-package layout, and
config keys match register §3; milestone cuts match register §2.8 (one nit, #10). What remains
is a short list of contract-table drift, mostly bookkeeping between 03, 04, and 08.

## Major

1. **[major] 03's canonical route table omits three M1 routes that 08 defines.**
   08 §8 specifies `GET /api/illustration/health`, `POST /api/works/:w/sections/:s/illustration`
   (user upload), and `DELETE /api/works/:w/sections/:s/illustration` (tombstone) — all M1
   override paths (08 §5, §12). 03 §3 claims to be the canonical endpoint list and §5.2/§12's
   contract test asserts registry ↔ route-table 1:1, so these routes as written would fail the
   drift fence. *Fix:* add the three rows to 03 §3 (health under §3.12 or its own row; section
   illustration upload/delete alongside §3.10) and bump the "~45 entries" registry note.

2. **[major] `contextOverrides` has no home in 02's schemas.**
   03 §3.1 (`WorkDetail.settings: WorkSettings`, "consolidation thresholds + contextOverrides
   (02 §work.json)"), 03 §9.2, and 06 §8.1/§15 all rely on a per-work
   `work.json → contextOverrides` (`Partial<BudgetKnobs>`) edited via `PATCH /works/:w` — but
   02 §10.2's `WorkMeta` has no such field, and 02 never mentions `contextOverrides` or defines
   the `WorkSettings` export 03 §6.1 places in `work.ts`. *Fix:* in 02 §10.2 add
   `contextOverrides: BudgetKnobs.partial().default({})` under `WorkMeta.settings` (importing
   the 06-owned schema) and define/name `WorkSettings`.

3. **[major] 04's server-restart recovery contradicts 03/05.**
   04 §14 ("Server restarted mid-task" row: "task state re-derived from `GET /tasks[/:t]`") and
   the §4.3 `resync` row ("re-derive task state from `GET /tasks`") point at endpoints 03 §3.7 /
   §8.4 and 05 §8 declare **empty/404 after a restart by design** ("clients must not poll it to
   recover state; that path is `GET /runs/:r`" + proposal routes). `GET /tasks/:t` is valid only
   for same-process reconnects. *Fix:* reword 04 §14/§4.3 so restart recovery reads
   `GET /runs/:r` (the taskId the client already holds) and resolves via the proposal routes;
   keep `GET /tasks` for same-process resync only.

4. **[major] 04 uses an error code that isn't in the closed `ErrorCode` enum.**
   04 §4.2 (undo route row: "409 `gone` after grace expiry") and §14 ("undo route returns 409
   `gone`") — `gone` does not exist in 03 §7's closed enum, and 03 §3.8 specifies `409 conflict`
   for an expired/purged undo token. *Fix:* change both mentions in 04 to `409 conflict`.

## Minor

5. **[minor] `ContextSnapshot` ownership attributed to two different owners/files.**
   03 §6.1, 05 §7.1/§15, and 06 §9.3/§15 agree: schema in `runs.ts`, owned by 05, values
   produced by 06. But 02 §10.7's heading ("owned by 05 … and 06 (`context.ts`)") and consumed
   table ("`ContextSnapshot` | 06 §snapshot"), and 04 §17 ("`context.ts` | 06 §9–10"), attribute
   it to 06/`context.ts`. 04 §4.5's sketch also types `items[].id` as `z.string()` where 05 has
   `Ulid`. *Fix:* point 02 §10.7 and 04 §17/§4.5 at 05 `runs.ts` (owner) with `id: Ulid`.

6. **[minor] `/context/preview` request/response drift across 03/04/06.**
   Request: 03 §3.11 says `{selections, taskType, targetIds?}`; 06 §11's `PreviewRequest` has
   `targets: ItemRef[]` (no `targetIds`). Response: 04 §9.2/§17 expects the "effective budget
   numbers" (soft budget + hard cap for the meter) in the preview response; 06's
   `PreviewResponse` is `{totalTokens, perRegion, overSoft, overHard}` — no budget fields.
   *Fix:* align 03's field name to `targets`, and either add
   `softBudget`/`hardCap` (effective values) to 06's `PreviewResponse` or have 04 read them from
   `GET /context/state`.

7. **[minor] `SectionRow` shape described two ways.**
   03 §3.2 prose: "staleness flags, `hasIllustration`, `illustrationVersion` (PNG content hash),
   image `width/height`" (flat fields); 04 §4.5 defines the Zod: nested
   `illustration: {version, width, height} | null` + `stale: {short, long, illustration}` (no
   `hasIllustration`). One canonical shape is needed in `section.ts` (03 owns the DTO); 04's
   nested form matches 02 §7.1's index columns. *Fix:* restate 03 §3.2's field list to the
   nested `illustration` object and drop `hasIllustration`.

8. **[minor] The consolidation-deferral nudge event has no `WorkEvent` member.**
   02 §6.3 step 3: after 3 deferrals "the scheduler emits a nudge event (surfaced as 'long
   frontier — split manually?' in the UI)". The canonical union (03 §8.2) has no such variant
   and 04's reducer has no row for it. *Fix:* add e.g.
   `{type:"consolidation.nudge"}` to 03 §8.2 + a 04 §4.3 row, or reword 02 to a log-only notice.

9. **[minor] Editing-signal expiry semantics differ between 02 and 03.**
   02 §6.2: the marker is "expired if the SSE subscriber that *set* it disconnects"; 03 §3.4:
   "cleared server-side when the work's SSE subscriber count drops to *zero*". With two tabs the
   behaviors diverge. *Fix:* pick 03's count-zero rule (simpler, no per-subscriber tracking) and
   align 02 §6.2.

10. **[minor] Milestone drift: frozen-provenance history UI.**
    03 §13 puts "`GET /sections/:s/history` (frozen provenance UI)" in **M2**; 04 §16 puts the
    history-timeline view in "structured-for, deferred beyond M2" (and 04 §6.4 says "deferred");
    register §2.8's M2 list does not include it. *Fix:* move 03's M2 bullet to
    structured-for/deferred (the route itself can stay structured-for as 03 §3.2 already says).

11. **[minor] 04's cross-references into 03 use stale section numbers.**
    04 repeatedly cites 03's SSE material as "§7.2/§7.3" (now §8.2/§8.3), world image upload as
    "03 §3.4" (now §3.5), proposal routes as "03 §3.6" (now §3.7), config as "03 §8" (now §9),
    errors as "03 §6" (now §7); 04 §17 also places `ErrorCode`/`ApiErrorBody` in a nonexistent
    `errors.ts` (03 §6.1 and register §3 put them in `api.ts`). *Fix:* one renumber sweep over
    04's 03-references + the module-name cell in 04 §17.

12. **[minor] 08 §2.4's table header contradicts its own last row.**
    The header says the knobs are "all under `comfyui.timeouts`", but the `illustrationBudgetMs`
    row (correctly) says it is owned by the harness (`config.harness`, 05 §6.4) — and 08 §3's
    `IllustrationTimeouts` schema rightly omits it. *Fix:* amend the header ("all under
    `comfyui.timeouts` except `illustrationBudgetMs`, which is `config.harness`").

## Checked and clean (for the record)

- `WorkEvent` union (03 §8.2) covers every event 02/04/05/08 consume, with `lane` on
  `task.started`, `target` on `task.delta`/`task.snapshot`, 08's 7-phase enum + `pct` +
  `maxAttempts` on `task.progress`, and snapshot-on-reconnect semantics consumed identically by
  04 §4.3/§8.3 and 08 §8.
- `TaskSpec`/`TaskKind`/`EditTarget`/`ContextSelection` (05 §2.1) match 03 §3.7's wire recap and
  04 §9.2's submission verbatim; kebab-case everywhere; quick-edit selection rule identical in
  03/04/05/06.
- `RunEvent`/`RunArtifact` (05 §7.1) match 02 §7.1's index columns (lane,
  `prompt_tokens`/`completion_tokens`, 9 artifact kinds + `state`) and 02 §10.7's meta/result
  ingestion rule.
- `IllustrationMeta`/`IllustrationSlot`/`ComfyConfig`/`CritiqueResult`/`PipelinePhase` agree
  across 02/03/04/08, including `sourceWordCount` staleness, `entities` lookup, tombstone
  never-regenerate, and PNG-content-hash cache busting.
- `StorageService` ops consumed by 05/06/08 all exist in 02 §11 with matching signatures
  (incl. `replaceSectionSpan`, `restoreSnippet`, `reserveOrderKey`, `matchWorldEntries`,
  `maybeConsolidate({taskTargetIds})`, `setEditingSnippet`, `onChange`).
- `Fidelity` owned by 06, aliased (not coupled) by 04's `FoldLevel`; fold ladder decoupled from
  the engine map per F21; one tokenizer (engine) per F15 — no tokenizer in `apps/web` or shared.
- Directory layout, `.cowrite/context/`, `world/`, port 2697, `~/.cowrite/config.jsonc`,
  `z.partialRecord`, override provenance, Docker config volume, host-header allowlist: all match
  register §3/§2.13–14.
- Mock scenario names, e2e specs (incl. 09's declared spec-0 addition), golden-prefix pairing,
  and the failure-mode matrix line up across 04/05/08/09.
