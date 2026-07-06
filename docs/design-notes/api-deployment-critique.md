# Critique — HTTP API Surface, Config & Deployment (`docs/design/api-deployment.md`)

Reviewed against the brief (`docs/00-overview.md`, authoritative, including the fixed stack) and
the four sibling proposals (`data-model.md`, `agent-harness.md`, `context-engine.md`,
`frontend.md`), plus the actual scaffold (`package.json` manifests, root `Dockerfile`).

Overall: the surface is well-shaped and mostly disciplined — thin routes, one Zod contract, one
SSE stream, JSONC config, boring deployment. The problems below are concentrated in (a) a config
schema that as written cannot boot, (b) hand-waved lifecycle around works and server restarts,
and (c) deployment claims (Docker/env-only) that the config schema can't actually satisfy.

---

## [blocker] §8.2 — the config schema fails to parse its own defaults under Zod 4, making every first run fatal

```ts
routing: z.record(TaskKind, z.enum(["high","low"])).default({}),  // harness §3.1 overrides
```

The workspace pins `zod: ^4.0.0` (both `apps/server` and `packages/shared`), and this doc itself
uses Zod 4-only APIs (`z.treeifyError` in §6). In Zod 4, `z.record()` with an enum key schema is
**exhaustive** — every enum key is required — so the default `{}` (and any partial `routing`
block a user writes, which is the entire point of the field per harness §3.1: "per-kind
overrides") fails validation. §8.5 then declares: "An **invalid config file at startup is
fatal**: print the Zod issues … and exit 1." Net effect as specified: the first-run template
written by `firstRun.ts` does not parse, and `pnpm start` exits 1 for every new user.

**Why it matters:** this is the single path every user hits first, and the failure is baked into
the spec, not an implementation slip — the doc pairs an always-invalid default with a
fail-hard policy.

**Fix:** `routing: z.partialRecord(TaskKind, z.enum(["high","low"])).default({})`. Add a config
test asserting the first-run template *and* the all-defaults empty object parse (§11 already
lists "first-run template parses against `AppConfig`" — good; note that this test is the thing
that would have caught it, so it must ship with the schema, not after).

---

## [major] §1/§4.3 — no DNS-rebinding / Host-header defense; `PUT /api/config` turns it into API-key exfiltration

The design correctly skips auth per the brief ("no auth, no multi-tenancy"), but "bind
127.0.0.1" does not protect an unauthenticated HTTP API from the browser sitting next to it. A
malicious page can DNS-rebind its own origin to `127.0.0.1` and then issue **same-origin**
requests to `http://attacker.example:2697/api/...` — full read of the user's prose and, worse, a
concrete key-theft path: `PUT /api/config` with `models.high.baseUrl` pointed at an attacker
server and `apiKey: null` ("keep existing"), then `POST /tasks {kind:"continue"}` — the server
sends the stored key as a bearer header to the attacker. Redaction of `GET /api/config` doesn't
help; the attacker never needs to read the key, only to make Cowrite send it somewhere. This
class of attack has repeatedly hit exactly this kind of localhost tool (including SillyTavern,
which the brief points at).

**Fix (not auth, ~10 lines):** an `onRequest` hook rejecting requests whose `Host` header isn't
in `{127.0.0.1:<port>, localhost:<port>, [::1]:<port>}` (plus the configured host when non-local
binding is opted into). Optionally also reject non-GET requests carrying an `Origin` that isn't
the app's own. Add it to §4.3's plugin list and to the §10 failure table.

---

## [major] §7.3/§10 — the server-restart "keep partial" story cites state that does not survive a restart

§7.3: "In-flight-task state after a server restart is re-derived from `GET /tasks` +
`GET /tasks/:t` (which carries `partialText` for keep/discard)." But §3.6 defines the task list
as **in-memory** ("Queued + running + last 50 terminal (in-memory)"), and §3.6 also holds
proposals "in memory 30 min." After a restart, `GET /tasks` is empty and `GET /tasks/:t` is a
404; `partialText` is gone. The doc's own restart path (streamId mismatch → `resync`) therefore
dead-ends the user's most painful failure ("model wrote 800 words, server died"). The siblings
already contain the real answer: the frontend keeps the streamed buffer client-side and commits
it via ordinary snippet-create (frontend §13, A5), and the harness tees deltas to the run JSONL
as they stream (harness §8.2 falls back to `GET /runs/:runId`).

**Fix:** rewrite §7.3's restart bullet: after `resync` with streamId mismatch, terminal state
comes from `GET /runs/:r` (the startup finalizer marks `crash`), and keep-partial commits the
*client's* local buffer via `POST /snippets`. State explicitly that `GET /tasks/:t` 404s after
restart so the client doesn't poll it.

---

## [major] §3.1/§3.11 — work lifecycle (open / close / delete) is load-bearing and unspecified

Three related gaps an implementer must guess at:

1. **Lock acquisition timing.** §3.1 says `POST /works` "acquires lock" and `WorkDetail` carries
   a `readonly` flag, but nothing says when a server acquires the per-work lock for *existing*
   works (at startup for all works? on first `GET /works/:w`? on first mutation?) or when it
   releases it. Data-model §9.3 refreshes locks every 30 s per open work — "open" is undefined
   at the API layer.
2. **"On work close" behaviors have no trigger.** Data-model §6.2 runs consolidation "always on
   work close" and purges consolidation-undo journals "after a 5-minute grace **or on work
   close**" — but this API has no close notion at all; works are touched implicitly by GETs and
   an SSE subscription. Either define close (e.g., SSE subscriber count for the work drops to
   zero + N-minute idle) or strike the close-triggered behaviors with data-model's owner.
3. **`DELETE /works/:w` teardown.** It renames the work dir into `.trash/` while the server may
   hold an open `better-sqlite3` handle (WAL + SHM files), a live SSE bus, queued/running tasks,
   and the lockfile inside `.cowrite/`. On Windows — an explicit first-class target (§9.3) —
   renaming a directory with open handles **fails**, so the endpoint 500s exactly on the
   platform the doc spends a table defending. Also unstated: `GET /works` "scans dataDir for
   `work.json`s" must skip `.trash/`.

**Fix:** specify the delete sequence (cancel/abort tasks → close SSE with a final event → close
index + release lock → rename → publish nothing further) and the lock lifecycle; add a line to
§3.1 that the list scan ignores dot-directories.

---

## [major] §9.4/§8.2/D9 — "Docker needs no config file" is false for ComfyUI, and may be fatally false

§9.4: "Config inside containers comes from env vars (§8.3) — no config file needed." But
`comfyui.workflows` is a record of structured objects referencing JSON files under
`~/.cowrite/workflows/` — inexpressible through the §8.3 env table (only `COWRITE_COMFYUI_BASE_URL`
exists), and no volume for `~/.cowrite` appears in the documented `docker run` lines. Worse, the
schema defaults `use.section = "scene-v1"` / `use.world = "portrait-v1"`, which dangle when
`workflows` is empty; D9 says workflow entries are "resolved and validated at config load" and
§8.5 says an invalid config at startup is fatal. So setting only `COWRITE_COMFYUI_BASE_URL`
either bricks startup (if D9's validation is load-fatal) or silently ships an illustration
config that can never run (if it isn't) — the doc doesn't say which.

**Fix:** (a) declare the `use` ↔ `workflows` cross-reference a **task-time** `config_missing`,
never a startup-fatal error; (b) document that illustration-in-Docker requires mounting a config
volume (`-v cowrite-config:/root/.cowrite`), and drop the "no config file needed" absolute.

---

## [major] §8.1/§8.3 — env-over-file precedence silently neuters the settings screen

Precedence is "file → env → flags," and `PUT /api/config` writes the file. In any env-configured
deployment (Docker is the doc's own primary example; the runtime image bakes in `COWRITE_HOST`
and `COWRITE_DATA_DIR`), a user who edits, say, the data dir or an endpoint in the settings UI
gets a 200, the file is updated — and nothing changes, now or after restart, because the env
still wins. The UI is described as "a friendly editor over [the file]" with no mention of this.
That's a textbook UX dead-end: success reported, effect zero.

**Fix:** `PublicConfig` should carry per-field provenance (e.g., `overriddenBy: "env" | "flag"`)
so the settings screen renders those fields read-only with a "set by COWRITE_X" hint; or `PUT`
returns the effective config plus an `ignoredByEnv: string[]` list alongside `restartRequired`.

---

## [minor] §3/D10 — the "complete table" isn't, and two consolidation controls are missing

§3's heading claims a *complete* route list, then D10 admits
`POST /works/:w/consolidations/:undoToken/undo` was "omitted from §3 tables for brevity." The
undo toast is an M1 flow (frontend §15 ships "consolidation undo toast"); it belongs in §3.2.
Separately, data-model §6.2 gives the user a manual "Consolidate now" action, which has no route
here — presumably `POST /tasks {kind:"propose-boundaries"}`, but §3.6 labels that kind
"internal." Say which it is.

## [minor] §3.10 — `POST /config/test` candidate semantics are guesswork

The `candidate` is a `ConfigUpdate`, so: is it deep-merged over the saved config before probing?
What does an absent/`null` `apiKey` in the candidate mean — "no key" or "use the stored key"?
Both cases matter: first-run has no stored key; the settings screen re-testing an existing
endpoint after editing only the model name needs the stored key without ever seeing it. One
sentence fixes this ("candidate is deep-merged over saved config with `apiKey: null` = keep
stored, `\"\"` = keyless"), but as written two implementers will do it two ways.

## [minor] §3.10/§2 — `PUT /api/config` takes a deep-partial, violating the doc's own verb rules; no way to unset an endpoint

§2 defines `PUT` as "full replace of a singleton value," yet `ConfigUpdate` is "deep-partial
AppConfig." Also unstated: how to *clear* `models.high` or `comfyui` back to `null` when `null`
already means "keep existing" for `apiKey` — the two null conventions collide. Make it `PATCH`
with explicit "object → merge, `null` → unset section, `apiKey: null` → keep key" rules (or keep
`PUT` and require the full config).

## [minor] §3.2 — the `GET /sections` size bound is argued at the wrong scale

"A 60-chapter work is < 1 MB" — but the brief's target is 100k–300k words and the level ladder
(overview glossary: "book, part, chapter, scene") reaches scenes. A 300k-word work at scene
granularity is plausibly 300–500 rows with `longSummary` (multi-paragraph) inlined on every one:
1.5–2.5 MB, refetched **wholesale** on every `sections.restructured` — i.e., on every
consolidation, which fires every ~9k words of normal writing. Localhost absorbs it, but state
the worst-case number honestly, and consider inlining `longSummary` only down to chapter level
(scenes lazy-load it like prose) — the fold ladder shows `long` for at most ~4 blocks at a time
(frontend §5.3).

## [minor] §2/§4.3 — `@fastify/compress` on a loopback socket is ceremony

Gzip for JSON > 1 KB buys nothing when the transport is localhost (and in Docker the doc tells
users to publish to 127.0.0.1). Meanwhile the plugin is a known SSE-buffering footgun the doc
must carve around twice (server "never for SSE", Vite proxy `accept-encoding: identity`). Cut
the plugin; delete both caveats. "Simple, modern, snappy" argues for fewer moving parts here,
not smaller localhost payloads.

## [minor] §13 — two frontend divergences are unreconciled despite the doc's reconciliation mandate

(a) Frontend §14.2's Playwright config boots the server on **:8787** and uses inline shell env
(`COWRITE_DATA_DIR=$(mktemp -d) … pnpm start`) — which breaks on Windows and directly violates
this doc's own §9.3 rule ("Playwright's server command … set env via config files, not inline
`FOO=1` syntax"). This doc states the rule but never flags the frontend's violation as a D-item.
(b) Frontend §4.2 defines `qk.worldEntry(w, e)` and its reducer invalidates it, but §3.4 has no
`GET /world/:e` route. Either add the route or record "derive entry from the list query" as a
D-item so the frontend drops the key.

## [minor] §3.1 — `.trash` grows unboundedly and invisibly

Delete-as-move is the right call ("files are the truth"), but with GC "manual (deferred)" and no
UI, deleted novels (with PNGs) accumulate silently forever. Cheapest honest fix: print
`.trash` size in the startup banner next to the works count, so the user knows it exists —
matching the doc's own "console output prints the three lines that matter" ethos.

---

## Verdict

Sound skeleton — the REST/SSE split, single per-work stream with ring-buffer resume, JSONC
config with a first-run template, and the shared-Zod contract are all appropriately sized for
the brief, and the MVP cut is disciplined. But it is not implementable as written: the config
schema is fatal-on-first-run under the pinned Zod 4, the restart/keep-partial path references
state that doesn't survive restarts, work delete/close lifecycle is unspecified on the platform
the doc claims parity for, and the Docker/env-only claim contradicts the ComfyUI schema. All are
fixable without changing the architecture.
