# 10 — Roadmap & Milestones

Scope: what gets built in what order, the MVP boundary, and what is deliberately structured-for
but deferred. Docs 02–09 each carry a matching "MVP cut" section; this doc is the authority when
they need re-cutting.

## Key decisions

- **Two-phase MVP boundary.** M1 is the complete core experience (write, continue, consolidate,
  enrich, illustrate); M2 adds the edit-task pane and the power-user affordances around it.
  Rationale: quick-edit exercises all of the edit machinery in M1 with a tenth of the UI surface.
- **M1 is built in vertical stages, each ending in a demoable state** — storage first, then the
  API/UI shell, then the agent loop, then consolidation, then illustration. Every stage lands
  with its tests; nothing merges red.
- **Real-model tuning is its own phase (M1.5)**, run interactively in the dev container against
  the user's endpoints — prompt quality and budget defaults are expected to change there, and the
  design isolates them in config + doc 07's v0 templates.

## M0 — Scaffold ✅ (done)

pnpm monorepo (`apps/server`, `apps/web`, `packages/shared`), Biome, Vitest in every package,
CI, dev+runtime Dockerfile, and this design set.

## M1 — The core experience (MVP)

### Stage 1 — Storage core
Work/section/snippet/world/situation storage per 02: file formats, atomic writes, ULIDs +
fractional order keys, revision log, SQLite index + full rebuild, reconciler for external edits,
work locking. **Demo:** create a work with the CLI/API, hand-edit files, watch the index rebuild.

**The dev CLI (first-class, grows with every stage).** `apps/server` ships a `cli` entry that is
a complete alternate front-end to the storage layer and, later, the agent harness — the primary
tool for live testing against real models without going through the web app. Stage 1: works /
snippets / situation / world / search / reconcile / rebuild. Stage 3 adds `continue`, `instruct`,
`quick-edit` (streaming to stdout), `prompt render` (dump the exact assembled prompt, no model
call), and `context preview` (fidelity map + token counts). Stages 4–5 add `consolidate`,
`enrich`, and `illustrate`. Anything the web app can trigger, the CLI can trigger headlessly.

### Stage 2 — API + web shell
Fastify routes and the SSE event bus per 03 (canonical `WorkEvent` union, ring buffer + resume),
config loading (`~/.cowrite/config.jsonc`, env overrides, first-run setup screen), works list and
document view rendering real storage per 04 — virtualized scroll, snippet blocks, double-click
editing (Enter=newline, Ctrl-Enter=save), selection, markdown rendering, situation pane, world
panel with key highlighting + hovercards. No agents yet. **Demo:** write a story by hand in the
real UI, edit world entries, survive a server restart.

### Stage 3 — The agent loop
Model clients, harness lanes + run records per 05, context engine full loop per 06 (default
fidelity map, expand/search tools, citation decay, soft budget), prompt renderer per 07.
Tasks: `continue`, `instructed-continue`, `quick-edit` (single snippet), with streaming, cancel,
keep-partial recovery, and the provenance viewer reading run records. All development against
`packages/mock-llm`. **Demo:** the flagship loop — Ctrl-Enter, watch a page stream in, inspect
exactly the prompt that produced it, roll it back.

### Stage 4 — Consolidation + enrichment
Consolidation engine per 02 (journaled, undoable, editor-safe), boundary proposals + section
naming + short/long summaries per 05 (low model), staleness derivation, fold ladder + progressive
collapse in the document view per 04. **Demo:** write past the thresholds, watch chapters form
and fold into summaries; hand-edit a frozen chapter and watch its summaries re-derive.

### Stage 5 — Illustration
ComfyUI client, workflow registry with marker-based injection, VLM critique loop, budget-aware
commit per 08; images in the document view (right-of-text at full fidelity, inline when
collapsed); world-entry image generation; upload/regenerate/delete overrides. **Demo:** finish a
chapter, get an illustration, regenerate it with guidance.

### Stage 6 — Hardening
The failure-mode matrix in 09 turned into passing tests: restart mid-task, SSE resume, consolidation
races, external edits, config-missing paths. Playwright e2e flows green on Linux + Windows.
Startup banner, docs, packaging check (`pnpm start` from a clean clone).

**M1 exit criteria:** a user with two OpenAI-compatible endpoints and a ComfyUI workflow can
install, configure via the setup screen, and co-write an illustrated multi-chapter story with
every UI element in the brief working; `pnpm test` and e2e are green without any real endpoint.

## M1.5 — Real-model tuning (in the dev container)

Attach real high/low models and ComfyUI. Iterate on doc 07's v0 prompts, context-engine defaults
(soft budget 32k / hard cap 64k / TTL 3), consolidation thresholds, and the illustration rubric
using the usage logs the engine records. Deliverable: revised defaults + a short findings note
appended to 07. This phase is interactive by design — it is where the founder plays with it.

## M2 — Edit tasks & power editing

The edit-task pane (04): detailed instructions, explicit section/world-entry selection with
per-item fidelity, live token meter fed by `/context/preview`, `/tasks/estimate`. Harness
support: `edit-task` kind with `contextSelections`, section-span targets (`replaceSectionSpan`),
multi-snippet selection, conflict-card UI polish. Playwright spec for the pane.

## M3+ — Post-MVP directions (from the brief, structured-for)

- Richer illustration agency: more ComfyUI knobs, region-specific edits, candidate picker,
  per-kind workflows (portrait/scene/hq), world-entry images feeding character consistency.
- Un-freeze: promote a section back to snippets for heavy rework at the old frontier.
- Callback finder: some retrieval mechanism for "echo that scene from chapter 3" — explicitly
  *not* traditional RAG until it earns its place.
- Multiple works UX polish, work templates, export (EPUB/markdown compile).
- Persistent pins in the context engine; budget-tuning UI; per-speaker dialogue coloring.

## Working agreement for implementation sessions

Each stage is a branch + PR with its tests; docs 02–09 are updated in the same PR when reality
diverges from design (the docs are living specs, not archaeology). The mock servers are the
default dev target; real endpoints only in M1.5+ sessions.
