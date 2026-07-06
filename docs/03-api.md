# 03 — HTTP API, SSE, Config & Deployment

This document specifies the boundary between the Cowrite server and everything that talks to it:
the REST resource surface, the per-work SSE stream and its canonical event vocabulary, the shared
Zod contract in `packages/shared`, the error envelope, work open/close/delete lifecycle as seen
from the API, the configuration file (format, location, precedence, first-run), and the
deployment story (console start, dev mode, Windows/Linux parity, Docker). Handler *semantics* for
storage, agents, context, and illustration belong to docs 02/05/06/08; this doc owns route
registration, DTO shapes, validation, events, config, and packaging.

## Key decisions

- **One contract, in TypeScript** — every request, response, and event is a Zod schema in
  `packages/shared`, imported as source by server and web; there is no second API description to
  drift.
- **One SSE stream per work, everything multiplexed** — background events must reach a client
  that started nothing, so a work stream must exist anyway; a second per-task stream would add a
  second cursor and cross-stream ordering races.
- **Ring-buffer resume + synthetic snapshots + REST resync** — no persisted event log; a
  reconnecting client gets exact replay when possible, an accumulated-text snapshot per streaming
  target when not, and a full refetch as the floor.
- **Keep-partial is reconstructed from the run JSONL** — proposals survive restarts because the
  run file is the durable record, not because anything is held in memory.
- **JSONC config at `~/.cowrite/config.jsonc`** — a hand-edited file needs comments; env vars and
  flags override it, and the API reports per-field override provenance so the settings screen
  never lies.
- **Host-header allowlist on every request** — the one security measure we ship, because
  DNS rebinding turns an unauthenticated localhost API into a key-exfiltration target.
- **Server computes token estimates; the web renders them** — one estimator (the context
  engine's), so the edit-task meter and the pre-launch estimate can never disagree.
- **Boring deployment** — `pnpm install && pnpm build && pnpm start`, identical on Windows and
  Linux; Docker is a wrapper over the same commands plus two volumes.
- **Delete is a move, never an erase** — works go to `<dataDir>/.trash/`; files are the truth and
  the API never hard-deletes prose.

---

## 1. Principles

1. **The API is a thin skin.** Handlers validate, call in-process services (storage, context
   engine, agent harness, illustration), and shape DTOs. No business logic lives in a route.
2. **SSE keeps the client honest; REST is the resync.** Events carry enough payload to patch the
   client cache without refetch; when resume fails, the answer is "invalidate and refetch," never
   a bespoke catch-up protocol.
3. **Local, single-user, no auth.** Bind `127.0.0.1` by default; non-local binding is an explicit
   opt-in. No sessions, no tokens, no tenancy anywhere in the design. The Host-header allowlist
   (§5.4) is deliberately the only defense we build.
4. **Config is a file the user can read.** One commented JSONC file per install; the UI's
   settings screen is a friendly editor over it, not a separate store.

---

## 2. URL structure and conventions

- All JSON API routes live under `/api`; everything else is static web assets (built
  `apps/web/dist`).
- Work-scoped resources nest under `/api/works/:workId`; `:workId` is the work's ULID. All IDs in
  paths and DTOs are **bare ULIDs**; where a payload must distinguish entity types it carries an
  explicit `kind` field (`'section' | 'snippet' | 'world' | …`) — no id prefixes.
- **JSON in, JSON out**, except: image bytes (`image/png`) and the SSE stream
  (`text/event-stream`).
- Verbs: `GET` reads, `POST` creates/acts, `PATCH` partial update, `PUT` full replace of a
  singleton value, `DELETE` removes. Actions that aren't CRUD (`cancel`, `restore`, `estimate`,
  `preview`, `test`, `reload`, `consolidate`, `undo`) are `POST <resource>/<verb>` — pragmatic
  and greppable.
- Successful responses are the **bare resource** (no `{data: …}` wrapper). Errors always use the
  envelope in §7. `201` for creates, `202` for accepted async work (tasks), `204` for deletes and
  signals.
- Caching: API responses are `Cache-Control: no-store` except image routes (§3.9), which are
  `immutable` behind a version query param.
- No response compression. Gzip buys nothing on a loopback socket and is a known SSE-buffering
  footgun; fewer moving parts wins.

---

## 3. The endpoint surface

Canonical route list. "Schema" names refer to `packages/shared` exports (§6). The Owner column in
prose notes says which subsystem implements the handler body; this subsystem owns registration,
validation, and the DTO shapes.

### 3.1 Works

| Method & path | Req → Res | Notes |
|---|---|---|
| `GET /api/works` | → `WorkSummary[]` | Scans `<dataDir>/works/*/work.json` (index-backed per work). Skips dot-directories (`.trash` in particular). |
| `POST /api/works` | `{title}` → `201 WorkDetail` | Creates directory + `work.json`, acquires lock. |
| `GET /api/works/:w` | → `WorkDetail` | `WorkMeta` + settings + `readonly` flag (lock state). Opens the work (§4.1). |
| `PATCH /api/works/:w` | `{title?, settings?}` → `WorkDetail` | Settings = `WorkMeta.settings` + `contextOverrides` (02 §work.json). |
| `DELETE /api/works/:w` | → `204` | **Moves** the work dir to `<dataDir>/.trash/<slug>-<ts>/` after the teardown sequence in §4.3. Trash GC is manual (deferred); the startup banner prints `.trash` size so it never grows invisibly. |

```ts
export const WorkSummary = z.object({
  id: Ulid, title: z.string(), slug: z.string(),
  wordCount: z.number().int(), snippetCount: z.number().int(), sectionCount: z.number().int(),
  updatedAt: IsoTime,
});
export const WorkDetail = WorkSummary.extend({
  settings: WorkSettings,          // consolidation thresholds + contextOverrides (02)
  levelScheme: z.array(z.string()),
  readonly: z.boolean(),           // second-instance lock (02 §locking)
});
```

### 3.2 Document view: section tree + snippets

The document view is fed by two endpoints, not one mega-endpoint. The progressive-collapse UI
(04 §document view) renders from a flat list of light section rows plus the full frontier snippet
list; only leaf prose and scene-level long summaries are lazy. Two endpoints match the client's
two query keys and the SSE patch granularity exactly (a `snippet.created` event patches one cache
entry, not a composite blob). *Rejected:* a single nested `GET /document` response — saves one
request at open but forces full-document invalidation semantics and a bespoke nested shape the
SSE reducer would have to dig through.

| Method & path | Req → Res | Notes |
|---|---|---|
| `GET /api/works/:w/sections` | → `SectionRow[]` | **Flat array, document order** (`parentId` links; client builds the tree). Inlines `shortSummary` for every section and `longSummary` for sections at or above chapter level (below that, `longSummary: null` — fetch via `GET …/summaries`); the `stale` flags object (`{short, long, illustration}`), and `illustration: { version, width, height } | null` (04 §4.5) — `version` is the PNG content hash, `null` means none (including user-suppressed). Size honesty: a 300k-word work at scene granularity is 300–500 rows; with scene-level long summaries excluded the response stays ≲ 1 MB, refetched wholesale only on `sections.restructured` (≈ once per consolidation, every ~9k words of writing) — fine on loopback. |
| `GET /api/works/:w/sections/:s/content` | → `{markdown, contentHash}` | Leaf prose, lazy-fetched at fold `full`. `404 not_found` for interior sections. |
| `PATCH /api/works/:w/sections/:s/content` | `{markdown, baseHash}` → `{contentHash}` | Optimistic concurrency: `409 conflict` when `baseHash` ≠ current (02 staleness rules fire server-side). |
| `PATCH /api/works/:w/sections/:s` | `{title}` → `SectionRow` | Sets `titleSource: "user"` — never clobbered by enrichment afterwards. |
| `GET /api/works/:w/sections/:s/summaries` | → `{short, long}` | Lazy fetch for scene-level `long`; also the refetch target when a client holds an expanded summary that `enrichment.updated` invalidated. |
| `PUT /api/works/:w/sections/:s/summaries` | `{short?, long?}` → `SectionRow` | **User edit of enrichments.** Writes `summary-{short,long}.md`, records `author: "user"` + current `sourceHash`, so a user-edited summary is *not stale* until the prose changes again (02 §enrichment). |
| `GET /api/works/:w/sections/:s/history` | → `ConsolidatedSnippet[]` | Frozen-prose provenance from `history.jsonl`. Structured-for; endpoint + UI deferred post-M2 (§13). |

Enrichment *regeneration* is not a PUT — it's a task (`POST /tasks {kind:"enrich-section"}`),
keeping "user writes" and "agent writes" on separate, provenance-correct paths.

### 3.3 Snippets: CRUD, revisions, rollback

| Method & path | Req → Res | Notes |
|---|---|---|
| `GET /api/works/:w/snippets` | → `SnippetDto[]` | All frontier snippets, full text (they're small), ordered by `orderKey`. `SnippetDto` includes `revisionCount` (index column, 02). |
| `POST /api/works/:w/snippets` | `{text, afterSnippetId?}` → `201 SnippetDto` | Default append at frontier end; `afterSnippetId` for rare mid-frontier insert. `authorship: "user"`. |
| `PATCH /api/works/:w/snippets/:s` | `{text, baseRev}` → `SnippetDto` | One call = one revision (explicit commit; the server does **not** debounce). `409 conflict` on stale `baseRev`. |
| `DELETE /api/works/:w/snippets/:s` | → `204` | Revision log file removed with it (frontier only). |
| `GET /api/works/:w/snippets/:s/revisions` | → `RevisionEvent[]` | Full texts, oldest first (02 §revisions). |
| `POST /api/works/:w/snippets/:s/restore` | `{rev}` → `SnippetDto` | Appends a **new** revision whose text is revision `rev` — history is never rewritten. |

### 3.4 Editing signal

The client declares which snippet currently has an open editor so consolidation never freezes a
passage out from under the user (02 §consolidation eligibility).

| Method & path | Req → Res | Notes |
|---|---|---|
| `POST /api/works/:w/editing` | `{snippetId: Ulid \| null}` → `204` | `null` clears the signal (editor closed/cancelled). Fired on editor open/close; also cleared server-side when the work's SSE subscriber count drops to zero (§4.2), so a vanished tab can't pin consolidation forever. |

### 3.5 World-info entries

| Method & path | Req → Res | Notes |
|---|---|---|
| `GET /api/works/:w/world` | → `WorldEntryDto[]` | List with `name, keys, shortSummary, hasImage, imageVersion` and full `body` (entries are small; one fetch powers list, hovercards, and the client-side key matcher). `keys` defaults to `[]` — optional per the brief. |
| `GET /api/works/:w/world/:e` | → `WorldEntryDto` | Single-entry fetch; the SSE reducer's patch target for `world.changed {entryId}`. |
| `POST /api/works/:w/world` | `{name, keys?, body?, shortSummary?}` → `201 WorldEntryDto` | |
| `PATCH /api/works/:w/world/:e` | `{name?, keys?, body?, shortSummary?, baseHash?}` → `WorldEntryDto` | `409` on stale `baseHash` when body is being replaced. |
| `DELETE /api/works/:w/world/:e` | → `204` | Deletes entry file + its image. |
| `POST /api/works/:w/world/:e/image` | raw `image/png` body (≤ 10 MB) → `{imageVersion}` | User upload. Generation goes through `POST /tasks {kind:"world-image"}`. |
| `DELETE /api/works/:w/world/:e/image` | → `204` | |

### 3.6 Situation pane

The situation is a per-work singleton markdown scratchpad stored at `<work>/situation.md`
(02 §layout; atomic replace, reconciler-tracked).

| Method & path | Req → Res | Notes |
|---|---|---|
| `GET /api/works/:w/situation` | → `{text, updatedAt}` | Empty string when absent. |
| `PUT /api/works/:w/situation` | `{text, baseHash}` → `{updatedAt, hash}` | Atomic replace; client debounces 1 s. `409 conflict {currentText, currentHash}` when `baseHash` is stale (an external edit landed) — the UI shows a theirs/mine prompt instead of silent last-writer-wins. Emits `situation.changed`. |

### 3.7 Tasks (agent work)

The harness (05) owns semantics and the `TaskSpec`/`Task` schemas; routes registered here.

| Method & path | Req → Res | Notes |
|---|---|---|
| `POST /api/works/:w/tasks` | `TaskSpec` → `202 Task` | Client-submittable kinds: `continue`, `instructed-continue`, `quick-edit`, `edit-task` (M2), `enrich-section`, `illustrate-section`, `world-image`. `propose-boundaries` is internal (see §3.8 for the manual trigger). Interactive tasks are **not queued**: a second interactive submit while one runs → `409 busy` (`{runningTaskId}` in details). `409 config_missing` when the routed lane has no endpoint configured (or the routed ComfyUI workflow failed registry validation — 08). `400 validation` for a `quick-edit` selection outside its rule — one snippet (M1) or one intra-section span (M2, with section-span commits); multi-snippet or boundary-crossing selections are rejected with a message hinting at edit-task. |
| `GET /api/works/:w/tasks` | → `Task[]` | Queued + running + last 50 terminal. **In-memory: empty after a restart** — clients must not poll it to recover state; that path is `GET /runs/:r` (§8.4). |
| `GET /api/works/:w/tasks/:t` | → `Task` | `404 not_found` after a restart (same caveat). Includes `partialText` on terminal error/cancel while the process lives. |
| `POST /api/works/:w/tasks/:t/cancel` | → `202 Task` | Idempotent; cancels queued (removal) or running (abort). |
| `POST /api/works/:w/tasks/estimate` | `TaskSpec` → `TaskEstimate` | **M2.** Wraps `POST /context/preview` (§3.10) and adds cost math only — there is exactly one token estimator, the engine's; no chars/4 anywhere on this path. |
| `POST /api/works/:w/tasks/:t/proposal/apply` | → `{snippet?: SnippetDto, section?: SectionRow}` | Keep-partial / conflict resolution. The proposal (partial text or conflict block + spec) is **reconstructed on demand from the run JSONL** — durable, no TTL, survives restarts; any in-memory copy is only a cache. Apply commits server-side with `authorship: "agent"` + `originRunId`. The resolution is appended to the run file, making apply/discard idempotent (second apply → `409 conflict`). |
| `POST /api/works/:w/tasks/:t/proposal/discard` | → `204` | Same reconstruction + durable marker. |

`TaskSpec`'s `edit-task` variant carries the pane's explicit context choices:

```ts
// packages/shared/src/tasks.ts (owned by 05; shown for the wire contract)
z.object({
  kind: z.literal("edit-task"),
  instruction: z.string().min(1).max(20_000),
  targets: z.array(EditTarget).min(1).max(12),
  pinnedWorldEntryIds: z.array(Ulid).max(20).default([]),
  contextSelections: z.array(z.object({
    id: Ulid,
    kind: z.enum(["section", "snippet", "world"]),
    fidelity: Fidelity,                     // validated against engine candidates (06)
  })).default([]),
})
```

### 3.8 Consolidation controls

| Method & path | Req → Res | Notes |
|---|---|---|
| `POST /api/works/:w/consolidate` | → `202 Task` | Manual "Consolidate now": enqueues the internal `propose-boundaries` task on the background lane. This is the only way a client triggers that kind. |
| `POST /api/works/:w/consolidations/:undoToken/undo` | → `204` | Undo within the grace window (02 §undo). Cancels pending enrich/illustrate tasks targeting the un-frozen sections, then emits `consolidation.undone`. `409 conflict` when the token has expired or been purged. |

### 3.9 Agent runs (provenance)

| Method & path | Req → Res | Notes |
|---|---|---|
| `GET /api/works/:w/runs/:r` | → `RunEvent[]` | Parsed run JSONL (05 §run record); powers the provenance timeline, including the region view fed by `ContextSnapshot` in the `meta` event. |
| `GET /api/works/:w/runs?artifact=<kind>:<id>&limit=20` | → `RunSummary[]` | Via the `run_artifacts` index; `RunSummary` = meta + status + usage, no transcript. |
| `GET /api/works/:w/usage?since=<iso>` | → `UsageRollup` | Token/cost sums per kind per day. Deferred (per-run usage ships in run records from M1). |

### 3.10 Images

| Method & path | Res | Notes |
|---|---|---|
| `GET /api/works/:w/sections/:s/illustration?v=<ver>` | `image/png` | `Cache-Control: public, max-age=31536000, immutable` + `ETag`. `v` is `SectionRow.illustration.version` — the **PNG's content hash**, so both "same content, regenerated" and "new content" bump it; `enrichment.updated` carries the fresh row. `404` when absent or suppressed. |
| `POST /api/works/:w/sections/:s/illustration` | raw `image/png` (≤ 10 MB) → `{illustrationVersion}` | User upload (08 §8): writes `source: "user"` meta (`runId: null`), replaces any tombstone, emits `enrichment.updated`. Generation/regeneration (with optional guidance) goes through `POST /tasks {kind:"illustrate-section"}`. M1. |
| `DELETE /api/works/:w/sections/:s/illustration` | → `204` | Deletes the PNG and writes the **suppression tombstone** (08 §5) so the staleness sweep never resurrects it; idempotent; emits `enrichment.updated`. M1. |
| `GET /api/works/:w/world/:e/image?v=<ver>` | `image/png` | Same policy; `v` = `imageVersion` (PNG content hash). |

Files are streamed from disk. A per-work `@fastify/static` root is rejected — paths are computed
from index rows, so a tiny read-stream handler with a path-containment check (resolved path must
be inside the work dir) is safer and simpler.

### 3.11 Context engine (routes owned by 06, mounted here)

| Method & path | Purpose |
|---|---|
| `GET /api/works/:w/context/state` | Current `ContextState` + computed default fidelity map. |
| `GET /api/works/:w/context/candidates` | Section tree + world list with per-fidelity token counts (`{id, kind, name, path, defaultFidelity, currentFidelity, tokens}`). |
| `POST /api/works/:w/context/preview` | `{taskType, selections, targets?: ItemRef[]}` → `{totalTokens, perRegion, overSoft, overHard, softBudget, hardCap}` — the live token meter, fully server-fed: the response carries the effective `softBudget`/`hardCap` numbers so the client renders no budget constants of its own. Ships M1. |
| `POST /api/works/:w/context/reset` | Wipe ledger + anchors back to defaults (troubleshooting). |
| `GET /api/works/:w/context/usage?limit=100` | Recent usage events (profiling). |

### 3.12 Config & meta

| Method & path | Req → Res | Notes |
|---|---|---|
| `GET /api/health` | → `{ok: true, version, uptime}` | Also the Playwright/Docker readiness probe. |
| `GET /api/illustration/health` | → registry/reachability report | ComfyUI reachability + per-workflow registry validation report (08 §8); powers the settings-page status row. M1. |
| `GET /api/config` | → `PublicConfig` | **Redacted**: `apiKey` fields become `{set: boolean}`. Includes `setup: {highConfigured, lowConfigured, comfyConfigured}` for the first-run screen and `overrides` provenance (§9.6). |
| `PUT /api/config` | `ConfigUpdate` → `{config: PublicConfig, restartRequired: string[]}` | Full replace of the config document (§9.5 semantics). Validates, writes the file atomically, hot-applies what it can. |
| `POST /api/config/test` | `{target: "high"\|"low"\|"comfyui", candidate?: ConfigUpdate}` → `ProbeResult` | Live probe: models → `GET {baseUrl}/models` then a 1-token chat ping; ComfyUI → `GET /system_stats`. **Candidate semantics:** deep-merged over the saved config before probing; `apiKey: null` = use the stored key (re-test after editing only the model name), `apiKey: ""` = keyless. 10 s internal timeout → `{ok:false, code:"timeout"}`. |
| `POST /api/config/reload` | → same as PUT response | Re-reads the file from disk (for hand-editors); no fs-watcher (§9.7). |

### 3.13 Events

| Method & path | Notes |
|---|---|
| `GET /api/works/:w/events` | The one SSE stream per open work (§8). |

---

## 4. Work lifecycle at the API layer

The lock, index handle, and event bus need a definition of "open" and "close" that a Fastify
server can actually observe. SSE presence is that observable: **a work is open while it has ≥ 1
SSE subscriber** (a healthy client always holds the stream).

### 4.1 Open

First touch of any `/api/works/:w/...` route lazily opens the work: acquire the per-work lock
(02 §locking; a dead-pid lock on the same host is stale immediately), open the SQLite index,
create the `EventBus` for the work, run the reconciler. If the lock is held by a live process the
work opens **read-only**: mutating routes return `409 readonly`, and `WorkDetail.readonly` +
`readonly.changed` reflect it.

Reconciler cadence (no browser-focus signals anywhere): on open, before every agent run, and on a
30 s timer **while the work has ≥ 1 SSE subscriber**. The harness's idle enrichment sweep
similarly keys off "interactive lane empty 60 s + ≥ 1 SSE subscriber" (05).

### 4.2 Close

*Close* = the work's SSE subscriber count has been zero for **5 minutes**, or server shutdown
(SIGINT/SIGTERM; the Windows console `close` event runs the same path). On close:

1. Stop accepting new tasks for the work (`409 readonly`-style rejection with code `busy` is not
   used here; submits after close-start get `409 conflict` with a "work is closing" message).
2. Cancel interactive + illustration lanes (abort → run files finalized).
3. **Skip the boundary agent** — no close-triggered consolidation; the next open consolidates.
4. Finish any in-flight consolidation journal steps (milliseconds; correctness never depends on
   close — the journal covers hard kills).
5. Clear the editing signal, flush storage, close the index handle, release the lock, drop the
   bus.

### 4.3 Delete

`DELETE /works/:w` runs the full teardown **before** touching the directory — on Windows,
renaming a directory with open handles fails, so ordering is load-bearing:

1. Stop accepting tasks; cancel/abort everything in the work's lanes and await run finalization.
2. Close the SSE stream (final comment frame, then end) — no further events are published.
3. Close the SQLite handle (WAL/SHM released), release the lockfile.
4. Rename the work dir into `<dataDir>/.trash/<slug>-<ts>/`.

`GET /works` never lists `.trash` (dot-directories skipped).

---

## 5. Fastify wiring

### 5.1 Server directory layout (`apps/server/src`)

```
src/
  index.ts               # CLI entry: flags → loadConfig → buildApp → listen → open browser
  app.ts                 # buildApp(deps): registers plugins + routes; pure function, test target
  deps.ts                # composition root: ConfigService, StorageService, ContextEngine,
                         #   AgentService, IllustrationPipeline, EventBus — all injected, mockable
  config/
    load.ts              # locate → read JSONC → ${env:} interpolate → Zod parse → defaults
    service.ts           # ConfigService: current(), update(), reload(), subscribe(), overrides()
    firstRun.ts          # write commented template on first start
    routes.ts            # §3.12 config endpoints + probes
  http/
    zod.ts               # fastify-type-provider-zod setup (validator+serializer compilers)
    errors.ts            # AppError class, ErrorCode→status map, global error handler
    hostGuard.ts         # onRequest Host-header allowlist + Origin check (§5.4)
    static.ts            # serve apps/web/dist + SPA fallback + missing-dist page
    routes/
      works.ts sections.ts snippets.ts world.ts situation.ts editing.ts
      consolidation.ts images.ts health.ts
  events/
    bus.ts               # per-work EventBus: publish(), ring buffer, per-target snapshot
                         #   accumulators, in-process channels (§8.5), subscriber mgmt
    routes.ts            # GET /events: negotiate Last-Event-ID, replay/snapshot/resync, heartbeat
  agents/ …              # 05 (its routes.ts registers /tasks + /runs under /api here)
  context/ …             # 06 (routes + engine; estimate.ts is the one tokenizer)
  illustration/ …        # 08 (pipeline + workflow registry)
  storage/ …             # 02
```

### 5.2 Zod ↔ Fastify

**`fastify-type-provider-zod`.** Route options carry the shared schemas directly
(`schema: { body: TaskSpec, response: { 202: Task } }`); the validator compiler rejects bad input
with our envelope, and the **serializer compiler runs responses through Zod too**, so a handler
returning a malformed DTO fails loudly in dev instead of shipping a contract break. *Rejected:*
manual `.parse()` in every handler (boilerplate, easy to skip on responses); `ts-rest`/`zodios`
(fine libraries, but a 60-line route registry of our own keeps the dependency surface flat).

Every route's schemas come from `packages/shared` — enforced by a unit test that walks the
Fastify route table and asserts each schema object is identity-equal to a shared export.

### 5.3 Plugins and parsers

`@fastify/static` (web dist, `wildcard: false` + explicit SPA fallback for non-`/api` GETs),
Fastify's built-in JSON body parser with a 2 MB limit (a 20k-word section PATCH is ~130 KB; 2 MB
is generous), a raw-body content-type parser for `image/png` (10 MB limit). **No CORS plugin**
(prod is same-origin; dev uses Vite's proxy), **no compression** (§2), **no auth, no rate
limiting, no helmet** — localhost, single user, per the brief's non-goals. A plain
`X-Content-Type-Options: nosniff` header is set; that's it.

### 5.4 Host-header allowlist (DNS-rebinding defense)

"Bind 127.0.0.1" does not protect an unauthenticated API from the browser next to it: a
malicious page can DNS-rebind its origin to `127.0.0.1` and issue same-origin requests — read the
user's prose, or worse, `PUT /api/config` pointing `models.high.baseUrl` at an attacker server
(with `apiKey: null` = keep stored) and then trigger a task, exfiltrating the key as a bearer
header. The defense is ~10 lines and ships in M1:

- An `onRequest` hook rejects any request whose `Host` hostname is not in the allowlist:
  `127.0.0.1`, `localhost`, `::1`, plus `server.host` when it is a specific non-loopback address,
  plus anything in `server.allowedHosts` (for `0.0.0.0` binds behind a known name). Comparison is
  hostname-only (the port is fixed by the socket). Rejection: `403 forbidden_host`.
- Additionally, non-GET requests carrying an `Origin` header that isn't the app's own origin are
  rejected with the same code (belt for the suspenders; SSE and GETs are unaffected).

Dev is unaffected: the Vite proxy preserves the browser's `localhost:5173` /
`127.0.0.1:5173` Host, whose hostname is allowlisted.

---

## 6. `packages/shared`: the single contract

### 6.1 Layout

```
packages/shared/src/
  index.ts               # re-exports everything below
  ids.ts                 # Ulid, OrderKey, IsoTime, Hash (02 owns definitions)
  work.ts                # WorkMeta, WorkSettings, WorkSummary, WorkDetail
  section.ts             # SectionRow, SectionContent, SummariesUpdate, ConsolidatedSnippet
  snippet.ts             # SnippetDto, SnippetCreate, SnippetPatch, RevisionEvent, RestoreReq
  world.ts               # WorldEntryDto, WorldEntryCreate, WorldEntryPatch
  situation.ts           # SituationDto
  enrichment.ts          # EnrichmentMeta, illustration slot union (02/08)
  illustration.ts        # ComfyConfig, WorkflowEntryConfig, pipeline phase enum (08 owns)
  tasks.ts               # TaskKind, TaskSpec, EditTarget, Task, TaskEstimate (05 owns)
  runs.ts                # RunEvent, RunArtifact, RunSummary, ContextSnapshot, UsageRollup (05)
  events.ts              # WorkEvent — the canonical SSE union (§8.2); THIS doc presents it
  context.ts             # Fidelity, ContextState, candidate/preview DTOs, BudgetKnobs (06 owns)
  config.ts              # AppConfig, PublicConfig, ConfigUpdate, ProbeResult (§9)
  api.ts                 # route registry (§6.2) + ErrorCode + ApiErrorBody (§7)
```

Consumed **as TS source** (`exports: { ".": "./src/index.ts" }`); no build step — tsx and Vite
both handle it. There is no tokenizer in `packages/shared` or `apps/web`: token counting lives in
the engine (`apps/server/src/context/estimate.ts`), and the web renders server-computed numbers.

### 6.2 Route registry

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
  // … every endpoint in §3, ~45 entries
} as const;
```

The web `api/client.ts` is then ~50 lines: build URL, fetch, parse error envelope, `res.parse()`
the body. A contract break is a thrown ZodError at the boundary in dev (04 §contract).

### 6.3 Naming (binding)

- **Task kinds are kebab-case** (`instructed-continue`, `quick-edit`, …) — the shared `TaskKind`
  enum is the only spelling anywhere.
- **SSE event names are dot-case** (`snippet.created`, `task.delta`, …).
- **IDs are bare ULIDs**; payloads carry `kind` fields where the entity type matters (§2).
- The web's fold ladder is UI-owned vocabulary (04); the engine's `Fidelity` enum is prompt-side
  vocabulary (06). They are deliberately **not** aliased or coupled.

---

## 7. Error envelope

One shape for every non-2xx JSON response:

```ts
// packages/shared/src/api.ts
export const ErrorCode = z.enum([
  // request-shaped
  "validation",            // 400 — Zod issues in details
  "forbidden_host",        // 403 — Host/Origin allowlist rejection (§5.4)
  "not_found",             // 404
  "conflict",              // 409 — stale baseRev/baseHash; details carry current
  "busy",                  // 409 — interactive lane occupied; details: {runningTaskId}
  "readonly",              // 409 — second-instance lock (02 §locking)
  "payload_too_large",     // 413
  // task/agent (05 §failure taxonomy; surfaced at task-create or via SSE task.failed)
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
`task.failed` events — one taxonomy, one UI mapping.

---

## 8. SSE design

### 8.1 One stream per work, everything multiplexed

`GET /api/works/:w/events` is the only stream. Task lifecycle, token deltas,
snippet/section/world mutations, enrichment updates, and illustration progress all ride it,
tagged with IDs. The client needs background-task events (enrichment finishing, consolidation
applying) even when *it* started nothing, so a work stream must exist anyway; a second per-task
stream would mean two connections, two resume cursors, and event-ordering races (e.g.
`task.artifact` vs `snippet.created`). One connection, one monotonic cursor, strict global order
per work. *Rejected:* one global stream for all works (works are independent; no client views two
at once); WebSockets (bidirectional adds nothing — all client→server traffic is plain REST — and
SSE is fixed by the brief).

### 8.2 Event vocabulary

The canonical `WorkEvent` union lives in `packages/shared/src/events.ts`; 04/05/08 import it.
Wire format is standard SSE: `id:` = resume cursor (§8.3), `event:` = type, `data:` = JSON
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
  z.object({ type: z.literal("situation.changed"), text: z.string(), updatedAt: IsoTime }),
  z.object({ type: z.literal("readonly.changed"), readonly: z.boolean(), reason: z.string() }),

  // ---- task lifecycle (taskId on every event; runId == taskId) ----
  z.object({ type: z.literal("task.queued"),    task: Task, position: z.number().int() }),
  z.object({ type: z.literal("task.started"),   task: Task,
             lane: z.enum(["interactive","background","illustration"]),   // lifted for the reducer
             target: z.object({ kind: z.enum(["frontier","snippet","section","entry"]),
                                id: Ulid.optional() }) }),
  z.object({ type: z.literal("task.stage"),     taskId: Ulid, stage: z.enum(["planning","writing"]) }),
  z.object({ type: z.literal("task.tool"),      taskId: Ulid, name: z.string(), label: z.string() }),
  z.object({ type: z.literal("task.delta"),     taskId: Ulid,
             target: z.string(),                 // "frontier" or the target's ULID
             text: z.string() }),
  z.object({ type: z.literal("task.snapshot"),  taskId: Ulid,             // synthetic on reconnect
             target: z.string(), text: z.string() }),                     // accumulated text so far
  z.object({ type: z.literal("task.retrying"),  taskId: Ulid, attempt: z.number().int(), reason: z.string() }),
  z.object({ type: z.literal("task.progress"),  taskId: Ulid,             // illustration pipeline (08)
             phase: z.enum(["composing","submitting","queued","generating",
                            "critiquing","revising","committing"]),
             attempt: z.number().int().min(1), maxAttempts: z.number().int().min(1),
             pct: z.number().min(0).max(100).nullable() }),               // ComfyUI progress; null outside `generating`
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
  hook injected into it (02 §change hook). The client's echo-dedupe (`(id, rev)` check) handles
  its own optimistic writes (04).
- `task.delta` always carries `target`. In MVP the client renders frontier deltas token-by-token
  but shows targeted-edit targets as a "being rewritten" shimmer that swaps atomically on commit;
  the wire shape already supports inline streaming later (04).
- `task.delta` is throttled server-side to ≤ 30 events/s per task (coalescing buffer) — a token
  firehose at 100+/s wastes both sides; the UI flushes at 30 fps anyway.
- Heartbeat: an SSE comment line (`:hb`) every **15 s**; the client treats 2 misses as a dead
  connection.

### 8.3 Resume, snapshots, resync

**In-memory ring buffer + `Last-Event-ID` resume + synthetic snapshots, with REST resync as the
floor.** No persisted event log — the durable records (files, index, run JSONL) already exist; a
second durable log would be a consistency liability for a rare tab-refresh race.

Mechanics:

- Per work: `streamId` (ULID minted when the work's bus is created, i.e. per open per process)
  and a monotonically increasing `seq`. The SSE `id:` field is `"<streamId>:<seq>"`.
- Ring buffer: last **4,096 events or 10 minutes**, whichever is smaller. A streaming task at
  30 deltas/s fills 4,096 in ~2 min, so the ring alone cannot replay a long gap — that is what
  snapshots are for, not a reason to grow the buffer.
- The bus additionally keeps a **per-target accumulator** for every running task: the
  concatenated stage-2 text streamed so far (and the latest `task.progress` for illustration
  tasks). Cleared when the task ends.
- **Every connection begins with `hello {streamId, seq}`** (so the client always knows the
  current stream identity even if no further events flow). Then:
- On connect **without** `Last-Event-ID`: for each running task, a synthetic `task.started` +
  latest `task.stage` + one `task.snapshot` per active target (+ latest `task.progress` where
  applicable), then live events. The client does its normal initial REST loads; the snapshot
  covers the one thing REST can't return — mid-stream text.
- On connect **with** `Last-Event-ID`:
  - `streamId` matches and `seq` is in the buffer → replay the gap exactly, then live. Seamless.
  - `streamId` matches but `seq` fell out of the buffer → emit `resync` (client invalidates all
    `["work", w]` queries and refetches), then the synthetic snapshot sequence above, then live.
  - `streamId` mismatch (server restarted or work re-opened) → `resync`, then live. See §8.4 for
    what the client can and cannot recover after a restart.

The reducer contract (04 §SSE reducer) is normative: every payload above was chosen so its row
patches the cache without a follow-up fetch, except the deliberate refetch signals
(`sections.restructured`, `world.changed` without `entryId`, `resync`).

### 8.4 Server-restart recovery (the honest story)

After a restart, the task queue and task list are gone (`GET /tasks` is empty; `GET /tasks/:t`
404s — clients must not poll them for recovery). What survives is the run JSONL: the startup
finalizer marks interrupted runs `crash`, with all streamed text teed into the file as it
happened (05 §run record). Recovery therefore reads:

1. Client reconnects → `streamId` mismatch → `resync` → refetch domain state.
2. For the task it was watching (it knows the taskId), `GET /runs/:r` yields terminal status and
   the partial text.
3. Keep-partial goes through `POST /works/:w/tasks/:t/proposal/apply` (§3.7) — the proposal is
   reconstructed from that same run file, so the route works identically before and after a
   restart, and the commit carries agent provenance. The client's local delta buffer is a
   **display** fallback while the stream is dead, never a commit source.

Queued background tasks are not recovered as tasks; they re-derive from staleness on the next
sweep (02 defines a *missing* enrichment/illustration on a frozen section as stale, so nothing is
orphaned).

### 8.5 In-process channels

The same `EventBus` carries two in-process-only signals that never hit the wire: the engine's
`enrichment_wanted` (subscribed by the harness scheduler, which enqueues under the idle-sweep
cap) and storage's `enrichment.completed` commit hook (subscribed by the engine's anchor-refresh
logic). Documented here because the bus owns them; payloads in 05/06.

---

## 9. Configuration

### 9.1 Files and precedence

```
~/.cowrite/                         # COWRITE_HOME overrides the whole directory
  config.jsonc                      # THE config file (commented JSONC); COWRITE_CONFIG overrides its path
  workflows/                        # ComfyUI workflow JSON files (default workflowsDir; 08)
    default.json
  data/                             # default dataDir (storage.dataDir)
    works/<work-slug>/…             # 02 §layout
    .trash/…                        # deleted works (§3.1)
```

Precedence, lowest to highest: **schema defaults → `config.jsonc` → environment variables →
CLI flags.** Per-work tunables (consolidation thresholds, `contextOverrides`) live in each work's
`work.json` and are edited via `PATCH /works/:w` — app-level config never contains per-work
state.

**Format: JSONC** (JSON with comments/trailing commas) parsed by `jsonc-parser` (the VS Code
parser, zero deps). A hand-edited config file needs comments; the first-run template is mostly
comments. *Rejected:* YAML (whitespace footguns for exactly the audience that will paste API keys
at midnight), TOML (another syntax for no gain), plain JSON (no comments), `.env` (flat; can't
express workflow registries).

Secrets: `apiKey` values support `${env:VAR}` interpolation and may also be stored verbatim —
this is a single-user local file with `0600` perms on POSIX; keychain integration is out of
scope. `GET /api/config` always redacts.

### 9.2 Schema (`packages/shared/src/config.ts`)

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

export const AppConfig = z.object({
  schemaVersion: z.literal(1),
  server: z.object({
    host: z.string().default("127.0.0.1"),
    port: z.number().int().min(1).max(65535).default(2697),   // C-O-W-R on a phone keypad
    openBrowser: z.boolean().default(true),
    allowedHosts: z.array(z.string()).default([]),            // extra Host names (§5.4)
  }).default({}),
  storage: z.object({
    dataDir: z.string().default("~/.cowrite/data"),           // "~" expanded at load
  }).default({}),
  models: z.object({
    high: ModelEndpoint.nullable().default(null),   // null ⇒ unconfigured ⇒ setup screen
    low:  ModelEndpoint.nullable().default(null),
  }).default({}),
  comfyui: ComfyConfig.nullable().default(null),    // owned by 08; shape recapped below
  // Zod 4: z.record with an enum key schema is exhaustive; partialRecord is what
  // "per-kind overrides" means. The all-defaults object and the first-run template
  // must both parse — a named regression test guards this (§12).
  routing: z.partialRecord(TaskKind, z.enum(["high","low"])).default({}),
  budgets: BudgetKnobs.partial().default({}),        // 06 §knobs, app-level overrides
  harness: HarnessKnobs.partial().default({}),       // timeouts/retries, 05 §timeouts
  retention: z.object({
    pruneRunsAfterMonths: z.number().int().positive().nullable().default(null),
  }).default({}),
});
```

`ComfyConfig` (defined in `packages/shared/src/illustration.ts`, owned by 08) in brief:
`baseUrl`; `workflowsDir` (default resolves to `<configDir>/workflows`); `workflows` — a record
of `name → {file, label, execTimeoutMs?}`; `route: {section, world}` naming which workflow serves
each image kind (default `"default"`/`"default"`); `loop: {maxAttempts: 3, acceptScore: 7}`;
`timeouts`. Workflow JSON files are parsed and validated by the illustration registry at load and
on config reload (marker scan for `%prompt%`/`%seed%`/`%output%`, output-node fallback
whitelist — 08 §workflow contract). **Validation failures are recorded per workflow and surface
as task-time `config_missing` when that workflow is used — never startup-fatal.** The same rule
covers `route` naming a workflow that doesn't exist.

Soft-budget numbers (`softBudget: 32_000`, `hardCap: 64_000`, …) default in `BudgetKnobs` (06);
`config.budgets` overrides app-wide, `work.json.contextOverrides` per work. One override chain,
documented in the template comments.

### 9.3 Environment variables and flags

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
| `COWRITE_MOCK_LLM=1` | `--mock` | boot in-process mock LLM + ComfyUI, point both lanes at them (09) |
| — | `--no-open` | suppress browser open |

Env overrides exist chiefly for Docker and CI, and they configure **endpoints and keys only** —
structured config (workflow registries, routing, budgets) is inexpressible as env vars by design;
Docker users who need it mount the config volume (§10.4).

### 9.4 First-run experience

1. `pnpm start` with no `~/.cowrite/config.jsonc` → `firstRun.ts` writes the commented template
   (all models `null`, sample workflow entries commented out) and creates `dataDir`. The server
   **starts anyway** — browsing/creating works and writing by hand must work with zero endpoints
   configured (agents unavailable, not the app).
2. The web app calls `GET /api/config`; `setup.highConfigured === false` routes to the **setup
   screen**: three cards (High model / Low model / ComfyUI — the third skippable), each with
   baseUrl / apiKey / model fields and a **Test** button hitting `POST /api/config/test` with the
   unsaved candidate. Save → `PUT /api/config` → into the app.
3. Any later attempt to run a task on an unconfigured lane returns `409 config_missing`, which
   the UI renders as a callout linking back to settings.

Console output on every start prints the lines that matter:

```
cowrite v0.1.0
  config   ~/.cowrite/config.jsonc        (high: ok · low: ok · comfyui: not configured)
  data     ~/.cowrite/data                (3 works · trash 1.2 GB)
  ➜ http://127.0.0.1:2697
```

### 9.5 `PUT /api/config` semantics

`PUT` is a **full replace** of the config document, honoring §2's verb rules — the settings
screen holds the whole config anyway. Two sentinel rules, both only meaningful in the update
direction:

- `apiKey: null` = keep the stored key (the client never sees keys, so it can't echo them);
  `apiKey: ""` = keyless endpoint.
- Clearing a section is literal: `models.high: null` or `comfyui: null` in the submitted document
  unsets it. Because the body is the full document, absence and `null` are unambiguous.

Validate-then-write; the write is atomic (tmp + rename). The response returns the effective
`PublicConfig` and `restartRequired: string[]`.

### 9.6 Override provenance (env-configured deployments)

In any env-configured deployment (Docker bakes in `COWRITE_HOST` and `COWRITE_DATA_DIR`), a file
edit to an env-overridden field would change nothing — success reported, effect zero. So
`PublicConfig` carries provenance:

```ts
export const PublicConfig = /* redacted AppConfig */ .extend({
  setup: z.object({ highConfigured: z.boolean(), lowConfigured: z.boolean(),
                    comfyConfigured: z.boolean() }),
  overrides: z.array(z.object({
    path: z.string(),                       // "server.host", "models.high.apiKey", …
    by: z.enum(["env", "flag"]),            // absent from the list ⇒ overriddenBy: null
  })),
});
```

`GET` and `PUT` both return it; the settings screen renders overridden fields read-only with a
"set by COWRITE_X" hint. `PUT` still persists such fields to the file (they apply once the
override is removed).

### 9.7 Live-reload policy

**Hot-apply on `PUT`/`reload`; no filesystem watcher; three fields restart-required.**

- Hot-appliable (read at point of use, so swapping the `ConfigService` snapshot suffices):
  `models.*`, `comfyui.*` (triggers a workflow-registry reload), `routing`, `budgets`, `harness`,
  `retention`, `server.openBrowser`, `server.allowedHosts`. **In-flight tasks keep the config
  they started with** (the runner captures a snapshot at task start — no mid-run endpoint
  switcheroo).
- Restart-required: `server.host`, `server.port` (rebinding a live listener isn't worth the
  code), `storage.dataDir` (every open work handle points into it). `PUT` still persists them and
  returns `restartRequired: ["server.port", …]`; the UI shows "restart Cowrite to apply".
- Hand-editors press the settings screen's "Reload from disk" (`POST /api/config/reload`) or just
  restart. *Rejected:* fs-watch auto-reload — silent behavior changes mid-session are spooky, and
  editors write partial files; an explicit action is one click.
- An **invalid config file at startup is fatal**: print the Zod issues with line hints
  (jsonc-parser gives offsets) and exit 1. Starting with silently-dropped config is worse than
  not starting. (A *missing* file is the first-run path, never fatal; an invalid or missing
  *workflow file* is never fatal either — §9.2.)

---

## 10. Deployment & packaging

### 10.1 Console app: production start

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
→ print banner (§9.4) → if openBrowser && TTY: spawn platform opener
     (win32: `start`, darwin: `open`, linux: `xdg-open`; failure is a logged shrug)
→ SIGINT/SIGTERM (or Windows console close): run §4.2's close path for every open work,
  close SSE with a final comment, exit
```

Static serving: `@fastify/static` on `apps/web/dist` with `index.html` fallback for any
non-`/api` GET (SPA routes like `/w/:id/runs/:rid` must deep-link). `index.html` is served
`no-cache`; hashed Vite assets are `immutable`.

If `server.host` is not a loopback address, log a red warning banner — "Cowrite has no
authentication; anyone who can reach this port can read and edit your works" — and continue
(Docker legitimately sets `COWRITE_HOST=0.0.0.0`; the explicit env/flag *is* the opt-in). The
Host allowlist (§5.4) still applies; `server.allowedHosts` names the expected hostnames.

*Rejected packaging alternatives:* publishing an npx-able `cowrite` bin (nice later; a git clone
is the SillyTavern-style story, and MVP shouldn't own an npm release pipeline —
`apps/server/package.json` can grow a `bin` field without moving code); `pkg`/SEA single binaries
(fight tsx and native better-sqlite3 for no audience need).

### 10.2 Dev mode

`pnpm dev` (root script) runs both in parallel:

- `@cowrite/server`: `tsx watch src/index.ts` on **:2697** — restarts on server/shared changes;
  prompt templates hot-reload with it.
- `@cowrite/web`: `vite` on **:5173** with a proxy so dev and prod share URLs:

```ts
// apps/web/vite.config.ts
server: {
  proxy: {
    "/api": {
      target: "http://127.0.0.1:2697",
      // SSE: http-proxy streams responses by default; disable proxy timeouts
      // so the events stream is never severed.
      timeout: 0, proxyTimeout: 0,
    },
  },
},
```

Caveat (README): a tsx-watch restart drops SSE connections; the web client's backoff-reconnect +
snapshot/resync (§8.3) makes this a non-event in practice.

### 10.3 Windows + Linux parity

| Concern | Rule |
|---|---|
| Native deps | Exactly one: `better-sqlite3`, which ships prebuilt binaries for win32/linux/darwin x64+arm64 on Node 22. No node-gyp toolchain required for users. |
| Paths | `node:path` everywhere; work-relative paths in DTOs/index always use `/` (normalized at the storage boundary). No path enters a shell. |
| Atomic writes | Owned by storage (02: POSIX rename vs Windows `ReplaceFile` semantics); the API layer never touches files directly except streamed image reads. |
| Directory rename with open handles | Fails on Windows — hence the ordered teardown in §4.3 (close handles *before* the `.trash` rename). |
| npm scripts | No shell-isms (`&&` is fine; no `$VAR`, no `cp -r`). Anything conditional is a `node scripts/*.mjs`. Env-dependent invocations set env via config files, not inline `FOO=1` syntax. |
| `~` expansion | Done in `config/load.ts` via `os.homedir()` — shells don't expand it in JSONC. |
| Line endings | `.gitattributes` forces `*.ts *.json *.md text eol=lf`; Biome enforces LF. |
| Sockets | Default host `127.0.0.1` explicitly (not `localhost`) to dodge Windows IPv6 (`::1`) resolution surprises between fetch and listen. |
| Signals | SIGINT works on both; Windows gets no SIGTERM — the console `close` event runs the same shutdown function. |
| Playwright | `webServer.command` in `playwright.config.ts` is a plain `pnpm` invocation with `env: {...}` in the config object (not inline shell env) and targets port 2697, so it runs unmodified on Windows runners (09). |

CI runs the unit/integration suite on `ubuntu-latest` **and** `windows-latest`; e2e on Linux only
(MVP), Windows e2e deferred.

### 10.4 Dockerfile (dev-capable)

At the repo root; normative sketch. Multi-stage: `dev` has the full toolchain + Chromium for
in-container Playwright; `runtime` (default) builds the web app and runs the server.

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
# run the app (models only — endpoints/keys via env)
docker build -t cowrite . && docker run -p 127.0.0.1:2697:2697 \
  -v cowrite-data:/data \
  -e COWRITE_LLM_HIGH_BASE_URL=… -e COWRITE_LLM_HIGH_API_KEY=… cowrite

# run with illustration: mount the config volume — workflow registries are files,
# not env vars, and this is the supported way to provide them in Docker
docker run -p 127.0.0.1:2697:2697 -v cowrite-data:/data \
  -v ~/.cowrite:/root/.cowrite cowrite

# hack on it (mount sources, real endpoints via env)
docker build --target dev -t cowrite-dev .
docker run -it -p 2697:2697 -p 5173:5173 -v "$PWD":/app -v cowrite-data:/data \
  -e COWRITE_LLM_HIGH_BASE_URL=… -e COWRITE_LLM_HIGH_API_KEY=… cowrite-dev bash
```

Env vars alone configure endpoints and keys — enough for text-only use. **Illustration in Docker
requires the `~/.cowrite` config volume** (config.jsonc + `workflows/`); a missing or invalid
workflow surfaces as task-time `config_missing`, never a failed boot (§9.2). Model/ComfyUI
endpoints on the host are reachable via `host.docker.internal` (README; on Linux add
`--add-host=host.docker.internal:host-gateway`).

---

## 11. Failure modes

| Failure | Behavior |
|---|---|
| Invalid config file at startup | Fatal with pretty Zod issues + file/line hints. Missing file = first-run path, never fatal. |
| Invalid/missing ComfyUI workflow file or dangling `route` name | Recorded per workflow at registry load; task-time `409 config_missing` when used. Never startup-fatal. |
| Port in use | Fatal with actionable message (`--port` hint). |
| `dataDir` missing/unwritable | Created if missing; unwritable ⇒ fatal with the path printed. |
| Host header not allowlisted (DNS rebinding) | `403 forbidden_host` from the onRequest hook; same for non-GET with a foreign `Origin`. |
| `PUT /api/config` with invalid body | `400 validation`, file untouched (validate-then-write; write is atomic tmp+rename). |
| Config field overridden by env/flag | `PUT` persists it and reports it in `overrides`; settings UI renders it read-only with the env-var name. |
| Config endpoint probe hangs | `POST /config/test` has its own 10 s timeout; returns `{ok:false, code:"timeout"}` — never blocks the event loop. |
| SSE client falls behind (same process) | Ring replay when possible; else `resync` + synthetic `task.snapshot` per streaming target (§8.3). |
| Server restarted mid-task | Run finalized as `crash`; client gets `resync`, reads `GET /runs/:r`, keep-partial via the proposal routes (§8.4). `GET /tasks[/:t]` is empty/404 by design. |
| Handler returns off-contract DTO | Serializer-side Zod failure ⇒ `500 internal` + loud dev log — contract breaks cannot ship silently. |
| Image path escape attempt | Streamed image handler resolves and containment-checks against the work dir; failure ⇒ `404`. |
| Oversized body | `413 payload_too_large` (2 MB JSON / 10 MB PNG caps). |
| Web assets missing (fresh clone, no build) | Fallback page with build instructions; API fully live (agents/e2e can run headless). |
| Version skew (stale tab after upgrade) | Client Zod parse fails ⇒ "reload" toast; `GET /api/health.version` lets the client detect skew proactively after reconnect. |
| Two server instances on one work | Storage lockfile ⇒ second instance serves the work read-only; `readonly.changed` event + `409 readonly` on mutations. Dead-pid locks (same host) are stale immediately, so a crash-restart is never locked out of its own work. |
| `DELETE /works/:w` on Windows with open handles | Cannot happen by construction — teardown closes index/lock/SSE before the rename (§4.3). |

---

## 12. Testability

- **Route integration tests (Vitest):** `buildApp(deps)` with real storage on a temp dir and the
  mock LLM in-process; drive via `app.inject()` (no sockets). Golden coverage: every endpoint in
  §3 has at least a happy-path + one failure-path test asserting the envelope.
- **SSE tests:** inject a raw request with `accept: text/event-stream`, parse frames, assert:
  ordering (domain event follows its REST 2xx), `Last-Event-ID` replay byte-exactness, ring
  overflow ⇒ `resync` + `task.snapshot` with the accumulated text, fresh-connect snapshot
  sequence while a task streams, heartbeat cadence (fake timers).
- **Host-guard tests:** allowlisted hostnames pass; a rebound hostname and a foreign-`Origin`
  POST both get `403 forbidden_host`; `server.allowedHosts` extends the list.
- **Contract test:** walk Fastify's route table; every schema must be identity-equal to a
  `packages/shared` export, and every `api.ts` registry entry must have a registered route (and
  vice versa). This is the drift fence.
- **Config tests:** table-driven precedence (defaults < file < env < flags), `${env:}`
  interpolation, redaction round-trip (`PUT` of a redacted `GET` body is a no-op), hot-apply vs
  `restartRequired` classification, override-provenance reporting, and the named regression:
  **the first-run template and the all-defaults empty object both parse against `AppConfig`**
  (this is the test that catches an exhaustive-record slip in Zod 4).
- **Lifecycle tests:** delete-while-streaming (teardown order observable via injected fakes),
  close-after-idle timer, restart recovery (kill `buildApp`, rebuild on the same temp dir, assert
  proposal apply still works from the run file).
- **E2E (Playwright):** boots the real server with `COWRITE_MOCK_LLM=1` + temp data dir (09 owns
  the flows); `GET /api/health` is the readiness URL.
- **Cross-platform CI:** unit/integration on Ubuntu + Windows; `docker build` of both targets on
  Linux as a smoke job.

---

## 13. MVP cut

**M1 (ships first):**

- Full endpoint table §3 **except** the M2 items below — including the per-work SSE stream with
  ring-buffer resume, snapshots, heartbeats, resync; error envelope + closed `ErrorCode`;
  Host-header allowlist; work open/close/delete lifecycle; the editing signal; consolidation
  controls; proposal apply/discard (keep-partial is core frontier-loop robustness); context
  routes including `/context/preview` (the token meter); images; runs (basic provenance viewer);
  situation; world panel routes
- `packages/shared` layout, route registry, `fastify-type-provider-zod` wiring, contract test
- Config: JSONC file + env/flag precedence, first-run template + setup screen endpoints
  (`GET/PUT /config`, `POST /config/test`, `POST /config/reload`), hot-apply/restart-required
  split, override provenance, `ComfyConfig` + workflow registry validation (illustration's basic
  loop is M1)
- Packaging: `pnpm build && pnpm start` serving built web assets, dev mode with Vite proxy,
  banner + browser-open, graceful shutdown, Windows/Linux parity rules, both Dockerfile targets
- Task kinds accepted in M1: `continue`, `instructed-continue`, `quick-edit` (one snippet;
  intra-section spans arrive in M2), `enrich-section`, `illustrate-section`, `world-image`
  (+ internal `propose-boundaries` via `/consolidate`)

**M2:**

- `edit-task` kind + `POST /tasks/estimate` + `contextSelections` validation + section-span
  edit commits (with the edit-task pane and Playwright spec 7)
- Multi-select / conflict-card UI polish (API side: nothing new — the proposal routes already
  exist), candidate picker for illustrations
- Run pruning (`retention.pruneRunsAfterMonths` passthrough) and review-mode consolidation
- `GET /usage` rollups beyond per-run figures

**Deferred beyond M2:** `GET /sections/:s/history` + the frozen-provenance UI (the `history.jsonl`
data is written from M1; the endpoint and UI ship when the provenance viewer grows into it),
trash GC / `.trash` management UI (banner line only), npm `bin`
packaging (`npx cowrite`), Windows e2e in CI, OpenAPI export from the route registry (trivial
later since schemas are centralized).

**Explicit non-goals honored:** no auth, no multi-tenancy, no HTTPS termination, no rate
limiting, no CORS surface; localhost bind by default with a loud warning otherwise.

---

## 14. Contracts

Shared schemas this subsystem **owns** (in `packages/shared`):

| Schema | File | Consumed by |
|---|---|---|
| `WorkEvent` (canonical SSE union, §8.2) | `events.ts` | 04 §SSE reducer, 05 §events, 08 §progress |
| `ErrorCode`, `ApiErrorBody`, route registry `api` | `api.ts` | all subsystems |
| `AppConfig`, `PublicConfig`, `ConfigUpdate`, `ProbeResult` | `config.ts` | 02 (dataDir), 05 (models/routing/harness), 06 (budgets), 08 (comfyui) |
| `WorkSummary`, `WorkDetail` | `work.ts` | 04 |

Shared schemas this subsystem **consumes**:

| Schema | Owner | Notes |
|---|---|---|
| `Ulid`, `IsoTime`, `Hash`, `OrderKey` | 02 (`ids.ts`) | path params, DTOs |
| `SnippetDto`, `SectionRow`, `RevisionEvent`, `ConsolidatedSnippet`, `WorldEntryDto`, `EnrichmentMeta` | 02 | `SectionRow` must expose `illustration: {version, width, height} | null` (`version` = PNG content hash) plus the `stale` flags object, and `SnippetDto.revisionCount` from index columns |
| `TaskKind`, `TaskSpec` (incl. `contextSelections`), `Task`, `TaskEstimate` | 05 (`tasks.ts`) | §3.7; kebab-case kinds |
| `RunEvent`, `RunArtifact`, `RunSummary`, `ContextSnapshot` | 05 (`runs.ts`) | §3.9 provenance; `ContextSnapshot` feeds the region view |
| `Fidelity`, candidate/preview DTOs, `BudgetKnobs` | 06 (`context.ts`) | §3.11 routes mounted verbatim; `/tasks/estimate` wraps `/context/preview` |
| `ComfyConfig`, `WorkflowEntryConfig`, pipeline phase enum | 08 (`illustration.ts`) | §9.2 embeds `ComfyConfig`; `task.progress` uses 08's phase enum |
| Storage change hook (`onChange`) | 02 | feeds §8.2 domain events for app writes *and* reconciler adoptions |
| Mock servers + `COWRITE_MOCK_LLM=1` control routes | 09 | mounted only under the flag |

Prompt markup (region ordering, tag grammar) is owned by 07-prompting.md; nothing in this
subsystem parses or emits prompt markup.
