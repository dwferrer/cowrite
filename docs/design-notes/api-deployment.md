# HTTP API Surface, Config & Deployment — Subsystem Design

**App:** Cowrite — illustrated co-writing with an LLM ("simple, modern, snappy")
**Subsystem owner:** HTTP API, configuration & deployment (`apps/server` HTTP layer, `packages/shared`, packaging)
**Status:** Proposal v1 (2026-07-06)

> **Provenance note.** The brief path supplied to this task resolved to `undefined`; the product
> brief lives at `docs/00-overview.md` in the repo (its document map names this doc `03-api.md`)
> and is treated as authoritative, including the fixed stack (Node 22+, Fastify 5, tsx, Vite 7,
> React 19, `packages/shared` Zod contract, SSE, SQLite index, Biome/Vitest/Playwright). This
> design also reconciles the four sibling proposals — `data-model.md`, `agent-harness.md`,
> `context-engine.md`, `frontend.md` — which pre-committed to parts of this surface. Where they
> disagree, this doc makes the call and flags it in [§13 Interface assumptions](#13-interface-assumptions).

---

## 1. Scope and principles

This subsystem owns: the REST resource surface, the SSE stream, the shared Zod contract in
`packages/shared`, the error envelope, the config file (format, location, lifecycle, first-run),
and the deployment story (console start, dev mode, Windows/Linux parity, Docker).

Principles, derived from the brief:

1. **One contract, in TypeScript.** Every request, response, and event is a Zod schema in
   `packages/shared`, imported as source by both `apps/server` and `apps/web`. There is no second
   description of the API (no OpenAPI file to drift).
2. **The API is a thin skin.** Handlers validate, call in-process services (storage, context
   engine, agent harness), and shape DTOs. No business logic lives in a route.
3. **SSE keeps the client honest; REST is the resync.** Events carry enough payload to patch the
   client cache without refetch; when resume fails, the answer is "invalidate and refetch," never
   a bespoke catch-up protocol.
4. **Local, single-user, no auth.** Bind `127.0.0.1` by default; non-local binding is an explicit
   opt-in. No sessions, no tokens, no tenancy anywhere in the design.
5. **Config is a file the user can read.** One commented JSONC file per install; the UI's settings
   screen is a friendly editor over it, not a separate store.
6. **Boring deployment.** `pnpm install` → `pnpm build` → `pnpm start`, identical on Windows and
   Linux; Docker is a convenience wrapper over the same commands.

---

## 2. URL structure and conventions

- All JSON API routes live under `/api`; everything else is static web assets (built `apps/web/dist`).
- Work-scoped resources nest under `/api/works/:workId`; `:workId` is the work's ULID.
- IDs in paths are ULIDs (data-model §3). Bodies never carry the path ID redundantly.
- **JSON in, JSON out**, except: image bytes (`image/png`) and the SSE stream (`text/event-stream`).
- Verbs: `GET` reads, `POST` creates/acts, `PATCH` partial update, `PUT` full replace of a
  singleton value, `DELETE` removes. Actions that aren't CRUD (`cancel`, `restore`, `estimate`,
  `preview`, `test`, `reload`) are `POST <resource>/<verb>` — pragmatic and greppable.
- Successful responses are the **bare resource** (no `{data: …}` wrapper). Errors always use the
  envelope in §6. `201` for creates, `202` for accepted async work (tasks), `204` for deletes.
- Caching: API responses are `Cache-Control: no-store` except image routes (§4.8), which are
  `immutable` behind a version query param.
- Compression: `@fastify/compress` (gzip) for JSON > 1 KB; never for SSE.

---

## 3. The endpoint surface (complete table)

Canonical route list. "Schema" names refer to `packages/shared` exports (§5). Owner column says
which subsystem implements the handler body; this subsystem owns registration, validation, and
the DTO shapes.

### 3.1 Works

| Method & path | Req → Res | Notes |
|---|---|---|
| `GET /api/works` | → `WorkSummary[]` | Scans `dataDir` for `work.json`s (index-backed per work) |
| `POST /api/works` | `{title}` → `201 WorkDetail` | Creates directory + `work.json`, acquires lock |
| `GET /api/works/:w` | → `WorkDetail` | `WorkMeta` + settings + `readonly` flag (lock state) |
| `PATCH /api/works/:w` | `{title?, settings?}` → `WorkDetail` | Settings = data-model `WorkMeta.settings` + `contextOverrides` |
| `DELETE /api/works/:w` | → `204` | **Moves** the work dir to `<dataDir>/.trash/<slug>-<ts>/` — files are truth; the API never hard-deletes prose. Trash GC is manual (deferred). |

```ts
export const WorkSummary = z.object({
  id: Ulid, title: z.string(), slug: z.string(),
  wordCount: z.number().int(), snippetCount: z.number().int(), sectionCount: z.number().int(),
  updatedAt: IsoTime,
});
export const WorkDetail = WorkSummary.extend({
  settings: WorkSettings,          // consolidation + contextOverrides (data-model §10)
  levelScheme: z.array(z.string()),
  readonly: z.boolean(),           // second-instance lock (data-model §9.3)
});
```

### 3.2 Document view: section tree + snippets

**Decision: the document view is fed by two endpoints, not one mega-endpoint.** The
progressive-collapse UI (frontend §4–5) renders from a flat list of light section rows *with both
summaries inlined* plus the full frontier snippet list; only leaf prose is lazy. Two endpoints
match the client's two query keys and the SSE patch granularity exactly (a `snippet.created`
event patches one cache entry, not a composite blob). *Rejected:* a single nested
`GET /document` response — saves one request at open but forces full-document invalidation
semantics and a bespoke nested shape the SSE reducer would have to dig through.

| Method & path | Req → Res | Notes |
|---|---|---|
| `GET /api/works/:w/sections` | → `SectionRow[]` | **Flat array, document order** (`parentId` links; client builds the tree). Includes `shortSummary` + `longSummary` text inline, staleness flags, `hasIllustration` + `illustrationVersion` + image `width/height`. A 60-chapter work is < 1 MB — one request, zero waterfall (frontend §4.5). |
| `GET /api/works/:w/sections/:s/content` | → `{markdown, contentHash}` | Leaf prose, lazy-fetched at fold `full`. `404 not_found` for interior sections. |
| `PATCH /api/works/:w/sections/:s/content` | `{markdown, baseHash}` → `{contentHash}` | Optimistic concurrency: `409 conflict` when `baseHash` ≠ current (data-model §6.5 staleness rules fire server-side). |
| `PATCH /api/works/:w/sections/:s` | `{title}` → `SectionRow` | Sets `titleSource: "user"` — never clobbered by enrichment afterwards. |
| `PUT /api/works/:w/sections/:s/summaries` | `{short?, long?}` → `SectionRow` | **User edit of enrichments.** Writes `summary-{short,long}.md`, records `author: "user"` + current `sourceHash` (so a user-edited summary is *not stale* until the prose changes again). Requires a small data-model extension (§13-D3). |
| `GET /api/works/:w/sections/:s/history` | → `ConsolidatedSnippet[]` | Frozen-prose provenance from `history.jsonl`. Structured-for; UI ships M2. |

Enrichment *regeneration* is not a PUT — it's a task (`POST /tasks {kind:"enrich-section"}`),
keeping "user writes" and "agent writes" on separate, provenance-correct paths.

### 3.3 Snippets: CRUD, revisions, rollback

| Method & path | Req → Res | Notes |
|---|---|---|
| `GET /api/works/:w/snippets` | → `SnippetDto[]` | All frontier snippets, full text (they're small), ordered by `orderKey`. |
| `POST /api/works/:w/snippets` | `{text, afterSnippetId?}` → `201 SnippetDto` | Default append at frontier end; `afterSnippetId` for rare mid-frontier insert. `authorship: "user"`. |
| `PATCH /api/works/:w/snippets/:s` | `{text, baseRev}` → `SnippetDto` | One call = one revision (frontend A3 resolution: explicit commit; the server does **not** debounce). `409 conflict` on stale `baseRev`. |
| `DELETE /api/works/:w/snippets/:s` | → `204` | Revision log file removed with it (frontier only). |
| `GET /api/works/:w/snippets/:s/revisions` | → `RevisionEvent[]` | Full texts, oldest first (data-model §10). |
| `POST /api/works/:w/snippets/:s/restore` | `{rev}` → `SnippetDto` | Appends a **new** revision whose text is revision `rev` — history is never rewritten. |

### 3.4 World-info entries

| Method & path | Req → Res | Notes |
|---|---|---|
| `GET /api/works/:w/world` | → `WorldEntryDto[]` | List with `name, keys, shortSummary, hasImage, imageVersion` and full `body` (entries are small; one fetch powers list, hovercards, and the key matcher). |
| `POST /api/works/:w/world` | `{name, keys, body?, shortSummary?}` → `201 WorldEntryDto` | |
| `PATCH /api/works/:w/world/:e` | `{name?, keys?, body?, shortSummary?, baseHash?}` → `WorldEntryDto` | `409` on stale `baseHash` when body is being replaced. |
| `DELETE /api/works/:w/world/:e` | → `204` | Deletes entry file + its image. |
| `POST /api/works/:w/world/:e/image` | raw `image/png` body (≤ 10 MB) → `{imageVersion}` | User upload. Generation goes through `POST /tasks {kind:"world-image"}`. |
| `DELETE /api/works/:w/world/:e/image` | → `204` | |

### 3.5 Situation pane

The situation is a per-work singleton markdown scratchpad, stored at `<work>/situation.md`
(new file in the data-model layout — flagged §13-D4).

| Method & path | Req → Res | Notes |
|---|---|---|
| `GET /api/works/:w/situation` | → `{text, updatedAt}` | Empty string when absent. |
| `PUT /api/works/:w/situation` | `{text}` → `{updatedAt}` | Atomic replace; client debounces 1 s (frontend §9.1). Emits `situation.changed`. |

### 3.6 Tasks (agent work)

The harness (agent-harness §8) owns semantics; routes registered here.

| Method & path | Req → Res | Notes |
|---|---|---|
| `POST /api/works/:w/tasks` | `TaskSpec` → `202 Task` | All kinds: `continue`, `instructed-continue`, `quick-edit`, `edit-task`, `enrich-section`, `illustrate-section`, `world-image` (+ internal `propose-boundaries`). `409 busy` (`{runningTaskId}` in details) when the interactive lane is occupied. `409 config_missing` when the routed lane has no endpoint configured. |
| `GET /api/works/:w/tasks` | → `Task[]` | Queued + running + last 50 terminal (in-memory; older outcomes live in runs). |
| `GET /api/works/:w/tasks/:t` | → `Task` | Includes `partialText` on terminal error/cancel — the reconnect path for "keep partial" after a resync. |
| `POST /api/works/:w/tasks/:t/cancel` | → `202 Task` | Idempotent; cancels queued (removal) or running (abort). |
| `POST /api/works/:w/tasks/estimate` | `TaskSpec` → `TaskEstimate` | Dry-run context assembly + cost math (harness §9). Used by the edit-task pane's pre-launch line; the *live* meter uses `/context/preview` (§3.9), which skips cost and prompt templating for the 300 ms debounce loop. |
| `POST /api/works/:w/tasks/:t/proposal/apply` / `…/discard` | → `Task` | Conflict-card / keep-partial resolution (harness §5.6, §6.4); proposal held in memory 30 min. |

### 3.7 Agent runs (provenance)

| Method & path | Req → Res | Notes |
|---|---|---|
| `GET /api/works/:w/runs/:r` | → `RunEvent[]` | Parsed run JSONL (harness §7 schema); powers the provenance timeline. |
| `GET /api/works/:w/runs?artifact=<kind>:<id>&limit=20` | → `RunSummary[]` | Via `run_artifacts` index; `RunSummary` = meta + status + usage, no transcript. |
| `GET /api/works/:w/usage?since=<iso>` | → `UsageRollup` | Token/cost sums per kind per day (harness §9). |

### 3.8 Images

| Method & path | Res | Notes |
|---|---|---|
| `GET /api/works/:w/sections/:s/illustration?v=<ver>` | `image/png` | `Cache-Control: public, max-age=31536000, immutable` + `ETag`. The `v` param (from `SectionRow.illustrationVersion`, the enrichment `sourceHash`-derived version) makes browser caching exact; `enrichment.updated` bumps it. `404` when absent. |
| `GET /api/works/:w/world/:e/image?v=<ver>` | `image/png` | Same policy. |

Files are streamed from disk (`reply.sendFile` via a per-work `@fastify/static` root is rejected —
paths are computed from index rows, so a tiny read-stream handler with path containment checks
(`resolved path must be inside the work dir`) is safer and simpler.

### 3.9 Context engine (mounted from context-engine §9.2, unchanged)

`GET /api/works/:w/context/state` · `GET …/context/candidates` · `POST …/context/preview` ·
`POST …/context/reset` · `GET …/context/usage?limit=100`

### 3.10 Config & meta

| Method & path | Req → Res | Notes |
|---|---|---|
| `GET /api/health` | → `{ok: true, version, uptime}` | Also the Playwright/Docker readiness probe. |
| `GET /api/config` | → `PublicConfig` | **Redacted**: `apiKey` fields become `{set: boolean}`. Includes `setup: {highConfigured, lowConfigured, comfyConfigured}` for the first-run screen. |
| `PUT /api/config` | `ConfigUpdate` → `{config: PublicConfig, restartRequired: string[]}` | Validates, writes the file atomically, hot-applies what it can (§8.5). `apiKey: null` in the update = "keep existing". |
| `POST /api/config/test` | `{target: "high"\|"low"\|"comfyui", candidate?: ConfigUpdate}` → `ProbeResult` | Live probe: models → `GET {baseUrl}/models` then a 1-token chat ping; ComfyUI → `GET /system_stats`. `candidate` lets the setup screen test *before* saving. |
| `POST /api/config/reload` | → same as PUT response | Re-reads the file from disk (for hand-editors); no fs-watcher (§8.5). |

### 3.11 Events

| Method & path | Notes |
|---|---|
| `GET /api/works/:w/events` | The one SSE stream per open work (§7). |

---

## 4. Fastify wiring

### 4.1 Server directory layout (`apps/server/src`)

```
src/
  index.ts               # CLI entry: flags → loadConfig → buildApp → listen → open browser
  app.ts                 # buildApp(deps): registers plugins + routes; pure function, test target
  deps.ts                # composition root: ConfigService, StorageService, ContextEngine,
                         #   AgentService, EventBus — everything injected, everything mockable
  config/
    load.ts              # locate → read JSONC → ${env:} interpolate → Zod parse → defaults
    service.ts           # ConfigService: current(), update(), reload(), subscribe()
    firstRun.ts          # write commented template on first start
    routes.ts            # §3.10 config endpoints + probes
  http/
    zod.ts               # fastify-type-provider-zod setup (validator+serializer compilers)
    errors.ts            # AppError class, ErrorCode→status map, global error handler
    static.ts            # serve apps/web/dist + SPA fallback + missing-dist page
    routes/
      works.ts sections.ts snippets.ts world.ts situation.ts images.ts health.ts
  events/
    bus.ts               # per-work EventBus: publish(), ring buffer, subscriber mgmt (§7)
    routes.ts            # GET /events: negotiate Last-Event-ID, replay or resync, heartbeat
  agents/ …              # agent-harness §10 (its routes.ts registers under /api here)
  context/ …             # context-engine §10 (same)
  storage/ …             # data-model subsystem
```

### 4.2 Zod ↔ Fastify

**Decision: `fastify-type-provider-zod`.** Route options carry the shared schemas directly
(`schema: { body: TaskSpec, response: { 202: Task } }`); the validator compiler rejects bad input
with our envelope, and the **serializer compiler runs responses through Zod too**, so a handler
returning a malformed DTO fails loudly in dev instead of shipping a contract break. *Rejected:*
manual `.parse()` in every handler (boilerplate, easy to skip on responses); `ts-rest`/`zodios`
(fine libraries, but a 60-line route-registry of our own keeps the dependency surface flat).

Every route's schemas come from `packages/shared` — enforced by a lint-adjacent unit test that
walks the Fastify route table and asserts each schema object is identity-equal to a shared export.

### 4.3 Other plugins

`@fastify/static` (web dist, `wildcard: false` + explicit SPA fallback for non-`/api` GETs),
`@fastify/compress` (JSON only), Fastify's built-in JSON body parser with a 2 MB limit (a 20k-word
section PATCH is ~130 KB; 2 MB is generous), a raw-body content-type parser for `image/png`
(10 MB limit). **No CORS plugin**: prod is same-origin; dev uses Vite's proxy so the browser never
crosses origins. **No auth, no rate limiting, no helmet** — localhost, single user, per the brief's
non-goals (a plain `X-Content-Type-Options: nosniff` header is set; that's it).

---

## 5. `packages/shared`: the single contract

### 5.1 Layout

```
packages/shared/src/
  index.ts               # re-exports everything below
  ids.ts                 # Ulid, OrderKey, IsoTime, Hash (data-model §10 owns definitions)
  errors.ts              # ErrorCode, ApiErrorBody (§6)
  work.ts                # WorkMeta, WorkSettings, WorkSummary, WorkDetail
  sections.ts            # SectionRow, SectionContent, SummariesUpdate, ConsolidatedSnippet
  snippets.ts            # SnippetDto, SnippetCreate, SnippetPatch, RevisionEvent, RestoreReq
  world.ts               # WorldEntryDto, WorldEntryCreate, WorldEntryPatch
  situation.ts           # SituationDto
  agents.ts              # TaskKind, TaskSpec, Task, RunEvent, RunSummary, TaskEstimate,
                         #   UsageRollup (agent-harness §2.1/§7/§9 — source of truth lives here)
  context/
    schema.ts budget.ts  # context-engine §2/§8 (unchanged)
  events.ts              # WorkEvent — the SSE union (§7.2)
  config.ts              # AppConfig, PublicConfig, ConfigUpdate, ProbeResult (§8)
  api.ts                 # the route registry (§5.2)
  tokens.ts              # gpt-tokenizer estimator wrapper (context-engine A4)
```

Consumed **as TS source** (`exports: { ".": "./src/index.ts" }` — already in the scaffold); no
build step, tsx and Vite both handle it.

### 5.2 Route registry

One typed table binds paths to schemas, consumed by the web client wrapper (typed `call(api.x)`)
and by the server-side contract test:

```ts
// packages/shared/src/api.ts
export const api = {
  listSnippets: {
    method: "GET",
    path: (w: string) => `/api/works/${w}/snippets`,
    res: z.array(SnippetDto),
  },
  patchSnippet: {
    method: "PATCH",
    path: (w: string, s: string) => `/api/works/${w}/snippets/${s}`,
    body: SnippetPatch, res: SnippetDto,
  },
  createTask: {
    method: "POST",
    path: (w: string) => `/api/works/${w}/tasks`,
    body: TaskSpec, res: Task,          // 202
  },
  // … every endpoint in §3, ~40 entries
} as const;
```

The web `api/client.ts` is then ~50 lines: build URL, fetch, parse error envelope, `res.parse()`
the body. A contract break is a thrown ZodError at the boundary in dev (frontend §13).

### 5.3 Naming reconciliation (binding decisions)

- **Task kinds are kebab-case** (`instructed-continue`, `quick-edit`) everywhere — the harness's
  `TaskKind` enum is canonical; frontend sketches using snake_case update to import it.
- **SSE event names are dot-case** (`snippet.created`) — the frontend's vocabulary is canonical.
- `FoldLevel` (web) ≡ `Fidelity` (context engine) — one export, `Fidelity`, aliased in web code.

---

## 6. Error envelope

One shape for every non-2xx JSON response:

```ts
// packages/shared/src/errors.ts
export const ErrorCode = z.enum([
  // request-shaped
  "validation",            // 400 — Zod issues in details
  "not_found",             // 404
  "conflict",              // 409 — stale baseRev/baseHash; details: {currentRev|currentHash}
  "busy",                  // 409 — interactive lane occupied; details: {runningTaskId}
  "readonly",              // 409 — second-instance lock (data-model §9.3)
  "payload_too_large",     // 413
  // task/agent (harness §11, surfaced at task-create or via SSE)
  "config_missing", "auth", "endpoint_unreachable", "rate_limited",
  "timeout", "output_invalid", "pipeline", "crash",
  // catch-all
  "internal",              // 500 — includes a logRef ULID printed to the server console
]);

export const ApiErrorBody = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),               // human-readable, safe to toast
    details: z.unknown().optional(),   // structured extras, schema per code
  }),
});
```

Rules: the Fastify global error handler maps `AppError(code, message, details)` → status via a
closed table; anything unrecognized becomes `internal` with a `logRef` so the toast and the
console line can be matched. Zod validation failures include `details: z.treeifyError(err)`.
Handlers never hand-build error JSON. The same `ErrorCode` enum is reused inside SSE
`task.failed` events — one taxonomy, one UI mapping (harness §11 table).

---

## 7. SSE design

### 7.1 Decision: one stream per **work**, everything multiplexed

`GET /api/works/:w/events` is the only stream. Task lifecycle, token deltas, snippet/section/world
mutations, enrichment updates, and illustration progress all ride it, tagged with IDs.

Why per-work and not per-task (this **supersedes** agent-harness §8's
`GET /tasks/:taskId/events` — flagged §13-D1): the client needs background-task events
(enrichment finishing, consolidation applying, world proposals) even when *it* started nothing,
so a work stream must exist anyway; a second per-task stream would mean two connections, two
resume cursors, and event-ordering races between them (e.g. `task.artifact` vs `snippet.created`).
One connection, one monotonic cursor, strict global order per work. *Rejected:* one global stream
for all works (works are independent; no client views two at once); WebSockets (bidirectional
adds nothing — all client→server traffic is plain REST — and SSE is fixed by the brief).

### 7.2 Event vocabulary

The wire format is standard SSE: `id:` = resume cursor (§7.3), `event:` = type, `data:` = JSON
payload validated by `WorkEvent`:

```ts
// packages/shared/src/events.ts
export const WorkEvent = z.discriminatedUnion("type", [
  // ---- domain mutations (payload sufficient to patch the client cache, no refetch) ----
  z.object({ type: z.literal("snippet.created"),  snippet: SnippetDto }),
  z.object({ type: z.literal("snippet.revised"),  snippet: SnippetDto }),
  z.object({ type: z.literal("snippet.deleted"),  id: Ulid }),
  z.object({ type: z.literal("section.changed"),  section: SectionRow }),
  z.object({ type: z.literal("sections.restructured") }),                  // reorder/split/merge
  z.object({ type: z.literal("consolidation.applied"),
             sectionIds: z.array(Ulid), title: z.string(), undoToken: z.string() }),
  z.object({ type: z.literal("consolidation.undone"), sectionIds: z.array(Ulid) }),
  z.object({ type: z.literal("enrichment.updated"), sectionId: Ulid,
             kind: z.enum(["title","short","long","illustration"]),
             section: SectionRow }),                                       // fresh row inline
  z.object({ type: z.literal("world.changed"),    entryId: Ulid.optional() }), // undefined ⇒ refetch list
  z.object({ type: z.literal("situation.changed"), text: z.string() }),
  z.object({ type: z.literal("readonly.changed"), readonly: z.boolean(), reason: z.string() }),

  // ---- task lifecycle (taskId on every event; runId == taskId) ----
  z.object({ type: z.literal("task.queued"),    task: Task, position: z.number().int() }),
  z.object({ type: z.literal("task.started"),   task: Task,
             target: z.object({ kind: z.enum(["frontier","snippet","section","entry"]),
                                id: Ulid.optional() }) }),
  z.object({ type: z.literal("task.stage"),     taskId: Ulid, stage: z.enum(["planning","writing"]) }),
  z.object({ type: z.literal("task.tool"),      taskId: Ulid, name: z.string(), label: z.string() }),
  z.object({ type: z.literal("task.delta"),     taskId: Ulid, target: z.string(), text: z.string() }),
  z.object({ type: z.literal("task.retrying"),  taskId: Ulid, attempt: z.number().int(), reason: z.string() }),
  z.object({ type: z.literal("task.progress"),  taskId: Ulid,                 // illustration pipeline
             stage: z.enum(["prompting","generating","reviewing"]),
             attempt: z.number().int(), maxAttempts: z.number().int() }),
  z.object({ type: z.literal("task.artifact"),  taskId: Ulid, artifact: RunArtifact }),
  z.object({ type: z.literal("task.usage"),     taskId: Ulid, promptTokens: z.number().int(),
             completionTokens: z.number().int(), costUsd: z.number().nullable() }),
  z.object({ type: z.literal("task.completed"), taskId: Ulid }),
  z.object({ type: z.literal("task.cancelled"), taskId: Ulid, partialText: z.string().nullable() }),
  z.object({ type: z.literal("task.failed"),    taskId: Ulid, code: ErrorCode, message: z.string(),
             partialText: z.string().nullable(), retryable: z.boolean() }),

  // ---- stream control ----
  z.object({ type: z.literal("hello"),  streamId: z.string(), seq: z.number().int() }),
  z.object({ type: z.literal("resync") }),   // client must invalidate all work queries
]);
```

Notes:

- Domain events fire for **every** mutation regardless of origin (REST call, agent commit,
  reconciler adoption of an external edit) — the storage layer publishes them via the `EventBus`
  hook it exposes to this subsystem. The client's echo-dedupe (`(id, rev)` check) handles its own
  optimistic writes (frontend §12).
- `task.delta` is throttled server-side to ≤ 30 events/s per task (coalescing buffer) — a token
  firehose at 100+/s wastes both sides; the UI flushes at 30 fps anyway.
- Heartbeat: an SSE comment line (`:hb`) every **15 s**; the client treats 2 misses as a dead
  connection (frontend §4.3).

### 7.3 Resume and missed-event strategy

**Decision: in-memory ring buffer + `Last-Event-ID` resume, with REST resync as the fallback.**
No persisted event log — the durable records (files, index, run JSONL) already exist; a second
durable log would be a consistency liability for a rare tab-refresh race (same call as harness §8.2).

Mechanics:

- Per work: `streamId` (ULID minted when the work's bus is created, i.e. per server process) and
  a monotonically increasing `seq`. The SSE `id:` field is `"<streamId>:<seq>"`.
- Ring buffer: last **4,096 events or 10 minutes**, whichever is smaller (a streaming task at
  30 deltas/s fills 4,096 in ~2 min — enough for any realistic reconnect; memory cost is a few MB).
- On connect **without** `Last-Event-ID`: emit `hello {streamId, seq}` and stream from now. The
  client then does its normal initial REST loads — no replay needed.
- On connect **with** `Last-Event-ID`:
  - `streamId` matches and `seq` is in the buffer → replay the gap, then live. Seamless.
  - `streamId` mismatch (server restarted) or `seq` fell out of the buffer → emit `resync`; the
    client invalidates all `["work", w]` queries and refetches (brute force is fine on localhost —
    frontend §4.3 already implements exactly this). In-flight-task state after a server restart is
    re-derived from `GET /tasks` + `GET /tasks/:t` (which carries `partialText` for keep/discard).

The reducer contract (frontend §4.3 table) is normative: every payload above was chosen so its row
patches the cache without a follow-up fetch, except the two deliberate refetch signals
(`sections.restructured`, `world.changed` with no `entryId`).

---

## 8. Configuration

### 8.1 Files and precedence

```
~/.cowrite/                         # $COWRITE_HOME overrides the whole directory
  config.jsonc                      # THE config file (commented JSONC)
  workflows/                        # ComfyUI workflow JSON files, referenced by config
    scene-v1.json
    portrait-v1.json
~/Cowrite/                          # dataDir (config.storage.dataDir): one subdir per work
  <work-slug>/…                     # data-model §5.2 layout
```

Precedence, lowest to highest: **schema defaults → `config.jsonc` → environment variables →
CLI flags.** Per-work tunables (consolidation thresholds, `contextOverrides`) live in each
work's `work.json` (data-model §10) and are edited via `PATCH /works/:w` — the app-level config
never contains per-work state.

**Format decision: JSONC** (JSON with comments/trailing commas) parsed by `jsonc-parser`
(the VS Code parser, zero deps). A hand-edited config file needs comments; the first-run template
is mostly comments. *Rejected:* YAML (whitespace footguns for exactly the audience that will
paste API keys at midnight), TOML (another syntax for no gain), plain JSON (no comments),
`.env` (flat; can't express workflow registries).

Secrets: `apiKey` values support `${env:VAR}` interpolation (harness §3.1) and may also be stored
verbatim — this is a single-user local file with `0600` perms on POSIX; a keychain integration is
out of scope. `GET /api/config` always redacts.

### 8.2 Schema (`packages/shared/src/config.ts`)

```ts
export const ModelEndpoint = z.object({
  baseUrl: z.string().url(),                    // ".../v1" — OpenAI-compatible root
  apiKey: z.string().default(""),               // "" for keyless local servers
  model: z.string().min(1),
  maxOutputTokens: z.number().int().positive().default(2048),
  temperature: z.number().min(0).max(2).default(0.8),
  promptCostPerMTok: z.number().nonnegative().nullable().default(null),
  completionCostPerMTok: z.number().nonnegative().nullable().default(null),
});

export const ComfyWorkflow = z.object({
  file: z.string(),                             // relative to ~/.cowrite/workflows/
  promptNodeId: z.string(),                     // node whose input receives the NL prompt
  promptField: z.string().default("text"),
  timeoutMs: z.number().int().positive().default(600_000),
});

export const AppConfig = z.object({
  schemaVersion: z.literal(1),
  server: z.object({
    host: z.string().default("127.0.0.1"),
    port: z.number().int().min(1).max(65535).default(2697),   // C-O-W-R on a phone keypad
    openBrowser: z.boolean().default(true),
  }).default({}),
  storage: z.object({
    dataDir: z.string().default("~/Cowrite"),   // "~" expanded at load
  }).default({}),
  models: z.object({
    high: ModelEndpoint.nullable().default(null),   // null ⇒ unconfigured ⇒ setup screen
    low:  ModelEndpoint.nullable().default(null),
  }).default({}),
  comfyui: z.object({
    baseUrl: z.string().url(),
    workflows: z.record(z.string(), ComfyWorkflow),  // name → workflow
    use: z.object({                                  // which workflow per image kind
      section: z.string().default("scene-v1"),
      world:   z.string().default("portrait-v1"),
    }).default({}),
  }).nullable().default(null),
  routing: z.record(TaskKind, z.enum(["high","low"])).default({}),  // harness §3.1 overrides
  budgets: BudgetKnobs.partial().default({}),        // context-engine §8.1 app-level overrides
  harness: HarnessKnobs.partial().default({}),       // timeouts/retries, harness §6.3
  retention: z.object({
    pruneRunsAfterMonths: z.number().int().positive().nullable().default(null),
  }).default({}),
});

export const PublicConfig = /* AppConfig with every apiKey → { set: boolean }, plus
                               setup: { highConfigured, lowConfigured, comfyConfigured } */;
export const ConfigUpdate = /* deep-partial AppConfig; apiKey: string sets, null keeps */;
```

Soft-budget numbers (`softBudget: 32_000`, `hardCap: 64_000`, `frontierProseTokens: 6_000`, …)
default in `BudgetKnobs` (context-engine §8.1); `config.budgets` overrides app-wide,
`work.json.contextOverrides` per work. One override chain, documented in the template comments.

### 8.3 Environment variables and flags

| Env var | CLI flag | Overrides |
|---|---|---|
| `COWRITE_HOME` | `--home <dir>` | config directory (default `~/.cowrite`) |
| `COWRITE_CONFIG` | `--config <file>` | exact config file path |
| `COWRITE_DATA_DIR` | `--data-dir <dir>` | `storage.dataDir` |
| `COWRITE_HOST` | `--host <addr>` | `server.host` |
| `COWRITE_PORT` | `--port <n>` | `server.port` |
| `COWRITE_LLM_HIGH_BASE_URL` / `_API_KEY` / `_MODEL` | — | `models.high.*` |
| `COWRITE_LLM_LOW_BASE_URL` / `_API_KEY` / `_MODEL` | — | `models.low.*` |
| `COWRITE_COMFYUI_BASE_URL` | — | `comfyui.baseUrl` |
| `COWRITE_MOCK_LLM=1` | `--mock` | boot in-process mock LLM + ComfyUI, point both lanes at them (testing/e2e) |
| — | `--no-open` | suppress browser open |

Env overrides exist chiefly for Docker and CI; humans edit the file or the settings screen.

### 8.4 First-run experience

1. `pnpm start` with no `~/.cowrite/config.jsonc` → `firstRun.ts` writes the commented template
   (all models `null`, sample workflow entries commented out) and creates `dataDir`. The server
   **starts anyway** — browsing/creating works and writing by hand must work with zero endpoints
   configured (harness §3.1: read-only-of-agents, not read-only-of-app).
2. The web app calls `GET /api/config`; `setup.highConfigured === false` routes to the **setup
   screen**: three cards (High model / Low model / ComfyUI — the third skippable), each with
   baseUrl / apiKey / model fields and a **Test** button hitting `POST /api/config/test` with the
   unsaved candidate. Save → `PUT /api/config` → into the app.
3. Any later attempt to run a task on an unconfigured lane returns `409 config_missing`, which
   the UI renders as a callout linking back to settings (harness §11).

Console output on every start (both first run and after) prints the three lines that matter:

```
cowrite v0.1.0
  config   ~/.cowrite/config.jsonc        (high: ok · low: ok · comfyui: not configured)
  data     ~/Cowrite                      (3 works)
  ➜ http://127.0.0.1:2697
```

### 8.5 Live-reload policy

**Decision: hot-apply on `PUT`/`reload`; no filesystem watcher; two fields restart-required.**

- Hot-appliable (read at point of use, so a swap of the `ConfigService`'s current snapshot is
  enough): `models.*`, `comfyui.*`, `routing`, `budgets`, `harness`, `retention`,
  `server.openBrowser`. **In-flight tasks keep the config they started with** (the runner captures
  a snapshot at task start — no mid-run endpoint switcheroo).
- Restart-required: `server.host`, `server.port` (rebinding a live listener isn't worth the
  code), `storage.dataDir` (every open work handle points into it). `PUT` still persists them and
  returns `restartRequired: ["server.port", …]`; the UI shows "restart Cowrite to apply".
- Hand-editors press the settings screen's "Reload from disk" (`POST /api/config/reload`) or just
  restart. *Rejected:* fs-watch auto-reload — silent behavior changes mid-session are spooky, and
  editors write partial files; an explicit action is one click.
- An **invalid config file at startup is fatal**: print the Zod issues with line hints and exit 1.
  Starting with silently-dropped config is worse than not starting. (A *missing* file is the
  first-run path, never fatal.)

---

## 9. Deployment & packaging

### 9.1 Console app: production start

```
git clone … && cd cowrite
pnpm install
pnpm build        # builds apps/web/dist (server has no build step — tsx runtime)
pnpm start        # = pnpm --filter @cowrite/server start = tsx src/index.ts
```

`index.ts` startup sequence:

```
parse flags → resolve config (env/flags over file) → validate (fatal if invalid)
→ buildApp(deps) → check apps/web/dist exists
     (missing ⇒ log "run `pnpm build` first" and serve a self-contained fallback page
      saying the same — dev-friendliness, not a crash)
→ listen(host, port)
     EADDRINUSE ⇒ "port 2697 is in use — pass --port or edit server.port" ; exit 1
→ print banner (§8.4) → if openBrowser && TTY: spawn platform opener
     (win32: `start`, darwin: `open`, linux: `xdg-open`; failure is a logged shrug)
→ SIGINT/SIGTERM: stop accepting, cancel running tasks (abort → run files finalized),
  flush storage, close SSE with a final comment, exit
```

Static serving: `@fastify/static` on `apps/web/dist` with `index.html` fallback for any non-`/api`
GET (SPA routes like `/w/:id/runs/:rid` must deep-link). `index.html` is served `no-cache`;
hashed Vite assets are `immutable`.

If `server.host` is not a loopback address, log a red warning banner — "Cowrite has no
authentication; anyone who can reach this port can read and edit your works" — and continue
(Docker legitimately sets `COWRITE_HOST=0.0.0.0`; the explicit env/flag *is* the opt-in).

*Rejected packaging alternatives:* publishing an npx-able `cowrite` bin (nice later; a git clone
is the SillyTavern-style story the brief points at, and MVP shouldn't own an npm release
pipeline yet — **structured-for**: `apps/server/package.json` can grow a `bin` field without
moving code); `pkg`/SEA single binaries (fight tsx and native better-sqlite3 for no audience need).

### 9.2 Dev mode

`pnpm dev` (root script, already scaffolded) runs both in parallel:

- `@cowrite/server`: `tsx watch src/index.ts` on **:2697** — restarts on server/shared changes;
  prompt templates hot-reload with it (harness §10).
- `@cowrite/web`: `vite` on **:5173** with a proxy so dev and prod share URLs (frontend A8):

```ts
// apps/web/vite.config.ts
server: {
  proxy: {
    "/api": {
      target: "http://127.0.0.1:2697",
      // SSE: http-proxy streams responses by default; keep buffering off and
      // disable proxy timeouts for the events route.
      configure: (proxy) => proxy.on("proxyReq", (pr) => pr.setHeader("accept-encoding", "identity")),
      timeout: 0, proxyTimeout: 0,
    },
  },
},
```

Caveat documented in the README: a tsx-watch restart drops SSE connections; the web client's
backoff-reconnect + resync (§7.3) makes this a non-event in practice.

### 9.3 Windows + Linux parity

| Concern | Rule |
|---|---|
| Native deps | Exactly one: `better-sqlite3`, which ships prebuilt binaries for win32/linux/darwin x64+arm64 on Node 22. No node-gyp toolchain required for users. |
| Paths | `node:path` everywhere; work-relative paths in DTOs/index always use `/` (normalized at the storage boundary). No path enters a shell. |
| Atomic writes | Owned by storage (data-model §9.1: POSIX rename vs Windows `ReplaceFile` semantics); the API layer never touches files directly except streamed image reads. |
| npm scripts | No shell-isms (`&&` is fine; no `$VAR`, no `cp -r`). Anything conditional is a `node scripts/*.mjs`. Env-dependent invocations (e.g. Playwright's server command) set env via config files, not inline `FOO=1` syntax. |
| `~` expansion | Done in `config/load.ts` via `os.homedir()` — shells don't expand it in JSONC. |
| Line endings | `.gitattributes` forces `*.ts *.json *.md text eol=lf`; Biome enforces LF. |
| Sockets | Default host `127.0.0.1` explicitly (not `localhost`) to dodge Windows IPv6 (`::1`) resolution surprises between fetch and listen. |
| Signals | SIGINT works on both; Windows gets no SIGTERM — the console `close` event path runs the same shutdown function. |
| Playwright | `webServer.command` in `playwright.config.ts` is a plain `pnpm` invocation with `env: {...}` in the config object (not inline shell env), so it runs unmodified on Windows runners. |

CI runs the unit/integration suite on `ubuntu-latest` **and** `windows-latest`; e2e on Linux only
(MVP), Windows e2e deferred.

### 9.4 Dockerfile (dev-capable)

Already present at the repo root; reproduced here as the normative sketch. Multi-stage: `dev` has
the full toolchain + Chromium for in-container Playwright; `runtime` (default) builds the web app
and runs the server.

```dockerfile
FROM node:22-bookworm AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

FROM base AS dev
# Chromium + system deps for Playwright e2e runs inside the container.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
RUN npx -y playwright@latest install --with-deps chromium
COPY . .
RUN pnpm install --frozen-lockfile
EXPOSE 2697 5173
CMD ["bash"]

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM base AS runtime
COPY --from=build /app /app
ENV COWRITE_HOST=0.0.0.0            # container-internal; publish to 127.0.0.1 on the host
ENV COWRITE_DATA_DIR=/data
EXPOSE 2697
CMD ["pnpm", "start"]
```

Usage:

```bash
# run the app
docker build -t cowrite . && docker run -p 127.0.0.1:2697:2697 -v cowrite-data:/data cowrite
# hack on it (mount sources, real endpoints via env)
docker build --target dev -t cowrite-dev .
docker run -it -p 2697:2697 -p 5173:5173 -v "$PWD":/app -v cowrite-data:/data \
  -e COWRITE_LLM_HIGH_BASE_URL=… -e COWRITE_LLM_HIGH_API_KEY=… cowrite-dev bash
```

Config inside containers comes from env vars (§8.3) — no config file needed; `/data` is the only
volume that matters. Model/ComfyUI endpoints on the host are reachable via
`host.docker.internal` (documented in the README; on Linux add
`--add-host=host.docker.internal:host-gateway`).

---

## 10. Failure modes

| Failure | Behavior |
|---|---|
| Invalid config file at startup | Fatal with pretty Zod issues + file/line hints (jsonc-parser gives offsets). Missing file = first-run path, never fatal. |
| Port in use | Fatal with actionable message (`--port` hint). |
| `dataDir` missing/unwritable | Created if missing; unwritable ⇒ fatal with the path printed. |
| `PUT /api/config` with invalid body | `400 validation`, file untouched (validate-then-write; write is atomic tmp+rename). |
| Config endpoint probe hangs | `POST /config/test` has its own 10 s timeout; returns `{ok:false, code:"timeout"}` — never blocks the event loop. |
| SSE client falls behind / server restarted | Ring-buffer miss ⇒ `resync` event ⇒ client invalidates all work queries; task state re-derived from `GET /tasks[/:t]` (§7.3). |
| Handler returns off-contract DTO | Serializer-side Zod failure ⇒ `500 internal` + loud dev log — contract breaks cannot ship silently. |
| Image path escape attempt | Streamed image handler resolves and containment-checks against the work dir; failure ⇒ `404`. |
| Oversized body | 413 `payload_too_large` (2 MB JSON / 10 MB PNG caps). |
| Web assets missing (fresh clone, no build) | Fallback page with build instructions; API fully live (agents/e2e can run headless). |
| Version skew (stale tab after upgrade) | Client Zod parse fails ⇒ "reload" toast (frontend §13); `GET /api/health.version` lets the client detect skew proactively after reconnect. |
| Two server instances on one work | Storage lockfile ⇒ second instance serves the work read-only; `readonly.changed` event + `409 readonly` on mutations. |

---

## 11. Testability

- **Route integration tests (Vitest):** `buildApp(deps)` with real storage on a temp dir and the
  mock LLM in-process; drive via `app.inject()` (no sockets). Golden coverage: every endpoint in
  §3 has at least a happy-path + one failure-path test asserting the envelope.
- **SSE tests:** inject a raw request with `accept: text/event-stream`, parse frames, assert:
  ordering (domain event follows its REST 2xx), `Last-Event-ID` replay byte-exactness, buffer
  overflow ⇒ `resync`, heartbeat cadence (fake timers).
- **Contract test:** walk Fastify's route table; every schema must be identity-equal to a
  `packages/shared` export, and every `api.ts` registry entry must have a registered route (and
  vice versa). This is the drift fence.
- **Config tests:** table-driven precedence (defaults < file < env < flags), `${env:}`
  interpolation, redaction round-trip (`PUT` of a redacted `GET` body is a no-op), hot-apply vs
  `restartRequired` classification, first-run template parses against `AppConfig`.
- **E2E (Playwright):** boots the real server with `COWRITE_MOCK_LLM=1` + temp data dir
  (frontend §14.2 owns the flows); `GET /api/health` is the readiness URL.
- **Cross-platform CI:** unit/integration on Ubuntu + Windows; `docker build` of both targets on
  Linux as a smoke job.

---

## 12. MVP cut

**Ships first (M1):**

- Full endpoint table §3 **except** the items below; SSE per-work stream with ring-buffer resume,
  heartbeats, resync; error envelope + closed `ErrorCode`
- `packages/shared` layout, route registry, `fastify-type-provider-zod` wiring, contract test
- Config: JSONC file + env/flag precedence, first-run template + setup screen endpoints
  (`GET/PUT /config`, `POST /config/test`, `POST /config/reload`), hot-apply/restart-required split
- Packaging: `pnpm build && pnpm start` serving built web assets, dev mode with Vite proxy,
  banner + browser-open, graceful shutdown, Windows/Linux parity rules, both Dockerfile targets

**Structured-for, deferred:**

- `POST /tasks/estimate` and the proposal apply/discard routes land with the edit-task pane (M2,
  matching the harness cut; `quick-edit` needs neither). `/context/preview` ships M1 for the meter.
- `GET /sections/:s/history` (frozen provenance UI is M2)
- `GET /usage` rollups beyond per-run figures (per-run usage ships M1 inside run records)
- Trash GC / `.trash` management UI; run pruning knob passthrough
- npm `bin` packaging (`npx cowrite`); Windows e2e in CI; OpenAPI export from the route registry
  (trivial to add later since schemas are already centralized)

**Explicit non-goals honored:** no auth, no multi-tenancy, no HTTPS termination, no rate
limiting, no CORS surface, localhost bind by default with a loud warning otherwise.

---

## 13. Interface assumptions

Decisions and dependencies to cross-check with sibling subsystem owners:

- **D1 — SSE consolidation (supersedes agent-harness §8).** Task events ride the per-work stream
  `GET /works/:w/events` instead of per-task `GET /tasks/:t/events`; the harness's `TaskEvent`
  union is absorbed into `WorkEvent` (§7.2) with `taskId` stamped on. The per-task ring buffer
  becomes one per-work buffer owned by this subsystem's `EventBus`; the harness publishes into it.
  The harness's `/tasks/proposals/:t/*` routes move under `/works/:w/tasks/:t/proposal/*` (they
  were work-scoped in behavior already). Needs harness-owner sign-off.
- **D2 — Task-kind naming.** Kebab-case `TaskKind` (harness §2.1) is canonical; frontend sketches
  using `instructed_continue` etc. import the shared enum instead (frontend §4.4/§4.5).
- **D3 — Data model: user-authored enrichments.** `PUT /sections/:s/summaries` requires
  `EnrichmentMeta` to admit a user author (e.g. `author: "user" | "agent"`, `runId` optional when
  user) so user-edited summaries carry provenance and correct staleness (`sourceHash` = current
  content hash at edit time). Extension to data-model §10.
- **D4 — Data model: situation file.** The situation pane persists at `<work>/situation.md`
  (plain markdown, atomic replace, reconciler-tracked like other work files). New file in the
  data-model layout §5.2; context engine already treats situation as a singleton full-fidelity item.
- **D5 — SectionRow provenance.** `GET /sections` is served from the SQLite index plus enrichment
  file reads (summary texts inlined); requires the index to expose `illustrationVersion` (derived
  from enrichment `sourceHash`) and stored image pixel dimensions (new columns or computed at
  index time from PNG headers) for the frontend's reserved aspect-ratio boxes (frontend A6).
- **D6 — Storage event hook.** `StorageService` exposes an `onChange(workId, event)` subscription
  (or accepts an injected publisher) covering app writes *and* reconciler adoptions, so §7.2
  domain events fire for external edits too. Extension to data-model §13.2's API list.
- **D7 — Context engine routes** (§9.2 there) are mounted verbatim; `POST /context/preview` is
  the live token meter, `POST /tasks/estimate` (M2) wraps the same dry-run with cost math —
  no duplicate estimator logic (harness `estimate.ts` calls the engine).
- **D8 — Config ownership.** This subsystem owns `cowrite` app config (`~/.cowrite/config.jsonc`)
  including the harness's `models`/`routing`/`harness` sections (harness §3.1 sketched them in a
  repo-root `cowrite.config.json`; the file location and JSONC format defined here win) and the
  context engine's app-level `budgets` overrides. Per-work overrides stay in `work.json`.
- **D9 — Illustration pipeline** consumes `comfyui.workflows` entries (`file`, `promptNodeId`,
  `promptField`, `timeoutMs`) resolved and validated at config load; workflow JSON files
  themselves are user-managed under `~/.cowrite/workflows/` and only referenced, never parsed,
  by this subsystem. Progress surfaces as `task.progress` events (§7.2) — pipeline owner to emit.
- **D10 — Frontend contract.** The REST table (§3) and event vocabulary (§7.2) satisfy frontend
  §4.2/§4.3 line-for-line, with renames: `POST /world/:e/image` accepts a raw PNG body (not
  multipart); consolidation undo is exposed as `POST /works/:w/consolidations/:undoToken/undo`
  (one route, omitted from §3 tables for brevity; emits `consolidation.undone`).
- **D11 — Testing subsystem** provides `COWRITE_MOCK_LLM=1` in-process mocks and the
  `POST /__mock/llm/enqueue` control route (mounted only under the flag, never in normal runs).
