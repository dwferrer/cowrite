# Adversarial review — Data model & on-disk storage proposal

**Reviewed:** `/home/user/cowrite/docs/design/data-model.md` (Proposal v1, 2026-07-06)
**Against:** the product brief `/home/user/cowrite/docs/00-overview.md` (authoritative, including the
fixed baseline stack), plus sibling designs (`agent-harness.md`, `context-engine.md`,
`frontend.md`, `illustration.md`) where they impose interfaces on storage.

**Context on provenance:** the proposal's provenance note claims "no brief file exists in the
repository (the repo contains only a LICENSE)". The brief exists at `docs/00-overview.md`, with a
"Fixed constraints (from the brief)" section and a fixed stack. Whether or not it was present when
the proposal was drafted, every §13 assumption must now be reconciled against it — and several do
not survive contact (see issues 2, 3, 8, 16 below).

Overall: the core shape is right and pleasingly disciplined — files-as-truth, rebuildable SQLite
cache, fractional order keys, journaled consolidation, collapse-with-provenance. The blockers are
a missing brief-mandated entity and a handful of races/contradictions in exactly the parts the
proposal advertises as its strength (crash safety, staleness, reconciliation).

---

## Blockers

### 1. [blocker] The `Situation` entity is missing entirely

**What's wrong.** The brief's glossary defines **Situation** as a first-class concept: "an
optional, user-maintained scratch outline/instructions for the current scene, shown in a separate
pane and included in prompts clearly marked as instructions." Sibling designs depend on storage
for it: the frontend persists it server-side (`GET/PUT /api/works/:w/situation`, SSE event
`situation.changed`, frontend.md §9.1), and the context engine treats it as an always-included
singleton context item ("Situation pane | `situation` (singleton) | always `full`",
context-engine.md §item table; "Never evicted: … situation"). The data model has **no file, no
schema, no StorageService operation, no index presence** for it.

**Why it matters.** An implementer of storage would ship a work directory that cannot round-trip a
brief-mandated, prompt-critical piece of user state. Two sibling subsystems would have nowhere to
read/write it. It also violates the proposal's own principle 1 ("everything a user cares about …
lives as plain Markdown on disk") and the brief's "Files are the truth."

**Fix.** Add `situation.md` at the work root (plain Markdown, no frontmatter needed — it's a
singleton), a `getSituation`/`putSituation` pair on `StorageService` (atomic write, same
tmp+rename discipline), inclusion in the reconciler walk, and a row/flag in the index if the
context engine wants change detection (a `contentHash` in `meta` suffices).

---

## Major issues

### 2. [major] Interface assumptions in §13 contradict the actual brief and must be rewritten

**What's wrong.** §13.1 assumes "Electron main process or a local server," `js-yaml` +
`gray-matter`, etc. The brief fixes the stack: "Runs as a local console app; browser at localhost;
no auth, no multi-tenancy" and "TypeScript end-to-end. pnpm workspace monorepo … `apps/server` |
Console app: HTTP API, agent harness, storage | Node 22+, Fastify 5, tsx runtime … SQLite
(`better-sqlite3`) as a rebuildable index over file-based storage." The repo scaffold
(`apps/server`, `apps/web`, `packages/shared`) already exists and matches the brief.

**Why it matters.** Mostly the formats survive (as the proposal hedges), but not everything: the
"window focus" reconciler trigger (§8) assumes an app window the storage process can observe —
in a console-app + browser architecture the server has no focus events; the browser does, and
would need to signal them over the API. Similarly "on work close" (used as a consolidation and
purge trigger, issues 13/14) has no obvious meaning for a long-lived localhost server.

**Fix.** Rewrite §13.1 to the brief's fixed stack (Fastify server owns storage in-process; shared
Zod contract lives in `packages/shared`). Replace "window focus" with an explicit
client-signalled trigger (e.g., the web app POSTs a `focus`/`heartbeat` ping, or reconcile runs
before every read-model query after >N s idle) and define "work close" (issue 13).

### 3. [major] World-info keys: required-and-key-gated contradicts the brief and the context engine

**What's wrong.** The brief: "**World-info / context entry** — … name, **optional match keys**,
markdown body … **Not key-gated for prompt inclusion; the context engine decides inclusion.**"
The proposal (a) requires keys — `keys: z.array(z.string().min(1)).min(1)` in `WorldEntryMeta` —
and (b) builds its context-engine interface around key scanning: §7.2 "Context engine |
`world_keys WHERE key IN (…scanned tokens…)`" and §13.3 "world_keys index scans." The actual
context-engine design includes **every** entry at `short` fidelity and demotes by token budget
(context-engine.md §5: "World-info: every entry at `short` … demote entries to `name`"); it never
key-scans.

**Why it matters.** The Zod schema would reject a legitimate entry with no keys (a user creating
"The Storm Glass" with just a body). The `world_keys` table + `ix_world_keys` index is machinery
for a SillyTavern feature the brief explicitly stripped — precisely the "fiddly legacy" smell the
brief warns about.

**Fix.** Make `keys` optional (`.default([])`), keep them as data (the context engine's search
tool and the FTS index can still use them), and drop the `world_keys` table and the key-scan rows
from §7.2/§13.3 unless the context-engine owner asks for them. FTS over world bodies already
covers search.

### 4. [major] Consolidation undo-grace window creates a 5-minute double-truth the reconciler will corrupt

**What's wrong.** During the undo grace (§6.4/§9.2 step 4), consumed snippet files remain in
`frontier/snippets/` *and* the new section's `content.md` exists with the same text. The
reconciler (§8) runs every 30 s and **before every agent run**, and its pseudocode never consults
`pending-ops.json`: it will see the consumed snippet files, find them indexed (or re-adopt them),
and present them as live frontier snippets. A full index rebuild in this window does the same.

**Why it matters.** Direct failure scenario: chapter freezes at t=0; at t=30 s the user hits
"continue"; the pre-run reconcile re-legitimizes the consumed snippets; the context engine
assembles a prompt containing the chapter text **twice** (once as section summary/content, once
as "last-N frontier snippets"), and the frontier pane shows ghost snippets. It also breaks the
proposal's own axiom — files are the truth, but for 5 minutes the files assert two truths, and
"any question the index answers must be answerable from files alone" is false without reading the
journal.

**Fix.** At apply time, atomically **move** consumed snippet+revision files into a staging dir
(`.cowrite/undo/<opId>/`) instead of leaving them in place; undo moves them back; grace expiry
deletes the staging dir. Rename is atomic, the frontier directory is instantly consistent, the
reconciler needs no journal awareness, and rebuild-from-files is unambiguous at every instant.
(If files must stay put for some reason, then the reconciler and the rebuild procedure must both
be specified as journal-aware — but the move is simpler.)

### 5. [major] Lost-edit race inside consolidation: plan-time text, purge-time delete

**What's wrong.** The journal (§9.2) is written at plan time with the boundaries and snippet ids;
`content.md`/`history.jsonl` capture "final" texts, and step 4 later deletes the snippet files.
Nothing serializes user edits against this. The harness serializes *its own* commits ("while a
consolidation apply is in flight, interactive continue commits wait", agent-harness §6), but
in-app typing (the frontend's `PATCH` snippet saves) and external editors are not tasks and are
not mentioned.

**Why it matters.** Concrete scenario: consolidation is planned at t=0 with snippet S at rev 3;
at t+2 s the user's editor commits rev 4 (atomic snippet-file rewrite); steps 2–3 write
`content.md` with rev 3's text; at t+5 min step 4 deletes S's file. Rev 4 is silently destroyed —
a data-loss path in the subsystem whose banner claim is "crash-safe by construction."

**Fix.** Two cheap rules: (a) storage serializes consolidation apply with snippet writes (one
in-process write mutex — the brief is single-user, this is trivial); (b) before purging each
snippet file, compare its hash to the text recorded in `history.jsonl`; on mismatch, abort the
purge for that snippet, mark the op for re-plan (or fold the newer text into the section as a
normal §6.5 edit). State both explicitly, and add "edit lands mid-consolidation" to the §11
kill-point test matrix.

### 6. [major] Illustration staleness rule is self-contradictory and unimplementable as specced

**What's wrong.** §6.5 says `illustration.stale = true` only when word count changes by >15%
("regenerating art because someone fixed a comma would be noise") — and then, three paragraphs
later: "Staleness is **derived, not stored as a boolean**: an enrichment is stale iff
`enrichment.sourceHash !== hash(content.md)`." Those contradict: a comma fix changes the hash, so
the derived rule marks the illustration stale. And the 15% rule cannot be computed from
`EnrichmentMeta` at all — it stores only `sourceHash`, not the word count at generation time.

**Why it matters.** An implementer must guess which rule wins; the derived rule produces exactly
the "noise" the design says it's avoiding; the SQLite `illustration_stale` column has no
computable definition.

**Fix.** Add `sourceWordCount` to the illustration's `EnrichmentMeta`. Define: summaries stale iff
hash mismatch; illustration stale iff `|wc(content.md) − sourceWordCount| / sourceWordCount >
illustrationStaleWordDeltaPct/100` (or explicit user request). Both remain fully derived from
files.

### 7. [major] `EnrichmentMeta` cannot represent user-uploaded or pinned illustrations

**What's wrong.** `EnrichmentMeta.runId` is a required `Ulid` and there is no source/pinned
field. The illustration design (illustration.md §5) requires: "**Upload own image** — `PUT
…/illustration` … Recorded with `source: "user"`, no run. **Pinned: excluded from** [staleness]"
and "**Delete** — removes the PNG and nulls the enrichment metadata."

**Why it matters.** Storage is the system of record for enrichment metadata; as specced it cannot
persist a feature another subsystem has already designed. Zod validation would reject the write.

**Fix.** `runId: Ulid.nullable()`, add `source: z.enum(["agent","user"])` and
`pinned: z.boolean().default(false)` (pinned ⇒ never stale). Delete is already representable
(`illustration: null`).

### 8. [major] The RunEvent/RunKind schemas conflict with the agent harness and the brief's glossary

**What's wrong.** The proposal invents `RunKind = ["draft","revise","summarize","boundary",
"illustrate","world-extract"]` and its own `RunEvent` union (§10). The brief's glossary — "used
consistently across all docs, the codebase, and prompts" — names the task types "continue,
instructed continue, quick edit, edit task, enrichment, illustration." The agent harness (which
owns run semantics) defines `TaskKind = ["continue","instructed-continue","quick-edit",
"edit-task", …]`, sets `RunKind = TaskKind`, and ships a richer `RunEvent` (adds `lane:
"high"|"low"`, `stage`, `attempt`, `usage` events, structured `error`, `contextSnapshot`, and a
9-kind `RunArtifact` with a `state: committed|conflict|skipped` field) — explicitly "superseding
its draft in data-model §10." The data-model's `run_artifacts.artifact_kind` comment lists only 5
kinds and its `agent_runs` table has `input_tokens/output_tokens` where the harness emits
`promptTokens/completionTokens`, and no `lane` column.

**Why it matters.** Two subsystems shipping different schemas for the same JSONL file is a
guaranteed integration bug, and the index schema can't ingest the harness's real events (artifact
kinds like `section-span`/`snippet-revision` violate the table comment; `lane` is unqueryable for
the cost panel the brief's high/low split implies).

**Fix.** Data model should own the *location, sink semantics, retention, and index tables* for
runs, and import `RunEvent`/`TaskKind`/`RunArtifact` from `packages/shared` (harness-defined).
Update `agent_runs` (add `lane`; rename token columns) and widen `run_artifacts.artifact_kind` to
the harness's enum + `state`. Delete §10's RunEvent/RunKind draft.

### 9. [major] No optimistic-concurrency contract, though both consumers require one

**What's wrong.** The frontend saves with "`PATCH` with `baseRev`/`baseHash`; 409 → rollback"
(frontend.md §7.1) and restores via "`POST …/restore { rev }` → the server appends a *new*
revision" (§7.3). The harness commits with `storage.reviseSnippet(snippetId, text, { author,
runId, baseRev })` and "at commit time the runner re-checks via storage." The proposal's
`StorageService` sketch (§13.2) lists bare `appendSnippet, reviseSnippet, consolidate, …` with no
`baseRev`/`baseHash` parameters, no conflict result, no `restore`, and no `replaceSectionSpan`
(required by agent-harness §5.4 for edit tasks on frozen sections).

**Why it matters.** Conflict detection is storage's job (it owns `rev` and `contentHash`); without
a specified contract each caller will invent one, and the glossary requirement that snippet
history "supports cycling and rollback" has no storage-level answer.

**Fix.** Specify: `reviseSnippet(id, text, {author, runId?, baseRev}) → ok | {conflict,
currentRev}`; `restoreSnippet(id, rev)` = append-new-revision-with-old-text (log stays
append-only); `replaceSectionSpan(sectionId, span, text, {runId, baseHash}) → ok | conflict`;
sections use `contentHash` as the concurrency token.

### 10. [major] Lock auto-break + suspend/resume yields two writers

**What's wrong.** §9.3: lock refreshed every 30 s; "Stale lock (> 2 min old) is broken
automatically." Nothing re-validates ownership. Scenario: instance A holds the lock; the laptop
suspends (or A's event loop stalls) for 3 minutes; the user starts instance B, which breaks the
"stale" lock and takes ownership read-write; A wakes, resumes its 30 s refresh (clobbering B's
lock), and both instances now write files and run journaled consolidations concurrently — the
exact situation the lock exists to prevent, with two journals fighting over `frontier/`.

**Why it matters.** It's the only concurrency guard in the design, and its failure mode is silent
interleaved writes. Suspend/resume is an everyday laptop event, not an exotic race.

**Fix.** Put a random nonce in the lock; before every write batch (and after any detected clock
jump > refresh interval), re-read the lock and verify the nonce; on mismatch, drop to read-only
with the existing banner. One stat+read per write batch — negligible.

---

## Minor issues

### 11. [minor] Boundary-deferral threshold growth is unspecified and unbounded
§6.3: if the boundary agent proposes nothing, "thresholds grow by 50% for the next attempt."
Where does the grown value live (memory? `work.json`)? If in memory it resets every restart; if
persisted it silently mutates user settings. And repeated deferrals (or a garbage-returning /
unreachable endpoint, §11) compound 1.5× per attempt with no cap → consolidation effectively
disables itself and the frontier grows without bound — the failure the proposal itself says
manual-only freezing would cause. **Fix:** keep the multiplier in memory, cap at e.g. 2× the
configured thresholds, reset on the next successful consolidation, and after N consecutive
deferrals surface a "long frontier — split manually?" nudge instead of growing further.

### 12. [minor] FTS5 DDL doesn't match its description
§7.1 comments "contentless FTS5" but the DDL (`CREATE VIRTUAL TABLE fts USING fts5(kind,
entity_id UNINDEXED, title, body)`) declares a regular FTS table that stores a full copy of all
prose. Contentless (`content=''`) tables also have awkward delete/update semantics that the
incremental-update path (§7.3) would trip over. **Fix:** pick one and say so — a plain FTS table
is simplest and the duplication is explicitly acceptable per the brief ("Duplication is
acceptable"); just delete the word "contentless."

### 13. [minor] "On work close" is undefined for a console-app server
Consolidation "always on work close" (§6.2) and purge "after a 5-minute undo grace **or on work
close**" (§6.4). The brief's runtime is a localhost server + browser tab; the common exit is
Ctrl-C or a killed terminal, and a closed tab is invisible to the server. **Fix:** define close =
SIGINT/SIGTERM handler (flush journal, skip new consolidations) plus an idle rule (no client
activity for N minutes ⇒ treat as closed); never rely on it for correctness (the journal already
covers hard kills — say that).

### 14. [minor] Undo can race the auto-enrichment pipeline
On freeze, the harness scheduler immediately queues `enrich-section` → `illustrate-section`
(illustration.md §5). If the user hits Undo inside the grace window, the reverse replay deletes a
section directory that enrichment runs are concurrently writing summaries/PNGs into.
Agent-harness §6 serializes commits *behind* the journal but doesn't cover un-apply. **Fix:** undo
must cancel (or invalidate the commit of) pending enrichment tasks targeting the un-frozen
section id; one sentence in §6.4 plus a kill-point test.

### 15. [minor] Snippet filename embeds the orderKey — a second, contradictable source of order
`frontier/snippets/<orderKey>.<shortid>.md` duplicates the frontmatter `orderKey`. §4 declares
metadata authoritative and prefixes a "human-readable mirror," but for snippets the mirror *is*
the raw key, and the reconciler "assigns orderKeys to foreign files by filename sort" — so a user
renaming `a2.…md` to `a5.…md` may or may not reorder it depending on unstated rules; reordering a
snippet in-app forces a file rename; and base-62 keys are case-sensitive while Windows filenames
are not (the brief targets Windows), so filename sort ≠ key sort. **Fix:** name snippet files
like sections (`NNN-….<shortid>.md` numeric mirror, authoritative key in frontmatter), state that
a prefix-vs-frontmatter disagreement resolves to frontmatter with lazy renumber, and restrict
generated orderKeys to a case-insensitive-safe alphabet.

### 16. [minor] Sample run metadata contradicts the brief's model constraints
§5.4's example has `"model":"claude-sonnet-4-5"`. The brief fixes "two OpenAI-compatible LLM
endpoints (high/low)" that are user-managed; the glossary defines High/Low model lanes, and the
harness records `lane: "high"|"low"`. **Fix:** example should show `lane` + whatever model string
the user's endpoint reports (folds into issue 8).

### 17. [minor] Rebuild-in-<2 s target ignores `runs/`
§7.3 sizes the rebuild as "a few hundred small files," but `agent_runs`/`run_artifacts` are index
tables, so a full rebuild must also scan `runs/**`. A 300k-word work is plausibly a few thousand
runs (750+ continues alone at ~400 words each, plus revisions, enrichment, boundary,
illustration-critique calls) at tens of KB each — hundreds of MB of JSONL if fully parsed.
**Fix:** specify that rebuild parses only each run file's `meta` line and final `result` line
(first line + tail seek), and either re-benchmark the target or scope the <2 s promise to the
manuscript/frontier/world tables with runs backfilled lazily.

### 18. [minor] Section deletion "tombstone row" has no schema support
§8 says a missing section dir ⇒ "tombstone row + warn in UI," but the `sections` table has no
deleted/tombstone column, and a full rebuild (files-only) would erase tombstones anyway —
contradicting "any question the index answers must be answerable from files alone." **Fix:**
either drop tombstones (missing dir ⇒ row deleted + one-shot UI warning from the reconciler diff)
or add the column and accept that tombstones are session-local, not rebuildable — and say which.

### 19. [minor] Editor-debounce policy is specified in the wrong subsystem
§6.1 hardcodes "accepted edit = editor debounce boundary (default 2,000 ms idle)." The frontend
explicitly uses explicit-commit saves instead and flags the discrepancy (frontend.md §7.1 / its
§16 A3). Storage should define the *unit* (one `reviseSnippet` call = one revision event) and let
callers own cadence. **Fix:** replace the 2,000 ms rule with "one storage commit = one revision;
save cadence is the caller's policy."

### 20. [minor] Adoption edge cases and frontmatter write-back are underspecified
§8 adopts any frontmatter-less `.md` "in `manuscript/` or `world/entries/`" — as what, when it
sits *inside a section dir* next to `content.md` (a stray `notes.md`)? What about a new `.md`
dropped into `frontier/snippets/`? And "write frontmatter back (atomically)" mutates a file the
user may have open in an external editor — their next save silently strips the frontmatter and
the file gets re-adopted under a *new* ULID (identity churn, orphaned revision log). **Fix:**
enumerate adoption per directory (frontier ⇒ snippet; `world/entries` ⇒ entry; section dir ⇒
ignore-and-list as "unrecognized file," never adopt); on frontmatter loss, re-associate by the
filename short-id before minting a new ULID (the short-id exists for exactly this, §3 — use it in
the algorithm).

### 21. [minor] `BoundaryProposal` schema omits a field its own prose requires
§6.3 says the boundary agent returns `{ boundaries: […], remainderStaysLive: true }`; the §10 Zod
schema has only `boundaries`. Also unstated: what happens if `afterSnippetId` falls inside the
protected active window (agent error) — presumably clamp/reject, but say so. **Fix:** align schema
with prose (or delete `remainderStaysLive` if it's always implied) and add the validation rule;
note the contract should live in `packages/shared` per the brief's "single API contract."

---

## What was checked and found sound (no action)

- Files-as-truth + rebuildable index matches the brief's fixed constraints and Principle 3.
- Collapse-with-provenance matches the glossary's "Precise snippet edit history is collapsed" and
  keeps the runId chain the provenance UI needs; the harness's run-retention design confirms fit.
- Fractional order keys, ULIDs, atomic single-file writes, torn-JSONL tolerance, month-sharded
  runs: appropriate, not over-built.
- Scale: ~100 sections / ~few-hundred files for a 300k-word work; polling reconciler stat-walk and
  FTS sizes are comfortably fine (runs-scan caveat aside, issue 17).
- MVP cut is genuinely disciplined (flat chapters, auto-only consolidation, no fs-watcher, no
  per-section history) — the only scope trims this review adds are `world_keys` (issue 3) and the
  §10 RunEvent draft (issue 8).
