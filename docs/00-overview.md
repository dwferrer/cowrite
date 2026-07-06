# Cowrite — Overview

*An illustrated co-writing app: the user writes a novel-length story together with an LLM, and an
image-gen model illustrates scenes as they are written. A simple, modern take on the SillyTavern
idea — stripped of fiddly legacy features, focused on agentic workflows, large contexts, and
simplicity for the user.*

This document set is the development plan. Each doc stands alone, but they share the vocabulary
and decisions defined here.

## Document map

| Doc | Contents |
| --- | --- |
| [01-architecture.md](01-architecture.md) | System components, processes, data flow |
| [02-data-model.md](02-data-model.md) | Work / section / snippet model, on-disk format, SQLite index |
| [03-api.md](03-api.md) | REST + SSE surface, shared Zod contract, config |
| [04-frontend.md](04-frontend.md) | UI architecture, document view, interactions |
| [05-agents.md](05-agents.md) | Agent harness, task types, run records, model routing |
| [06-context-engine.md](06-context-engine.md) | Smart context management (the flagship feature) |
| [07-prompting.md](07-prompting.md) | Prompt markup format, voice-preservation rules |
| [08-illustration.md](08-illustration.md) | ComfyUI integration, VLM feedback loop |
| [09-testing.md](09-testing.md) | Test strategy, mock servers, e2e plan |
| [10-roadmap.md](10-roadmap.md) | Milestones, MVP cut, deferred work |

## Product in one paragraph

The user and an LLM take turns appending short passages ("snippets") to a long story. Most work
happens at the **frontier** — the furthest point of the text. As the frontier moves on, older
snippets consolidate into a nested **section** tree (chapters, scenes, …) that gets **enriched**
in the background with names, short/long summaries, and one illustration per section. The UI is a
single scrollable document that shows full chat-like snippets at the frontier and progressively
collapses older material into summaries, then names and images. Agentic tasks (continue the story,
targeted edits) run against a **smart context engine** that gives the model hierarchical summaries
of the whole work and lets it expand exactly the pieces it needs via tool calls.

## Glossary

These terms are used consistently across all docs, the codebase, and prompts.

- **Work** — one story project; the unit of storage and session. Everything below lives inside a
  work.
- **Frontier** — the current end of the text; the primary active worksite. "Near the frontier"
  means recent enough to still be represented as snippets.
- **Snippet** — the base unit of authorship near the frontier: a short passage added by the user
  or the model. Snippets carry provenance (who wrote/edited it, via which agent run) and a
  revision history that supports cycling and rollback.
- **Section** — a node in the nested division of prior-written text. Section *levels* (book,
  part, chapter, scene) are a backend-configurable ladder, always strictly nested (a tree).
- **Enrichment** — derived, optional additions to a section: a human-readable **name**, a
  **short summary**, a **long summary**, and at most one **illustration**. Summaries are
  substitutable: given the preceding context, a summary can stand in for its source text without
  losing information the model needs.
- **Consolidation** — the automatic transition of frontier snippets into sections once the
  frontier has moved sufficiently far past them. Precise snippet edit history is collapsed at this
  point (a design decision — see 02-data-model.md).
- **World-info / context entry** — out-of-voice reference material about characters, places,
  concepts: name, optional match keys, markdown body, optional image and short summary. Not
  key-gated for prompt inclusion; the context engine decides inclusion.
- **Situation** — an optional, user-maintained scratch outline/instructions for the current
  scene, shown in a separate pane and included in prompts clearly marked as instructions.
- **Task** — one unit of agentic work: continue, instructed continue, quick edit, edit task,
  enrichment, illustration. Tasks are queued, streamed, cancellable.
- **Agent run** — the persisted record of a task's execution: prompts, tool calls, outputs,
  resulting revisions. This is what the provenance UI displays.
- **Context engine** — the subsystem that assembles prompts from hierarchical summaries + full
  text near the frontier, exposes expand/inspect tool calls to the model, tracks what was used,
  and decays expanded items back to summaries under a soft token budget.
- **High model** — the big text-only LLM (OpenAI-compatible API) used for prose and heavyweight
  agentic work. Never receives images.
- **Low model** — the small, fast VLM (OpenAI-compatible API) used for summaries, enrichment
  chores, and the image-prompt feedback loop.

## Fixed constraints (from the brief)

- External services are user-managed endpoints: two OpenAI-compatible LLM endpoints (high/low)
  and one ComfyUI endpoint whose workflows take a natural-language prompt and return an image.
- All artefacts stored on the local filesystem, grouped by work, human-readable/editable, robust,
  fast. Duplication is acceptable.
- Runs as a local console app; browser at localhost; no auth, no multi-tenancy.
- No RAG / vector search in this phase.
- Markdown for display; markup-structured prompts with instructions at top, freshest prose at the
  bottom; cache-friendly wherever possible.

## Stack

**TypeScript end-to-end.** pnpm workspace monorepo:

| Package | Role | Key tech |
| --- | --- | --- |
| `apps/server` | Console app: HTTP API, agent harness, storage | Node 22+, Fastify 5, tsx runtime |
| `apps/web` | Web UI | Vite 7, React 19 |
| `packages/shared` | Single API contract | Zod schemas, consumed as TS source |

Supporting choices: Biome (lint + format), Vitest (unit/integration), Playwright (e2e),
Server-Sent Events for streaming, SQLite (`better-sqlite3`) as a rebuildable index over
file-based storage.

**Why not the alternatives.** Python (FastAPI) would split the project into two toolchains for no
gain — the backend only talks to HTTP APIs, so Python's ML ecosystem buys nothing here. Go/Rust
give single-binary deployment but slow down iteration on what is fundamentally a
prompt-and-UX-iteration project. A single TS codebase gives shared runtime-validated types across
the API boundary, one set of tooling on Windows and Linux, and the same deployment story as
SillyTavern (install Node, run one command), which the brief points at approvingly.

**Runtime style.** The server runs from TypeScript source via `tsx` (no build step for the
backend; the web app is the only thing that builds). This keeps dev and prod identical and makes
"edit a prompt template, restart, retry" loops fast.

## Name

The repo is `cowrite`, and **Cowrite** works as a product name: short, says what it does. Rejected
candidates, for the record: *Illustrated Cowriter* (descriptive but clunky), *Storyloom*,
*Inkwright*, *Vellum* (taken by a popular novel-formatting app), *Quill* (crowded namespace).
Workshop freely; nothing in the code depends on the display name.

## Principles

1. **Frontier-first.** Optimize the append workflow; everything behind the frontier may "merely
   work."
2. **Simple surface, powerful engine.** Fiddly knobs live in config files and ComfyUI workflows,
   not in the UI.
3. **Files are the truth.** Any state the app can't rebuild from the work directory is a bug.
4. **Agentic quality, not parameter quality.** Better output comes from feedback loops and context
   management, not from exposing sampler settings.
5. **Cache-frugal prompting.** Prompt prefixes stay stable across turns and tasks wherever
   possible; churn costs real money.
6. **Test without models.** Every agentic behavior must be exercisable against mock OpenAI/ComfyUI
   servers.
