# Chief-Architect Decisions Register

This register is **binding** for the revision pass that turns the `docs/design/*.md` proposals
into the final `docs/NN-*.md` design set. It resolves every cross-subsystem finding in
`coherence.md` and settles the choices coherence left open.

**The authoritative product brief is the founder's verbatim brief at**
`docs/design-notes/brief.md`
(the original proposals only saw `docs/00-overview.md`, which is a faithful summary — but
re-check your subsystem against the verbatim brief while revising).

## 1. Adopt coherence.md wholesale

Every resolution in `coherence.md` (F1–F24) is **adopted as written**, including all items in the
F24 sweep list. Where a finding cited a critique's fix, that fix is adopted too. All
[blocker]/[major] items in each subsystem's own critique must be resolved in the revised doc;
[minor] items should be resolved unless there's a real reason not to (state it if so).

## 2. Choices coherence left open — now settled

1. **IDs (F20):** bare ULIDs everywhere. Engine payloads/tool args carry an explicit
   `kind: 'section' | 'snippet' | 'world' | ...` field instead of id prefixes.
2. **Voice anchors (engine critique m11 + F16):** MVP anchor selection is **pure positional
   stratification** across the work. `moodTag`/`dialogueRatio` scoring is deleted from MVP
   (structured-for later). The engine computes and caches token counts itself (hash-keyed, lazy);
   no enrichment-time token counts, no `dialogueRatio` field anywhere.
3. **Frontier coverage (engine critique blocker):** the default context map must cover **every
   byte of the work**: every section appears at ≥ name fidelity (short summary when available),
   and **all un-consolidated snippets are included at full text** in the local-context region.
   Consolidation thresholds are what bound that region's size (~9k words worst case) — document
   this coupling in both 02 and 06. The separate fixed "6k tail" rule is deleted; the tail is
   simply the newest part of the un-consolidated region. Byte-stability claims about
   `<global-context>` must be restated honestly: the skeleton region is stable *between
   consolidation/enrichment events*, and those events are batched/infrequent by design.
4. **Two-stage cache miss (harness critique #2/#3):** there is no tools-off second call. The
   `tools` array stays identical across every request of a run; composition is reached either by
   the model simply writing prose in planning (that prose **is** the composition — never
   discarded/regenerated) or after `finish_planning` via the engine's append-only
   local-context-refresh turn. One owner for planning caps: the engine.
5. **Targeted-edit streaming (F3/frontend critique):** quick-edit/edit-task deltas are **not**
   rendered token-by-token mid-document in MVP. The target block shows a "being rewritten" shimmer
   + progress, and swaps atomically on commit. `task.delta` still carries `target` on the wire
   (structure for later inline streaming).
6. **ComfyUI output node (illustration critique M5):** the workflow must designate its output
   node with a `%output%` title marker. Fallback when absent: exactly one node whose class is in
   a small whitelist (`SaveImage`, `PreviewImage`); zero or multiple ⇒ registry validation error
   at load (reported per-workflow, task-time `config_missing` when used — never startup-fatal).
7. **Illustration latency honesty (illustration critique M1/M2):** drop the "<20s per the brief"
   citation; timeouts are config with generous defaults. The loop is **budget-aware**: it checks
   remaining harness budget before each attempt and commits the best-scored candidate so far when
   the budget or attempts run out (never discards a scored winner on timeout).
8. **Milestones (F7):** two-phase plan. **M1 (MVP)** = frontier loop end-to-end (continue /
   instructed-continue / quick-edit on one snippet), storage core + reconciler, consolidation +
   enrichment, context engine full loop, illustration basic loop, per-work SSE, config +
   first-run setup, provenance viewer (basic), fold ladder, situation pane, world panel, mock
   servers + tests. **M2** = edit-task pane (+ `/tasks/estimate`, `contextSelections`,
   section-span edits, Playwright spec 7), multi-select, conflict-card UI polish, candidate
   picker, run pruning, review-mode consolidation. Every doc's MVP-cut section must match this.
9. **Event vocabulary home (F3):** the canonical `WorkEvent` union lives in
   `packages/shared/src/events.ts`; doc 03 (API) presents it; docs 04/05/08 reference it.
10. **Consolidated-snippet staging (F5.1):** consumed snippet files move atomically to
    `.cowrite/undo/<opId>/` at apply time (not left in `frontier/`), so reconciler/context never
    see double text during the undo grace window.
11. **Editing signal (F5.3):** new route `POST /works/:w/editing {snippetId | null}` (client
    declares which snippet has an open editor); consolidation's eligible prefix excludes
    editor-open and task-targeted snippets.
12. **Keep-partial / proposals (F6):** proposals are reconstructed on demand from the run JSONL
    (durable), applied via work-scoped `POST /works/:w/tasks/:t/proposal/apply|discard`; commits
    record `authorship: 'agent'` + `originRunId`; no TTL; in-memory copy is only a cache.
13. **Config (F24):** `~/.cowrite/config.jsonc` (env `COWRITE_CONFIG` overrides location);
    `dataDir` default `~/.cowrite/data`; port default 2697 bound to 127.0.0.1. Use
    `z.partialRecord` for keyed records with enum keys (Zod 4). `PUT /api/config` returns
    per-field `overriddenBy: 'env' | 'flag' | null` provenance. Host-header allowlist
    (localhost names + configured host) on every request — the one security measure we ship.
14. **Docker + ComfyUI config (api critique):** document the config volume
    (`-v ~/.cowrite:/root/.cowrite`) as the supported way to provide workflows in Docker; env
    vars alone configure only endpoints/keys.
15. **Doc hygiene:** revised docs are clean, self-contained design docs. No process
    meta-commentary ("per critique X", "the sibling doc said"), no "Interface assumptions"
    sections — replaced by a short **Contracts** section listing the shared-schema names this
    subsystem consumes/owns (with doc cross-references like "see 03 §events"). Keep concrete
    schemas, tables, pseudocode, failure-mode tables, MVP cut. British restraint on adjectives.

## 3. Canonical naming & layout (recap, binding)

- Task kinds: kebab-case (`continue`, `instructed-continue`, `quick-edit`, `edit-task`,
  `enrich-section`, `propose-boundaries`, `illustrate-section`, `world-image`).
- SSE event names: dot-case (`task.started`, `task.delta`, `task.stage`, `task.progress`,
  `task.completed`, `task.failed`, `snippet.created`, …); `task.started` carries `lane`.
- Work dir: `works/<slug>/` with `work.json`, `situation.md`, `frontier/`, `sections/`,
  `world/`, `runs/`, `.cowrite/` (index.sqlite, context/, undo/, trash meta).
- Engine state: `.cowrite/context/state.json` + `usage.jsonl` (rebuildable caches).
- Shared package layout: `packages/shared/src/{ids,work,section,snippet,world,situation,
  enrichment,illustration,tasks,runs,events,context,config,api}.ts`.
- Final doc numbering: 01-architecture, 02-data-model, 03-api, 04-frontend, 05-agents,
  06-context-engine, 07-prompting, 08-illustration, 09-testing, 10-roadmap.
- Prompt markup format: doc 07 owns the canonical region/tag grammar; 05/06/08 reference it
  rather than redefining tags.
