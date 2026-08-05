# 09 — Test Strategy, Mock Servers & E2E Plan

Scope: the project-wide testing architecture — the test pyramid and what belongs at each tier,
the `packages/mock-llm` mock-server package (scriptable OpenAI-compatible + ComfyUI servers) and
how one scenario mechanism serves every tier, deterministic fixtures and the golden-file policy,
the Playwright e2e plan for M1, the cross-cutting failure-mode test matrix, performance budgets
worth asserting, CI wiring, and the manual eval loop for the one thing automation cannot judge
(real-model output quality). Subsystem docs 02–08 each state *what* their subsystem must be
tested for; this doc owns the shared machinery, the tier boundaries, the names, and the CI
story.

## Key decisions

- **Four tiers, hard boundaries** — pure unit (no I/O, no HTTP), integration (`app.inject()`
  against real temp-dir storage + in-process mocks, no sockets for HTTP), e2e (Playwright
  driving the real server over real sockets), and a manual eval loop for real-model quality.
  Every behavior lands at the cheapest tier that can catch its regression.
- **One mock implementation for all tiers** — `packages/mock-llm` ships a scriptable
  OpenAI-compatible server, a mock ComfyUI, and an HTTP-free `FakeLlmClient`, all driven by the
  same ordered-scenario schema, so a scenario written for a unit test is replayable in
  integration and e2e.
- **Scenarios are strictly ordered and unmatched requests fail loudly** — permissive fallthrough
  is how mock tests rot; a mock that answers a request the test didn't script is a bug.
- **Two mock wiring modes, chosen by tier** — integration tests boot the mocks in-process on
  ephemeral ports and point the injected config at their URLs; e2e and manual dev use
  `COWRITE_MOCK_LLM=1` (`--mock`), which boots both mocks inside the server process, points both
  lanes at them, and mounts the `/__mock/*` control routes.
- **Determinism is injected, never patched** — every nondeterminism seam (`now()`, ULID
  generation, seed RNG, timers) is a constructor dependency; tests pass fixed clocks and seeded
  generators, so golden files need no regex scrubbing.
- **Golden files over inline snapshots** — prompt renders, consolidation output, and index
  contents live as checked-in files whose diffs are reviewed like code; updates are deliberate
  (`vitest -u`), never drive-by.
- **Two seed fixtures: `tiny` and `novel`** — a 2-snippet work for flow tests and a
  script-generated ~200k-word, 30-chapter work for fold-ladder, virtualization, and perf tests;
  both built by one fixture builder that all tiers share.
- **Windows is a first-class test target** — unit/integration run on `ubuntu-latest` and
  `windows-latest` in CI; all test config is shell-free (env in config objects, `mkdtempSync`,
  `node:path`) so the e2e suite runs unmodified on a Windows dev machine even though Windows e2e
  in CI is deferred.
- **Perf budgets are asserted nightly, not on every push** — timing tests flake under CI load;
  the nightly job runs them against the `novel` fixture with 2–3× headroom over the design
  numbers.
- **Real-model prose and image quality are explicitly not automated** — they are covered by the
  M1.5 manual eval loop (10-roadmap), fed by the run files and `usage.jsonl` the system already
  records.

---

## 1. The test pyramid

| Tier | Runner | Talks to | What lives here | Speed target |
|---|---|---|---|---|
| **Pure unit** | Vitest (per package) | nothing (pure functions, in-memory fakes) | storage primitives, context-engine math, fold/render logic, prompt-render snapshots, tag/critique parsers, config precedence | ms per test; whole tier < 30 s |
| **Property / fuzz** | Vitest (`fast-check`) | temp dirs only | fractional-index invariants, journal kill-point matrix, reconciler fuzz, coverage invariant, tag-parser chunk splitting, workflow injection purity | seconds; bounded runs on push, extended runs nightly |
| **Integration** | Vitest | real `StorageService` on a temp dir + in-process mock LLM/ComfyUI; HTTP via `app.inject()` (no sockets) | every REST route (happy + failure path), SSE frame semantics, the agent-loop golden scenarios, the illustration golden scenarios, lifecycle/restart tests, contract test | < 2 min |
| **E2E** | Playwright (chromium) | the real server process over real sockets, `COWRITE_MOCK_LLM=1`, temp data dir | the M1 flow specs (§6.3): real browser, real SSE, real virtualized rendering | < 8 min |
| **Manual eval** | a human + real endpoints | user-configured high/low models + ComfyUI | prose voice, instruction-following, summary quality, illustration quality, budget/threshold tuning | M1.5 (§10) |

**What is explicitly *not* tested automatically:**

- **Real-model output quality** — whether the continue prose keeps the voice, whether summaries
  are substitutable, whether illustrations look good. No LLM-judge harness in MVP; the manual
  eval loop (§10) owns it, using artifacts the system records anyway.
- **Visual aesthetics** — typography, tint subtlety, layout taste. E2e asserts structure and
  behavior via `data-testid`, never pixels; no screenshot diffing in MVP (a novel-view app's
  screenshots churn with content).
- **Real ComfyUI / real endpoint compatibility matrices** — the mock implements the documented
  API subset (08 §2.1); divergent real installs are an M1.5 finding, not a CI matrix.

Placement rule: a bug must be catchable at the tier where its logic lives. If an e2e spec is the
only thing that would catch a decay-math regression, the engine test suite is missing a case —
e2e specs exist to catch *wiring* regressions (events → cache → DOM), not logic.

---

## 2. `packages/mock-llm`

One package, three exports, one scenario mechanism. The mock's fidelity requirements come from
the harness (05 §12) and the illustration pipeline (08 §11); this section owns the package
design and the tier wiring.

### 2.1 Package layout

```
packages/mock-llm/
  package.json                # @cowrite/mock-llm; deps: fastify, ws, zod, @cowrite/shared
  src/
    index.ts                  # re-exports below
    scenario.ts               # Scenario engine: ordered steps, matching, loud-fail, reset
    server.ts                 # createMockLlm(): OpenAI-compatible Fastify server
    fake.ts                   # FakeLlmClient: implements 05's LlmClient, no HTTP
    comfy.ts                  # createMockComfy(): mock ComfyUI (HTTP + /ws)
    improviser.ts             # default scenario: seeded-RNG deterministic prose
    png.ts                    # fixture PNG loader + tEXt-chunk prompt embedding
  scenarios/                  # golden scenario fixtures (JSON), shared with 05/08 tests
    continue-happy.json  continue-with-tools.json  format-miss-then-repair.json
    429-then-ok.json  die-mid-write-keep-partial.json  hang-first-token.json
    boundary-garbage.json  golden-prefix.json  edit-multi-target.json
    comfy-accept-first.json  comfy-best-of-three.json  comfy-budget-exhausted.json
    comfy-exec-error-then-ok.json  comfy-ws-drop.json  …
  fixtures/
    gradient.png  portrait.png          # tiny PNGs served by the mock ComfyUI
```

### 2.2 The scenario engine

A **scenario** is an ordered list of steps. Each incoming request is matched against the *next*
step's predicate; a match consumes the step and executes its `respond`; a mismatch (or a request
arriving after the list is exhausted) throws, failing the test with the full request logged.
`scenario.assertDrained()` at test end catches steps that never fired.

Step schemas (Zod, in `scenario.ts`; the LLM shape is fixed by 05 §12, the ComfyUI shape by
08 §11):

```ts
export const MockStep = z.object({           // one /v1/chat/completions exchange
  match: z.object({
    model: z.string().optional(),            // assert lane routing (mock-high vs mock-low)
    lastMessageIncludes: z.string().optional(),
    hasTools: z.boolean().optional(),
    toolChoice: z.enum(["auto", "none"]).optional(),
  }).default({}),
  respond: z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), text: z.string(),
               tokenDelayMs: z.number().default(0), usage: z.boolean().default(true) }),
    z.object({ type: z.literal("toolCalls"),
               calls: z.array(z.object({ name: z.string(), input: z.unknown() })) }),
    z.object({ type: z.literal("error"), status: z.number(),          // 429/500/401 …
               retryAfterMs: z.number().optional() }),                // honored Retry-After
    z.object({ type: z.literal("dieMidStream"), afterChars: z.number() }),
    z.object({ type: z.literal("hang"), forMs: z.number() }),         // timeout ladder
  ]),
});

export const MockComfyStep = z.object({      // one POST /prompt job
  match: z.object({ promptIncludes: z.string().optional() }).default({}),
  respond: z.discriminatedUnion("type", [
    z.object({ type: z.literal("image"),
               fixture: z.string().default("gradient.png"),
               queueMs: z.number().default(0), execMs: z.number().default(50),
               progressTicks: z.number().default(4),
               embedPromptText: z.boolean().default(true) }),  // injected prompt → PNG tEXt chunk
    z.object({ type: z.literal("rejectSubmit"), nodeErrors: z.record(z.string(), z.unknown()) }),
    z.object({ type: z.literal("executionError"), nodeId: z.string(), message: z.string() }),
    z.object({ type: z.literal("dropWs") }),                   // forces the /history polling path
    z.object({ type: z.literal("hang"), ms: z.number().optional() }), // delay execution_start by
                                                              // `ms` (default 0), then hang
                                                              // indefinitely — /interrupt or
                                                              // /queue {delete} is the only exit
  ]),
});
```

`embedPromptText` is the end-to-end injection probe: the mock writes the `%prompt%` text it
received into a PNG `tEXt` chunk, so a test can assert — from the committed bytes on disk — that
compose → inject → generate → commit carried the right prompt, with no white-box hooks.

Scenarios are declared two ways:

```ts
// In-process (unit/integration): typed, colocated with the test
const llm = await createMockLlm();
llm.scenario([
  { match: { model: "mock-high", hasTools: true },
    respond: { type: "toolCalls", calls: [{ name: "context_expand",
               input: { kind: "section", id: ids.ch7, level: "full" } }] } },
  { respond: { type: "text", text: "<snippet id=\"new\">Mara pressed…</snippet>" } },
]);
// … drive the app … then:
llm.assertDrained();

// Over HTTP (e2e): the same JSON via the control route
await request.post("/__mock/llm/enqueue", { data: scenarioJson });
```

### 2.3 The three faces of the mock

| Export | Transport | Tier | Notes |
|---|---|---|---|
| `FakeLlmClient(scenario)` | none — implements 05's `LlmClient` directly | pure unit (runner loop, tag parser, retry ladder, abort propagation) | same `MockStep` schema; deltas can be re-chunked at arbitrary boundaries for split-anywhere parser tests |
| `createMockLlm()` | `node:http` on an ephemeral port; `POST /v1/chat/completions` (SSE streaming, `stream_options.include_usage`), `GET /v1/models` (config probe target, 03 §3.12) | integration, e2e, manual | one server, both lanes: tests configure `models.high.model = "mock-high"`, `models.low.model = "mock-low"` so routing is assertable via `match.model` |
| `createMockComfy()` | `node:http` + `ws` on an ephemeral port; the full 08 §2.1 subset: `/prompt`, `/ws`, `/history/:id`, `/view`, `/system_stats`, `/interrupt`, `/queue` delete | integration, e2e, manual | honors interrupt/dequeue (emits `execution_interrupted`); serves fixture PNGs. `createMockComfy({ autoSucceed: true })` is an opt-in: an unscripted `POST /prompt` on an empty queue renders a plain always-succeed image instead of failing loudly — the demo/e2e posture (`pnpm mock:comfy`, `--mock`), never the hermetic-test default, which keeps the strict "unmatched request is a bug" behavior |

### 2.4 Wiring per tier

- **Unit:** no HTTP. `FakeLlmClient` is passed straight into the runner; the illustration loop
  gets a stub `ComfyClient`.
- **Integration:** tests call `createMockLlm()`/`createMockComfy()` on ephemeral ports, then
  `buildApp(deps)` (03 §5.1) with a config object whose `models.high.baseUrl` /
  `models.low.baseUrl` / `comfyui.baseUrl` point at the mocks — **config-pointing, no env flag**.
  The app is driven by `app.inject()`; SSE is read by injecting a request with
  `accept: text/event-stream` and parsing frames. Scenario control is in-process (same test
  file), so tests stay hermetic and parallelizable.
- **E2E / manual dev:** `COWRITE_MOCK_LLM=1` (or `--mock`) makes the server boot the mocks
  in-process and point the lanes (and, Stage 5, `comfyui`) at them (03 §9.3). Each mock
  serves its OWN control routes on its own port (`MOCK_LLM_PORT`, 2700 in e2e — never
  mounted under the app):

  | Route (on the mock's port) | Purpose |
  |---|---|
  | `POST /__mock/scenario` | append `LlmStep[]` / `ComfyStep[]` to the scenario queue |
  | `POST /__mock/reset` | clear the scenario queue, consumption history, and captured requests |
  | `GET /__mock/state` | pending steps + consumed count + errors (assert drained from e2e) |

  With no enqueued scenario the mocks run the **improviser**: deterministic seeded-RNG prose at
  20 ms/token and an always-succeed ComfyUI returning fixture PNGs — the whole app demos offline
  with zero setup. `pnpm mock:llm` / `pnpm mock:comfy` run the servers standalone for poking at
  the real client code by hand.

*Rejected:* VCR-style record/replay (creative-prose responses are not stable enough to record
once); per-test HTTP interception like `msw` (cannot serve the e2e and manual tiers; two mock
mechanisms would drift); a permissive default-response mode outside the improviser (silent
fallthrough hides broken matching).

---

## 3. Deterministic fixtures and golden files

### 3.1 Determinism seams

Golden files and property tests only work if identical inputs give identical bytes. Every source
of nondeterminism is an injected dependency, fixed by tests:

| Seam | Injection point | Test value |
|---|---|---|
| Wall clock | `now?: () => Date` (engine `EngineDeps`, storage, scheduler) | fixed epoch, advanced manually |
| ULIDs | `ids?: () => Ulid` factory in `StorageService` construction | seeded counter ULIDs (`01TEST…0001`, sortable) |
| Seeds (illustration, improviser) | seeded PRNG injected into the pipeline / improviser | fixed seed per test |
| Timers (debounce, sweeps, heartbeats, grace windows) | plain `setTimeout` — controlled with Vitest fake timers in unit/integration | `vi.advanceTimersByTime` |
| Token counts | real `gpt-tokenizer` (deterministic by nature) | no injection needed |

### 3.2 Fixture builders

One builder module, `apps/server/src/testing/fixtures.ts`, used by unit, integration, and the
e2e global setup (imported as workspace TS source — tsx and Playwright's node runner both handle
it):

```ts
// Declarative work builder: writes a valid on-disk work via the real StorageService,
// with the seeded id factory and fixed clock, so output is byte-stable.
buildWork(dir: string, spec: {
  title: string;
  chapters?: Array<{ title: string; words: number;          // lorem-ish seeded prose
                     short?: boolean; long?: boolean;       // enrichment files present?
                     illustration?: boolean }>;             // fixture PNG + meta
  snippets?: Array<{ words: number; authorship: "user" | "agent" }>;
  world?: Array<{ name: string; keys?: string[]; words?: number }>;
  situation?: string;
}): Promise<{ workId: Ulid; ids: Record<string, Ulid> }>;

// The two named seeds:
seedTiny(dir)    // 1 work: 2 snippets, 2 world entries (one with key "storm glass"), no sections
seedNovel(dir)   // 1 work: 30 frozen chapters × ~6,500 words ≈ 200k words, all enriched
                 //   (short+long+illustration), 12 snippets live, 40 world entries —
                 //   the perf / fold-ladder / virtualization fixture
```

`seedNovel` is generated, not checked in (200k words of prose has no business in git): the
builder is deterministic, so CI regenerates identical bytes; the nightly perf job caches the
generated directory keyed on the builder's content hash. `seedTiny`'s *expected outputs* (index
rows, prompt renders) are checked in as goldens.

### 3.3 Golden-file policy

Golden files are checked-in expected outputs, compared byte-for-byte (after LF normalization —
`.gitattributes` already forces LF):

| Golden set | Location | Covers |
|---|---|---|
| **Prompt renders** | `apps/server/src/context/__tests__/goldens/*.txt` | full assembled first-user-message per interactive task kind (`continue`, `instructed-continue`, `quick-edit`) against `seedTiny` and a mid-size state; plus the `<local-context-refresh>` turn; plus one render per background handler (`enrich-section`, `propose-boundaries`) and the illustration compose brief |
| **Golden prefix** (the cache contract) | same dir | assemble → elevate one item → reassemble: byte-identical prefix through `<voice-anchors>`, change is a pure append in `<expanded-context>`; repeated across frontier growth, a consolidation event, and a single-anchor re-derive (06 §13). Pairs with the harness-side golden-prefix scenario asserting byte-identical *request* prefixes and an identical `tools` array between planning round N and the composition call (05 §12) |
| **Consolidation output** | `apps/server/src/storage/__tests__/goldens/` | given a scripted frontier + a fixed `BoundaryProposal`: the resulting `section.json`, `content.md` (blank-line joins, scene-break markers verbatim), and `history.jsonl` |
| **Golden directory → index** | same dir | fixture work dir in → expected SQLite rows out (dumped as sorted JSON), for both full rebuild and incremental paths — the two must be identical (02 §12) |
| **First-run config template** | `apps/server/src/config/__tests__/goldens/` | the commented template parses against `AppConfig`, and so does the empty object — the named Zod-4 exhaustive-record regression (03 §12) |

Rules: goldens update only via an explicit `pnpm test -- -u` whose diff is reviewed in the PR —
a golden diff is a *contract change*, and the PR description must say why. No timestamps, real
ULIDs, or absolute paths may appear in a golden (the §3.1 seams make this structural, not a
scrubbing regex). Inline `toMatchInlineSnapshot` is allowed only for values under ~5 lines.

---

## 4. Pure-unit tier: inventory

What each package must cover at this tier (details and edge-case lists live in the owning docs;
this is the checklist CI enforces coverage against):

**`apps/server` — storage (02 §12):** entity round-trips through the shared Zod schemas;
fractional-index generation incl. reserved keys (property: any insertion sequence yields
strictly ordered, filename-sortable keys); atomic-write helper; lock nonce re-validation and
dead-pid staleness; staleness derivation table (§6.5 rules, incl. missing-counts-as-stale and
tombstone-never-stale); adoption rules per directory.

**`apps/server` — context engine (06 §13):** `defaults.ts` (total-coverage invariant,
skeleton/world demotion order), `anchors.ts` (stratification determinism, per-excerpt
re-derive), `decay.ts` (TTL math, overage steps, eviction `keepScore` order; the pinned
regression: *opened via tool, composed immediately, no `finish_planning` ⇒ ttl = 3, not 1*),
`assemble.ts` (region order, `ContextSnapshot` totals), `estimate.ts` hash-cache behavior;
properties: post-`enforce` ≤ hardCap, coverage invariant on random trees, ledger round-trip
through `state.json`, `handleToolCall` idempotence (same args ⇒ identical bytes).

**`apps/server` — harness (05 §12):** `TagBlockParser` property-tested against split-anywhere
chunking; prose-is-composition path; repair-turn once-only; retry ladder classification
(retryable vs not, Retry-After honored); commit/conflict logic per target kind; run-sink flush
cadence (fake timers).

**`apps/server` — illustration (08 §11):** `inject()` (property: output differs from the
template only at mapped fields; template never mutated); registry validation matrix (missing/
duplicate `%prompt%`, missing `%seed%`, output-node rule incl. whitelist fallback, dangling
`route`); `CritiqueResult` parse/repair + accept rule + `asRevise` coercion; best-of math
(`[6, 8, 4]` picks attempt 2; early accept stops); budget-gate arithmetic.

**`apps/server` — config/API pure parts (03 §12):** precedence table (defaults < file < env <
flags), `${env:}` interpolation, redaction round-trip, hot-apply vs `restartRequired`
classification, error-code → status map, host-guard hostname logic.

**`apps/web` (04 §15.1):** `foldPolicy` (table-driven distance→level + override + degradation),
`dialogue` quote pairing, `worldMatcher` (Aho–Corasick boundaries/overlaps/case/multi-word/
first-per-block), `anchoring` math under simulated height mutations, `useDocBlocks` snapshots,
the SSE reducer — every `WorkEvent` row as a case against a seeded QueryClient + stores,
including the lane-routing fence (a background `task.started` mid-interactive-stream must not
touch the slot). Component tests (jsdom): editor keys + editing-signal calls, revision cycler,
selection toolbar.

**`packages/shared`:** schema sanity (defaults produce valid objects; enum spellings — TaskKind
kebab-case, events dot-case — locked by test so a rename is a deliberate contract change).

---

## 5. Integration tier: `app.inject()` + temp dir + mocks

Pattern for every integration test:

```ts
const dir = await mkdtemp(join(tmpdir(), "cowrite-it-"));   // never shell mktemp
const llm = await createMockLlm();  const comfy = await createMockComfy();
const app = await buildApp(testDeps({ dataDir: dir, llmUrl: llm.url, comfyUrl: comfy.url,
                                      ids: seededUlids(), now: fixedClock() }));
// drive with app.inject(); assert: HTTP bodies (Zod-parsed), SSE frames, files on disk,
// index rows, run JSONL (parsed against RunEvent), mock scenario drained.
```

Coverage obligations (consolidating 03 §12, 05 §12, 08 §11):

- **Route matrix:** every endpoint in 03 §3 has at least one happy-path and one failure-path
  test asserting the error envelope; the **contract test** walks the Fastify route table and
  asserts every schema is identity-equal to a `packages/shared` export and the `api.ts` registry
  and route table match 1:1 both ways.
- **SSE semantics:** ordering (domain event follows its REST 2xx), `Last-Event-ID` byte-exact
  replay, ring overflow ⇒ `resync` + `task.snapshot` carrying accumulated text, fresh-connect
  synthetic sequence while a task streams, heartbeat cadence and the ≤ 30 deltas/s throttle
  (fake timers).
- **Agent-loop golden scenarios** (fixtures in `packages/mock-llm/scenarios/`, names shared with
  05): `continue-happy`, `continue-with-tools` (2 rounds + `finish_planning` + refresh turn —
  also asserts ledger TTLs and the run `meta` snapshot), `edit-multi-target`,
  `format-miss-then-repair`, `429-then-ok`, `die-mid-write-keep-partial` (incl.
  apply-after-restart, §7), `hang-first-token`, `boundary-garbage`, `golden-prefix`.
- **Illustration golden scenarios** (08 §11 list): `illustrate-accept-first`,
  `illustrate-revise-then-accept`, `illustrate-best-of-three` (committed PNG identified via the
  tEXt-embedded prompt), `budget-exhausted-commits-best`, `comfy-400-invalid`,
  `exec-error-then-ok`, `exec-error-consumes-slot`, `ws-drop-poll-fallback`,
  `hang-exec-timeout`, `cancel-mid-generate`, `world-image-happy`, `upload-then-sweep-skips`,
  `delete-writes-tombstone` + `illustrate-clears-tombstone`,
  `entities-drive-established-imagery`.
- **Storage-through-API races:** the §7 matrix rows that involve HTTP (editing signal,
  proposal apply after restart, undo-cancels-enrichment).
- **Config:** probe endpoints against the mock (`GET /v1/models` + 1-token ping;
  `/system_stats`), candidate deep-merge semantics, first-run template regression.

Isolation: one temp dir per test file, deleted in `afterAll` (Windows: only after `app.close()`
— open handles block directory removal, same ordering as 03 §4.3). Integration tests run fully
parallel; each file owns its own app + mocks + dir.

---

## 6. Playwright e2e

### 6.1 Configuration (Windows-portable by construction)

Lives in `apps/web/e2e`. The config from 04 §15.2 is normative; the portability rules it encodes:

```ts
// apps/web/playwright.config.ts — no shell-isms anywhere
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Fixed ports (constants in e2e/util.ts): 2698 = e2e server (never the 2697 default, so a
// running dev server can't collide); 2700 = the in-process mock LLM's control routes
// (COWRITE_MOCK_LLM=1 + MOCK_LLM_PORT); 2699 = the restart spec's own server.
const dataDir = mkdtempSync(join(tmpdir(), "cowrite-e2e-data-"));   // never `mktemp`
export default defineConfig({
  testDir: "e2e",
  workers: 1, fullyParallel: false,      // one server, global mock scenario state (§6.2)
  webServer: {
    command: "pnpm --filter @cowrite/server start",
    env: { COWRITE_DATA_DIR: dataDir, COWRITE_MOCK_LLM: "1",
           COWRITE_PORT: "2698", MOCK_LLM_PORT: "2700",
           COWRITE_HOME: mkdtempSync(join(tmpdir(), "cowrite-e2e-home-")) },
    url: "http://127.0.0.1:2698/api/health",                   // readiness probe (03 §3.12)
  },
  projects: [{ name: "chromium", use: devices["Desktop Chrome"] }],  // one browser: localhost app
});
```

| Rule | Why |
|---|---|
| Env vars go in the `env` object, never inline `FOO=1 cmd` | inline env is a POSIX-ism; breaks cmd/PowerShell |
| `mkdtempSync` + `node:os.tmpdir()` + `node:path.join`, never `mktemp`/`/tmp` | no shell, no hardcoded separators |
| `127.0.0.1`, never `localhost`, in URLs | Windows IPv6 resolution surprises (03 §10.3) |
| npm scripts stay shell-free (`&&` ok; no `$VAR`, no `cp -r`); anything conditional is `node scripts/*.mjs` | runs identically under cmd |
| Waits on visible state (`toBeVisible`, `toHaveText`), never `waitForTimeout` | flake-free on slow runners of either OS |
| Selectors only via `data-testid` constants imported from `apps/web/src/testids.ts` | renames break compile, not CI |

Windows e2e in CI is deferred (03 §13); these rules exist so the suite runs unmodified on a
Windows dev machine and so flipping on a `windows-latest` e2e job later is a one-line change.

### 6.2 Server, data, and scenario lifecycle

- **One server for the whole run** (the `webServer` above), one `mkdtemp` data dir. Specs
  isolate by **work**, not by data dir: each spec file creates its own fresh work (or copies a
  seed via the fixture builder in a `beforeAll` that calls `seedTiny`/`seedNovel` into the
  shared data dir under a unique slug, then hits `POST /api/config/reload`-free paths — works
  are discovered by directory scan, 03 §3.1).
- **Mock scenarios are enqueued per test** via `POST /__mock/scenario` on each mock's own
  fixed port (LLM on 2700; the ComfyUI mock gets its own when Stage 5 lands), with
  `POST /__mock/reset` at the top of every task-running test. Because scenario state is
  server-global, the suite runs with `workers: 1` — acceptable at M1's spec count; if the
  suite outgrows it, scenario scoping by work id is the structured-for extension.
- **The resilience spec is the exception:** it launches and kills its own server process (a
  `launchServer(dataDir)` helper spawning the same command with `child_process`, no shell) so it
  can assert restart recovery without murdering the shared `webServer`.

### 6.3 The M1 flow specs

Adopted from 04 §15.2 with two adjustments: a `first-run-setup` spec is added (the
config-missing path deserves e2e coverage, §7), and spec 7 (`edit-task-meter`) ships with the
M2 pane. One spec file each:

| # | Spec | Asserts |
|---|---|---|
| 0 | **first-run-setup** | boot with empty config dir → app redirects to `/settings` in welcome layout → fill the mock endpoints into the High/Low cards → **Test** returns ok (probe against the mock) → Save → works list. Then: with `models.high` cleared via `PUT /api/config`, the Continue button produces the `config_missing` callout linking to settings, never a bare toast. |
| 1 | **write-and-continue** | create work → ＋ snippet → type → Ctrl-Enter save → Continue → planning notes appear (`task.tool`) → streamed text appears → block commits; snippet count, authorship tint testid, followBottom autoscroll. |
| 2 | **edit-cycle-rollback** | double-click, edit, save; Alt-← shows rev 1; Restore → rev 3 exists with rev-1 text; provenance chip opens the run viewer showing the mock prompt regions (from `ContextSnapshot`). |
| 3 | **fold-ladder** | open the `novel` seed; assert the ladder (2 full / 4 long / 8 short / rest name) via testids; pin a `name` chapter to `full`; assert the lazy content request fired and the pinned header's scroll position held (±2 px); reload → pin persisted. |
| 4 | **anchoring-under-load** | scroll to mid-document, trigger consolidation via API, assert the viewport anchor block is unchanged. |
| 5 | **instruct-and-quick-edit** | instruct-continue with the instruction visible in the stream header; select a snippet → quick edit → target shimmers (no mid-document token rendering) → new revision arrives and swaps atomically. |
| 6 | **world-flow** | create entry with key "storm glass" → underline appears in visible prose → hovercard shows summary → click navigates to the entry → generate image (mock ComfyUI; phase captions assert) → thumbnail appears. |
| 7 | **edit-task-meter** *(M2)* | pane meter matches `POST /context/preview`; launch records selections in `/context/state`. |
| 8 | **resilience** | own-server spec: kill the server mid-stream; streaming block shows buffered text + "connection lost"; restart; after reconnect the keep/discard surface appears and **Keep** commits with agent authorship (provenance chip on the resulting snippet). |
| 9 | **background-during-stream** | start a Continue; mid-stream trigger consolidation so an `enrich-section` starts; the streaming block keeps rendering continue prose, frontier buttons stay in their continue state, the background badge appears (task-store lane-routing fence). |
| 10 | **consolidation-under-edit** | open an editor on an old eligible frontier snippet; trigger consolidation via API; the edited snippet survives in the frontier (editing signal honored) while earlier snippets froze; the save then succeeds. |

---

## 7. Failure-mode test matrix

The cross-cutting races the design worried about, each pinned to a named test. Subsystem
failure-mode tables (02 §12, 03 §11, 05 §11, 06 §12, 08 §10) list many more single-subsystem
rows; this matrix is the cross-subsystem set that no one doc owns alone.

| Race / failure | Named test | Tier |
|---|---|---|
| **Consolidation vs open editor** (freeze the snippet under the cursor) | `consolidation.editing-guard` — set the editing signal, trigger consolidation, assert the eligible prefix excluded the snippet and the later save succeeds | integration + e2e spec 10 |
| Consolidation vs running task target | `consolidation.task-target-guard` — quick-edit in flight; consolidation excludes its target (harness-supplied ids) | integration |
| Edit lands between consolidation plan and apply | `consolidation.midflight-edit-folded` — revise a consumed snippet while the (mocked) boundary agent thinks; assert the newer text is in `content.md` | integration |
| Consolidation undo vs enrichment of the frozen section | `consolidation.undo-cancels-enrichment` — undo within grace; assert `cancelByTarget` fired before directory removal and no orphan writes | integration |
| Crash mid-consolidation (every journal step) | `journal.kill-matrix` — property test injecting a kill at every step incl. inside the step-3 move loop; replay rolls forward or back; a file in both section and frontier resolves section-wins | property |
| **Restart mid-task** | `lifecycle.restart-recovery` — kill `buildApp` mid-stream, rebuild on the same temp dir; run finalized `crash`; `GET /tasks` empty by design; `GET /runs/:r` has the partial; proposal apply still commits with `authorship: "agent"` + `originRunId` | integration + e2e spec 8 |
| **SSE reconnect resume** | `sse.replay-exact` (Last-Event-ID gap replayed byte-exactly), `sse.ring-overflow-resync` (overflow ⇒ `resync` + `task.snapshot` with accumulated text), `sse.fresh-connect-snapshot` (synthetic `task.started`/`stage`/`snapshot` while streaming), `sse.stream-id-mismatch` (restart ⇒ `resync`) | integration |
| **Keep-partial recovery** | scenario `die-mid-write-keep-partial` — composition dies after N chars on every retry; `task.failed` carries the longest partial; apply via the proposal route commits it; **rerun apply after a simulated restart** (proposal reconstructed from run JSONL); second apply ⇒ `409 conflict` (idempotence) | integration |
| **External file edits** | `reconciler.fuzz` — property test applying random rename/edit/delete/add/strip-frontmatter mutations; invariants: *no user file is ever deleted*, *post-reconcile index == fresh rebuild*; `reconciler.adoption-rules` — per-directory table incl. short-id re-association; `situation.theirs-mine-409` — external situation edit ⇒ `PUT` returns 409 with current text | property + integration |
| **Config-missing first run** | `config.first-run-template-parses` (template + empty object vs `AppConfig`), `tasks.config-missing-409` (unconfigured lane ⇒ task never enqueued; editor still fully writable), `config.workflow-invalid-task-time` (broken/dangling workflow ⇒ `config_missing` at use, never a failed boot) | unit + integration + e2e spec 0 |
| Two writers (second instance / suspend-resume) | `lock.second-instance-readonly`, `lock.nonce-revalidation` (foreign nonce after simulated clock jump ⇒ drop to read-only) | unit + integration |
| Crash between consolidation and enrichment | `staleness.missing-counts-as-stale` — frozen section with no summary is picked up by the next sweep with zero persisted queue state | integration |
| Boundary agent garbage / unreachable | scenario `boundary-garbage` — invalid `<boundaries>` JSON ⇒ deferral with capped in-memory back-off; nudge event after 3 deferrals | integration |
| Delete-while-streaming on Windows | `lifecycle.delete-teardown-order` — injected fakes observe close-handles-before-rename ordering | integration |
| Illustration commit target gone | scenario `commit-target-missing` — section deleted during the run ⇒ quiet fail, sweep re-enqueues | integration |

Rule: every row in this table is a merge blocker for the stage that introduces the mechanism
(10-roadmap stage 6 is where the full matrix must be green).

---

## 8. Performance budgets

Design docs state numbers; these are the ones cheap enough to assert. All perf assertions run in
the **nightly** job (§9) against the `novel` fixture (~200k words, 30 chapters, 40 entries) on a
pinned runner class, asserting at headroom multiples so a green run means the design number
holds with margin and a red run means something regressed structurally, not that CI was busy.

| Budget | Design number (source) | Asserted (≈2–3× headroom) | Named test |
|---|---|---|---|
| Full index rebuild, core tables (sections/frontier/world/situation) | < 2 s for a 200k-word work (02 §7.3) | < 4 s | `perf.index-rebuild` |
| Run-table backfill during rebuild reads only first+last JSONL lines | — (02 §7.3) | 1,000 synthetic run files add < 1 s | `perf.rebuild-run-backfill` |
| `GET /sections` payload | ≲ 1 MB at 300–500 rows with inlined summaries (03 §3.2) | < 1 MB on `novel` (structural assert, not timing — runs on every push) | `perf.sections-payload` |
| Reconciler fast path (no changes, size/mtime match) | "fast path, no read" (02 §8) | full scan of `novel` < 300 ms | `perf.reconcile-noop` |
| First `/context/candidates` tokenization pass | ~1 s one-time on a novel (06 §8.3) | < 2.5 s cold; < 100 ms warm (hash cache) | `perf.candidates-cold-warm` |
| Prompt assembly, warm cache (`continue` on `novel`) | — (must feel instant; baseline map ≈ 17–25k tokens, 06 §8.1) | < 500 ms | `perf.assemble-warm` |
| `task.delta` throttle | ≤ 30 events/s per task (03 §8.2) | exact, with fake timers — every push, not nightly | `sse.delta-throttle` |
| Run-file output flush cadence | ≥ every 2 s or 2 KB (05 §7.1) | exact, fake timers — every push | `runsink.flush-cadence` |
| SSE heartbeat | comment every 15 s (03 §8.2) | exact, fake timers — every push | `sse.heartbeat` |
| Mounted-block decoration scan (worldMatcher) | ~50k chars sub-millisecond (04 §6.3) | < 10 ms for 25 blocks × 2k words (jsdom, generous) | `perf.world-matcher` |

Frontend render-latency budgets (60 fps scrolling, 30 fps stream flush) are **not** asserted in
CI — headless timing of React commits is noise; they are watched in the manual eval loop with
the React profiler, and their *mechanisms* (rAF batching, memoization keys, virtualizer mount
count ≤ 25) are asserted structurally in unit tests instead.

---

## 9. CI wiring

`.github/workflows/ci.yml` currently runs a single Ubuntu job (`lint`, `typecheck`, `test`,
`build`); it grows into this shape as the roadmap stages land — the root scripts (`pnpm lint`,
`pnpm typecheck`, `pnpm test`, `pnpm build`) stay the only entry points so local and CI runs are
identical:

**On every push / PR:**

| Job | OS | Runs |
|---|---|---|
| `checks` | ubuntu-latest, **windows-latest** (matrix) | `pnpm install --frozen-lockfile` → `pnpm lint` (Biome; ubuntu only — formatting is OS-independent) → `pnpm typecheck` → `pnpm test` (unit + property [bounded runs] + integration, all packages) → `pnpm build` |
| `e2e` | ubuntu-latest | `pnpm build` → `playwright install chromium` → M1 specs (§6.3) against the built app; traces + videos retained on failure only |
| `docker` | ubuntu-latest | `docker build` of both `runtime` and `dev` targets — smoke only, no run (03 §12) |

**Nightly (cron):**

| Job | Runs |
|---|---|
| `perf` | regenerate/restore the `novel` fixture → the §8 `perf.*` suite on a pinned runner class |
| `property-extended` | property/fuzz suites with 20× the per-push iteration budget (journal kill matrix, reconciler fuzz, tag-parser chunking, index invariants) |
| `e2e-full` | the e2e suite with tracing always on, plus the improviser soak: 20 consecutive mock continues on one work asserting no SSE/queue leaks |

Policy: nothing merges red (10-roadmap working agreement); perf and extended-property failures
open an issue rather than blocking merges (they run against `main`), but a perf regression must
be triaged before the next stage PR merges. Windows e2e in CI: deferred (§6.1); the checks
matrix keeps the server and test config honest on Windows meanwhile.

---

## 10. The manual eval loop (M1.5)

Prose and illustration *quality* against real models is out of automation's reach in MVP — no
LLM-judge harness, no golden prose. It is covered by a deliberate manual loop, run in the dev
container against the user's real endpoints once M1 is green (10-roadmap M1.5). The system
already records everything the loop needs; no new machinery ships for it.

**Inputs the system provides:** run JSONL files (full prompts, tool calls, outputs, usage —
"inspect exactly the prompt that produced it" via the provenance viewer), the engine's
`usage.jsonl` (`task_start` region sizes, `tool_call`s, `cache_break` events — real cache-hit
rates), per-run token/cost figures, and `IllustrationMeta` (prompt/seed/score/attempts per
committed image).

**The loop, per iteration:**

1. Write ~10 pages across two seeded story premises using only the app (continue / instruct /
   quick-edit), letting consolidation, enrichment, and illustration run.
2. Score against a fixed checklist, one line per run in a findings note: voice consistency at
   the frontier (does the model's prose match the anchors?), instruction adherence
   (instructed-continue and quick-edit did what was asked, nothing more), summary
   substitutability (spot-check: does a chapter's short summary + prior context stand in for the
   text?), boundary quality (do proposed chapter breaks land on scene seams?), illustration
   subject/consistency/craft/mood (the critic's own rubric, human-scored), and latency feel.
3. Check `usage.jsonl` for cache breaks that shouldn't happen and budget overruns; check cost
   per page.
4. Adjust: prompt templates in `prompts/*.md` (hot-reloaded via tsx watch — edit, restart,
   retry), budget knobs (`config.budgets`), consolidation thresholds, the illustration rubric
   wording. Re-run.

**Deliverable:** revised defaults plus a short findings note appended to doc 07
(10-roadmap M1.5). Anything that turns out to be mechanically checkable (e.g. "the model keeps
emitting preamble before the tag block") graduates into a mock scenario + automated test at the
appropriate tier — the manual loop is a source of regressions to automate, not a permanent
substitute for them.

---

## 11. MVP cut

**M1:** `packages/mock-llm` complete (LLM + ComfyUI servers, `FakeLlmClient`, scenario engine,
improviser, control routes under `COWRITE_MOCK_LLM=1`, golden scenario fixtures); fixture
builders + `tiny`/`novel` seeds; the full unit/property inventory of §4; the integration
obligations of §5; e2e specs 0–6 and 8–10; the §7 failure-mode matrix green (roadmap stage 6
exit); the every-push cadence tests (`sse.delta-throttle`, `runsink.flush-cadence`,
`sse.heartbeat`, `perf.sections-payload`); CI: checks matrix (ubuntu + windows), e2e (ubuntu),
docker smoke.

**M2:** e2e spec 7 (`edit-task-meter`) with the pane; scenario coverage for `edit-task`
multi-target commits and `contextSelections` validation; candidate-picker scenarios (08 M2);
nightly perf + extended-property jobs if not already landed during M1 hardening.

**Structured-for, deferred:** Windows e2e in CI; per-work-scoped mock scenarios (unlocks
`workers > 1` e2e); screenshot/visual regression; an LLM-judge eval harness over the manual
checklist (the run files and `usage.jsonl` are its training data); load/soak beyond the nightly
improviser soak.

---

## 12. Contracts

This subsystem **owns**:

| Contract | Where | Consumers |
|---|---|---|
| `MockStep`, `MockComfyStep`, the scenario engine (ordered, loud-fail, `assertDrained`) | `packages/mock-llm/src/scenario.ts` | 05 §12 (harness tests), 08 §11 (pipeline tests), all integration/e2e tests |
| `createMockLlm()` (OpenAI-compatible: `/v1/chat/completions` SSE, `/v1/models`), `createMockComfy()` (08 §2.1 subset incl. `/ws`, `/interrupt`) | `packages/mock-llm/src/{server,comfy}.ts` | integration tier, `COWRITE_MOCK_LLM=1` boot (03 §9.3), `pnpm mock:*` |
| `FakeLlmClient` (in-memory `LlmClient` impl) | `packages/mock-llm/src/fake.ts` | 05 unit tests |
| `/__mock/llm/enqueue`, `/__mock/comfy/enqueue`, `/__mock/reset`, `/__mock/state` control routes (mounted by the server only under `COWRITE_MOCK_LLM=1`) | registered via 03's app wiring | Playwright specs, manual dev |
| Golden scenario fixture names (`continue-happy`, `golden-prefix`, `die-mid-write-keep-partial`, `comfy-best-of-three`, …) | `packages/mock-llm/scenarios/` | 05 §12 and 08 §11 reference them by name |
| Fixture builders `buildWork`, `seedTiny`, `seedNovel` | `apps/server/src/testing/fixtures.ts` | server unit/integration, e2e global setup, nightly perf |
| The failure-mode matrix names (§7), perf budget asserts (§8), CI job shape (§9), golden-file policy (§3.3) | this doc | roadmap stage 6 exit criteria |

This subsystem **consumes**:

| Contract | Owner | Used for |
|---|---|---|
| `LlmClient`, `RunContext` interfaces | 05 §3.2, §13 | `FakeLlmClient` conformance; pipeline stubs |
| `buildApp(deps)` composition root, `GET /api/health` readiness, `COWRITE_*` env vars incl. `COWRITE_MOCK_LLM` / `--mock` | 03 §5.1, §9.3 | integration harness; Playwright `webServer` |
| `StorageService` + on-disk layout + injected id/clock seams | 02 §11 | fixture builders, golden-directory tests |
| `WorkEvent`, `RunEvent`, `ErrorCode`, and all `packages/shared` schemas | 03 / 05 / 02 / 06 / 08 | every assertion parses wire and file payloads through the shared schemas — tests are contract consumers, not schema authors |
| `testids.ts` constants | 04 §15.2 | the only e2e selector source |
| ComfyUI API subset + `%marker%` semantics (what the mock must implement) | 08 §2 | `createMockComfy()` fidelity |
| Prompt region order / tag grammar (what prompt goldens are checked against) | 06 §5, 07 | golden prompt renders |
| Milestone boundaries and the stage-6 hardening gate | 10-roadmap | which tests block which stage |
