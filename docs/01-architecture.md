# 01 — System Architecture

Scope: the component map, process model, and end-to-end data flows of Cowrite. Subsystem details
live in docs 02–09; this doc is the map that shows how they fit and the invariants they all obey.

## Key decisions

- **One Node process** hosts everything (HTTP, agent harness, background schedulers) — a
  single-user console app has no reason to be distributed.
- **Files are the source of truth; every other store is a rebuildable cache** (SQLite index,
  context-engine state, in-memory queues).
- **One canonical contract** — every payload crossing the HTTP boundary is a Zod schema in
  `packages/shared`; server validates both requests and responses against it.
- **One SSE stream per work** multiplexes all server→client events; REST is for reads and
  commands only.
- **Two model endpoints, strict routing** — the "high" text-only model writes prose; the "low"
  VLM does enrichment chores and the illustration loop. The high model never receives images.
- **Background work is gated on presence** — reconciliation, consolidation, and enrichment
  sweeps run only while the work has at least one SSE subscriber (the server-observable proxy
  for "the app is open").

## Component map

```
┌─────────────────────────── browser ────────────────────────────┐
│  apps/web (React 19 + Vite)                                    │
│  document view · frontier controls · situation pane            │
│  world panel · provenance viewer · setup screen                │
└───────────────┬───────────────────────────▲────────────────────┘
                │ REST (Zod-validated)      │ SSE per work
┌───────────────▼───────────────────────────┴────────────────────┐
│  apps/server (Node 22, Fastify 5) — one process                │
│                                                                │
│  HTTP layer (03)          Event bus ── ring buffer + resume    │
│      │                                                         │
│  Agent harness (05)  ──►  Context engine (06)                  │
│   lanes: interactive │     fidelity ledger · prompt assembly   │
│   background, illustr│     expand/search tools · decay         │
│      │               └──►  Prompt renderer (07)                │
│      ▼                                                         │
│  Illustration pipeline (08) ──► ComfyUI client                 │
│      │                                                         │
│  Storage service (02) ──► work dirs (files) + SQLite index     │
│   reconciler · consolidation engine · enrichment scheduler     │
│                                                                │
│  Model clients: high LLM · low VLM (OpenAI-compatible)         │
└───────┬───────────────┬────────────────┬───────────────────────┘
        ▼               ▼                ▼
   local filesystem   LLM endpoints   ComfyUI endpoint
   (user's disk)      (user-managed)  (user-managed)
```

Numbers in parentheses are the owning design docs.

## Process model

- **HTTP + SSE.** Fastify serves the REST API and the built web app; each open work holds one
  SSE connection. Events get monotonic ids; a small ring buffer supports `Last-Event-ID` resume,
  with an explicit `resync` event (client refetches over REST) when the gap is too old. See 03.
- **Task lanes.** The harness runs three lanes per the concurrency rules in 05: *interactive*
  (capacity 1 per work — a second continue while one streams is rejected, not queued),
  *background* (enrichment, boundary proposals), and *illustration* (globally serialized so one
  GPU isn't thrashed). Background work never touches the context engine's session or ledger.
- **Schedulers.** The consolidation sweep (02) and enrichment sweep (05) are timers inside the
  server process, active only while the work has SSE subscribers and the interactive lane is
  quiet. The reconciler (02) — which detects external file edits — runs at work open, before
  every agent run, and on the same presence-gated timer.
- **Shutdown/close.** "Work close" is defined as zero SSE subscribers for N minutes or process
  shutdown. Close stops new tasks, cancels interactive/illustration work, skips (never awaits)
  the boundary agent, finishes journal steps, and releases the work lock. Correctness never
  depends on a clean close: the consolidation journal makes hard kills recoverable.

## Data flow walkthroughs

**Continue (the flagship loop).** Click Continue → `POST /works/:w/tasks {kind: "continue"}` →
harness reconciles, reserves an order key, opens a context-engine session → engine assembles the
prompt (hierarchical summaries over the whole work + all un-consolidated snippets as full prose
at the bottom; see 06/07) → planning: the model may call expand/search tools (each turn appends;
the prefix stays cached) or simply start writing — that prose *is* the composition, never
regenerated → deltas stream over SSE into the frontier block → on completion the harness commits
the snippet with `authorship: "agent"` + run id, finalizes the engine session (citations feed the
decay ledger), and the run record (full prompt, tool calls, usage) lands in `runs/` for the
provenance viewer.

**Consolidation + enrichment.** When enough snippets pile up behind a protected active window,
the consolidation engine journals the operation, asks the low model for section boundaries and
names, writes section files, and moves consumed snippet files to a staging dir (undoable for a
grace period). Freezing enqueues background enrichment: short + long summaries per section
(low model), then an illustration task. All derived artifacts record the source content hash, so
staleness after later edits is detected by comparison, never by stored flags. See 02/05/08.

**Illustration.** The pipeline composes a natural-language image prompt from the section text and
matched world entries, submits the user's ComfyUI workflow (injection points marked by node
titles), and runs a critique loop on the low VLM — scoring each attempt against a rubric,
revising the prompt, and committing the best-scored candidate within its budget. See 08.

**Restart mid-task.** The run file is finalized as `crash`; the client reconnects, receives
`resync`, and refetches. Interrupted continues surface a keep-partial affordance rebuilt from the
run record (durable — not in-memory state). Missing enrichments on frozen sections count as
stale, so lost background work re-derives on the next sweep.

## Repository layout

```
cowrite/
├── apps/
│   ├── server/          Fastify app, harness, engine, storage, pipelines
│   └── web/             React UI
├── packages/
│   ├── shared/          Zod contracts (the API, events, config, task specs)
│   └── mock-llm/        scriptable mock OpenAI + ComfyUI servers (09)
├── docs/                this design set
└── Dockerfile           dev + runtime targets
```

User data lives outside the repo, under `~/.cowrite/` by default: `config.jsonc`, `workflows/`
(ComfyUI workflow JSON), and `data/works/<slug>/` per work (02 owns the layout).

## Invariants (enforced across all subsystems)

1. Deleting any `.cowrite/` directory inside a work, or the SQLite index, loses nothing — the app
   rebuilds from files.
2. Every mutation of story text is attributable: user action or agent run id, surfaced in the UI.
3. The interactive lane never blocks on background work, and background work never invalidates
   the interactive prompt prefix mid-task (snapshot-at-task-start rule, 06).
4. All prompts follow 07's region ordering: stable regions at the top, churn at the bottom.
5. Nothing binds beyond localhost by default, and a Host-header allowlist guards the
   unauthenticated API (the one security measure we ship).

## Contracts

Owns: the component boundaries and process/lifecycle rules above. Consumes: `packages/shared`
schemas (03 §contract), `StorageService` (02), engine session API (06), task/lane semantics (05).
