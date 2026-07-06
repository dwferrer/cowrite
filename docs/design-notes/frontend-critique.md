# Critique — Web Frontend Architecture & Interaction Design (`docs/design/frontend.md`)

**Reviewed against:** `docs/00-overview.md` (the only brief present in the repo — the brief path
supplied to this review resolved to `undefined`, same as the proposal's own provenance note) and
the sibling designs it claims alignment with (`data-model.md`, `context-engine.md`,
`agent-harness.md`, `api-deployment.md`).

**Verdict in one line:** a disciplined, mostly buildable design with genuinely good MVP restraint;
but it contains one flagship-loop-breaking state-model flaw (single-active-task store vs.
concurrent background tasks), two data-loss/dead-end paths (consolidation-under-edit, the Undo
toast with no undo flow), and several cross-subsystem contracts asserted but not actually held
(fold-ladder "mirroring", keep-partial provenance, targeted-edit streaming).

---

## 1. Requirement violations / misreadings of the brief

### [blocker] Single-active-task model contradicts the brief's background enrichment — and corrupts the streaming display

`taskStore` (§4.4) is `active: null | { taskId, … buffer … }` — **one slot** — with the comment
"one active generation at a time (server serializes per work)", restated as assumption A5: "one
task per work at a time (UI disables, doesn't queue)."

The brief says the opposite about background work: sections get *"**enriched** in the background
with names, short/long summaries, and one illustration per section"* while "most work happens at
the frontier." The agent harness accordingly runs **concurrent lanes**: interactive (1) +
background (2) + illustration, and consolidation auto-enqueues enrichment tasks the moment a
chapter freezes — i.e., precisely while the user keeps writing. All of these tasks emit
`task.started`/`task.delta`/`task.completed` on the same SSE stream (§4.3 routes every `task.*`
event into this single-slot store).

Failure scenario: user hits Continue; mid-stream, the just-frozen chapter's `enrich-section` task
starts; `task.started` overwrites `taskStore.active`; the streaming block dies or starts
displaying summary-generation deltas as story prose; `task.completed` for the enrichment ends the
"stream" while the continue is still writing. This happens routinely, on the flagship loop.

The doc even knows background tasks exist — §10 renders shimmer overlays from
"enrichment/illustration task SSE" — it just has nowhere to put them.

**Fix:** key task state by `taskId`: one `interactiveTask` slot (drives the streaming block and
button disabling — matching the harness's `interactive` lane and its 409 `busy`) plus a
`Map<taskId, BackgroundTaskState>` for enrichment/illustration progress badges. Filter the SSE
reducer's `task.*` rows by task kind/lane. Reword A5 to "one *interactive* task per work."

### [major] The fold ladder does not "mirror the context engine's fidelity ladder" — the claimed invariant is false

§5.3: "Distance-based defaults + manual override, mirroring the context engine's fidelity ladder
so the user's view and the model's view agree (context-engine §4)", and A4: "Fold ladder constants
intentionally mirror its default fidelity map; if its defaults move, `FOLD_DEFAULTS` moves with
them."

Compare the two maps:

| | Frontend `defaultFold` | Context engine §4 |
|---|---|---|
| Metric | count of leaf sections from frontier | **tokens** (6k frontier prose window), then chapter positions |
| Most recent chapters | d ≤ 1 → `full` **prose** (2 chapters) | frontier *window* only; the 2 chapters before it get `long` **summaries**, never full |
| Next band | 4 chapters `long`, 8 `short` | 2 chapters `long`; **all** remaining same-parent siblings `short` (under the MVP flat scheme that is *every* other chapter — nothing defaults to `name`) |
| Deep past | `name` | `name` only for sub-chapter levels / budget demotion |

They differ in metric, values, and shape, so the "user's view and the model's view agree" claim is
wrong in both directions (the user sees two full chapters the model sees as long summaries; the
model sees `short` for chapters the user sees as name-cards). That's fine as a *UI* policy — but
the doc sells it as a cross-subsystem invariant and couples `FOLD_DEFAULTS` to the engine's knobs,
which is unimplementable because the engine's knobs aren't in the same units.

**Fix:** either (a) drop the mirroring claim and own the fold ladder as pure UI ergonomics (my
recommendation — the visual ladder is good), or (b) actually derive the fold map from the engine's
`GET /context/state` default-fidelity map. Don't ship a false invariant; the first person to debug
"why does the model not know about Chapter 12, I can see it on screen" will be misled by this doc.

### [minor] Unverifiable "brief requirement" citations

§7.1 "Entering edit mode **clears selection** (brief requirement)", §8.1 "the brief's global
gesture" (Ctrl-Enter). Neither appears in the accessible brief (`docs/00-overview.md`). These may
come from a fuller upstream brief that isn't in the repo, but as written the doc launders design
choices as mandates no reviewer can check. **Fix:** quote the source or relabel them as design
decisions.

---

## 2. Designs that won't work as described

### [major] Consolidation can consume the snippet the user is editing (or has selected / is quick-editing) — data-loss dead-end

Data-model §6.2: consolidation fires 30 s after the last frontier *write* and may freeze any
snippet outside the trailing active window (last 6 snippets / 3,000 words). A user who
double-clicks an older frontier snippet (say #2 of 18) and sits in the editor produces no writes,
so the debounce from the previous write expires and consolidation deletes that snippet out from
under the open editor. The frontend's `consolidation.applied` handler (§4.3) just invalidates
`qk.snippets` + `qk.sections`: the block vanishes, `docUiStore.editing` points at a dead
`BlockRef`, and the localStorage crash copy is keyed to a snippet id that no longer exists — the
"Restore unsaved edit?" path can never fire again. Same hole for `selection`/`peekRevision`, and
for a running `quick_edit` whose target gets consolidated mid-task.

Nothing in §5.5 (anchoring handles the *scroll* consequence), §7, or §13 addresses the *state*
consequence.

**Fix (pick one, specify it):** (a) the client tells the server "editor open on snippet X" and the
consolidation trigger treats open-editor snippets as part of the active window (cheapest, matches
"never frozen out from under them" in data-model §6.2); or (b) on `consolidation.applied`, if
`editing`/`selection`/`peekRevision` reference a consumed snippet id, keep the editor open detached
with a banner ("this passage was just consolidated into Ch. N") and offer to apply the draft as a
section edit. Also state the generic rule: any SSE removal event clears/repairs `docUiStore` refs
that point at it.

### [major] The consolidation "Undo" toast is a dead-end as specified

§4.3 shows `consolidation.applied → toast "Chapter frozen — Undo"` and the MVP cut ships
"consolidation undo toast." But the REST table (§4.2) has **no undo endpoint**, the SSE table has
no `consolidation.undone` handler, and no section anywhere says what clicking Undo does. (The API
doc later had to invent `POST /works/:w/consolidations/:undoToken/undo` and a
`consolidation.undone` event on its own — api-deployment §13-D10 — precisely because this doc left
the hole.) An implementer working from this doc builds a button wired to nothing.

**Fix:** add the undo route to §4.2, add `consolidation.undone → invalidate qk.sections +
qk.snippets` to the §4.3 reducer table, and specify toast behavior at the 5-minute grace expiry
(data-model §6.4): the toast must disappear or the button must handle "grace expired" gracefully.

### [major] "Keep partial as snippet" via `POST /snippets` silently destroys agent provenance — and diverges from the harness

§8.3: on `task.failed`/`cancelled`, "partial text is kept in the block with [Keep as snippet]";
A5: it is committed "via the normal snippet-create endpoint." But `POST /api/works/:w/snippets`
(both this doc's own table and the API doc) creates a snippet with `authorship: "user"` and no
`originRunId`. The kept text is agent prose from a recorded run; committing it this way records it
as user-typed with no run link — breaking the brief's provenance requirement ("Snippets carry
provenance (who wrote/edited it, via which agent run)") for exactly the passages most likely to
need it ("what run produced this half-finished paragraph?"). Meanwhile the harness (§6.4/§8) and
API (§3.6) define a server-side proposal held 30 min with `POST /tasks/:t/proposal/apply` — which
also survives a tab close, unlike this doc's client-buffer-plus-POST approach.

**Fix:** adopt the proposal/apply endpoint for keep-partial (and for the harness's conflict card,
which this doc doesn't mention at all despite the harness assigning it to "Frontend (04)"), or
extend `POST /snippets` to accept `authorship`/`originRunId` server-verified against the failed
task. Either way, delete the current A5 wording.

### [major] Targeted-edit streaming has no rendering path — A5 contradicts the harness contract

A5 asserts "`task.delta` carries plain text prose only," and the streaming design (§8.3) renders
deltas in exactly one place: a `StreamingBlock` above the frontier bar. But quick edits and edit
tasks target snippets/sections *mid-document*; the harness streams their rewrites as deltas with a
**`target` block id** (`{type:"delta", target, text}`, harness §8.1; apply-per-paragraph for edit
tasks, §5), and its interface list explicitly expects the frontend to implement a "pending overlay
for streamed drafts/edits." This doc instead says the target block merely "shimmers" and the
result "arrives as a new revision" (§7.2) — so either the harness's per-target deltas render
nowhere (events silently dropped by a reducer that only knows one buffer), or they get appended to
the frontier streaming block, which is wrong.

Shimmer-until-done is a defensible MVP choice — but then say so *as the resolution of the
divergence*: add `target` to the delta schema in §4.3, state that non-frontier-target deltas are
buffered but not rendered in MVP (pending overlay deferred), and fix A5.

### [minor] `enrichment.updated` payload can't perform its stated cache action

§4.3: payload `{ sectionId, kind }` → "patch row (summary text/stale flags) in `qk.sections`."
There is no summary text in the payload to patch with; as written this violates the doc's own A1
rule ("per-event payloads sufficient for cache patching without refetch"). The API doc had to fix
this by inlining the fresh `SectionRow` in the event. **Fix:** carry the updated `SectionRow` (or
at least the changed summary text + stale flags) in the event payload here too.

### [minor] Optimistic snippet creation vs. its own SSE echo — temp-id reconciliation unspecified

§8.1: "＋ snippet … optimistic block appears instantly," and §4.3 dedupes `snippet.created` by
"skip if id exists." The optimistic insert cannot have the server ULID or `orderKey` yet, so when
the SSE echo races ahead of the POST response the id check fails and the cache briefly holds both
a temp block and the real block — a duplicate empty snippet flashing next to a just-opened editor.
**Fix:** specify the reconciliation (e.g., match the echo against pending optimistic entries by a
client-supplied idempotency key, or simply drop optimistic insert for *create* — one localhost
round-trip is imperceptible — and keep optimism for edits only).

### [minor] Situation pane can silently clobber external changes

§9.1: `PUT /situation` (no concurrency token, per this doc and the API), debounced 1 s; incoming
`situation.changed` is *ignored while the pane is dirty*. If the file changes externally (the
reconciler adopts an Obsidian edit — data-model §8) while the user is typing, the debounced PUT
overwrites it with no prompt — the only write surface in the app with silent last-writer-wins,
against principle 2 ("the server is the truth") and the data-model's "no silent merge" rule.
Low stakes (it's a scratchpad) but cheap to fix: send `baseUpdatedAt` and surface the same
theirs/mine prompt on mismatch, or at minimum show "changed on disk" instead of ignoring the event.

### [minor] Planning→writing phase flip has no event in this doc's SSE vocabulary

`taskStore` models `phase: "planning" | "writing"` (§4.4) and §8.3 renders the two phases
differently, but the §4.3 event table contains nothing that signals the transition (the harness
later added `task.stage`). An implementer must guess ("first delta ⇒ writing"?). **Fix:** add
`task.stage` to the reducer table.

---

## 3. Overcomplication

The doc is commendably restrained overall (library table is small and justified; no form/state
ceremony; deferred list is honest). Two genuine smells:

### [minor] `gpt-tokenizer` in the browser bundle is dead weight — the meter is server-fed

§2 adds `gpt-tokenizer` to `apps/web` for "token estimates in edit-task meter (same estimator as
server)." But §9.2 says the meter is fed by `POST /context/preview` (300 ms debounce), and the
per-item counts in the pickers come precomputed from `GET /context/candidates`. Nothing in the doc
tokenizes client-side. cl100k rank tables are ~1–2 MB of JS — the largest dependency in the app,
for zero calls. **Fix:** drop it from `apps/web`; it stays server-side per context-engine §8.3/A4.

### [minor] Contradiction in the >20k-word-section story

§13 ships a cap ("sections >20k words render `full` as the first 20k + 'Open remainder'
expander") while §15 defers "virtualized >20k-word single-section remainder expander polish."
Which part of the expander ships? For MVP-cut discipline, the simplest honest position: ship the
truncation + a non-virtualized "show all" (accepting jank in this rare case), defer nothing
ambiguous. Say that.

---

## 4. Underspecification

### [major] The provenance viewer's region breakdown has no typed data source

§7.4's headline feature — "Prompt (5 regions, 6.4k tokens) … labeled with the context-engine
region names and token counts … the user can see *exactly* what the model saw" — is rendered from
`GET /runs/:r` "parsed run events." But run `message` events are plain `{role, text}`
(data-model §10, harness §7); the only region-shaped data is the harness meta event's
`contextSnapshot: z.unknown()`. No assumption in §16 requires runs to carry region-structured
prompts or per-region token counts, so the first implementer discovers mid-sprint that the
timeline's top row has nothing to bind to. **Fix:** add an A-item specifying the required
`contextSnapshot` schema (region name → token count → char ranges or texts), and agree it with
the harness/context-engine owners.

### [minor] `SectionRow` is missing the image dimensions the layout depends on

§5.5 and §10 make reserved `aspect-ratio` boxes the *plan* ("known image dimensions in
`SectionRow`… anchoring is the backstop, not the plan"), but the §4.5 Zod sketch has only
`hasIllustration` + `illustrationVersion` — no `width`/`height`. A1 mentions "image dimensions"
prosaically; the normative sketch omits them. **Fix:** add `illustrationWidth/Height` (or
`illustration: { version, width, height } | null`) to the sketch.

### [minor] First-run / unconfigured-endpoint failure mode is absent

The brief's fixed constraint: "External services are user-managed endpoints" — so a fresh install
has none configured. §13's failure table has no row for it; the API returns `409 config_missing`
at task creation. As specified, a new user's very first Continue click produces an unexplained
error toast. **Fix:** one row in §13 ("`config_missing` → blocking callout on task controls
linking to config instructions") and one sentence on what the works-list/first-run shows.
(A settings *screen* can stay out of MVP per the brief's "knobs live in config files" — but the
error path must exist.)

### [minor] Stale UI state is never garbage-collected

Fold pins (`foldOverrides`, persisted forever, keyed by sectionId), crash-copy drafts, and
selection refs are all keyed to entity ids that consolidation and deletion invalidate; nothing
specifies cleanup, so `localStorage["cowrite:ui:<workId>"]` accretes dead keys and (per the
consolidation issue above) dangling refs. **Fix:** one rule — on `sections.restructured` /
`snippet.deleted` / `consolidation.applied`, drop overrides/drafts/refs whose ids no longer
resolve after refetch.

---

## 5. Failure-mode / test-plan gaps

### [minor] Playwright `webServer.command` is not Windows-portable

`command: "COWRITE_DATA_DIR=$(mktemp -d) COWRITE_MOCK_LLM=1 pnpm …"` uses POSIX inline env vars
and `$(mktemp -d)`. The brief's stack rationale explicitly promises "one set of tooling on Windows
and Linux." **Fix:** create the temp dir and set env in `playwright.config.ts` (Node `os.tmpdir()`
+ `env:` option) instead of the shell.

### [minor] No e2e coverage for the two riskiest concurrent paths

The eight specs (§14.2) cover happy paths and one resilience case, but not: (a) a background
enrichment task starting *during* an interactive stream (the blocker above — this is the test that
would have caught it), and (b) consolidation firing while an editor is open on an eligible
snippet. Both are drivable with the mock control endpoint + the consolidation API trigger already
used by spec 4. **Fix:** add both as spec files; they are the regression fence for the two worst
findings in this review.

---

## Not flagged (checked and found sound)

For the record, these held up under scrutiny: virtualization budget math and the block model
(§5.2/§5.4) scale to 300k words; the custom scroll-anchoring design (§5.5) correctly identifies
that native `overflow-anchor` can't survive virtualizer remounts and its anchor/followBottom rules
are coherent; Aho–Corasick for world keys is right-sized; the SSE-reducer-as-table with echo
dedupe is a good normative artifact; the A3 divergence (debounce vs. explicit commit) was
correctly caught and flagged by the doc itself; the MVP cut is genuinely disciplined (palette,
multi-select, mobile, settings UI all correctly deferred).
