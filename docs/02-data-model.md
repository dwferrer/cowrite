# 02 — Data Model & On-Disk Storage

**Scope.** This document specifies how a work is represented on disk and in memory: the entity
model (work, section, snippet, world entry, situation, agent run), the canonical directory layout
and file formats, ordering and identity, the consolidation engine that turns frontier snippets
into enriched sections, the rebuildable SQLite index, the reconciler that tolerates external
edits, crash-safety mechanics, and the `StorageService` API the rest of the server calls. Storage
is a library inside `apps/server` (no HTTP surface of its own); the API layer (03) wraps it and
the agent harness (05), context engine (06), and illustration pipeline (08) call it in-process.

## Key decisions

- **Files are the truth; SQLite is a rebuildable cache** — any state not reconstructible from the
  work directory is a bug.
- **Markdown + YAML frontmatter for prose, JSONL for event logs, JSON for metadata, PNG for
  images** — human-readable, git-diffable, atomic-replace friendly.
- **Bare ULIDs for every entity id**, with an explicit `kind` field wherever ids of mixed kinds
  travel together — sortable, filename-safe, no prefix-parsing.
- **Fractional order keys (base-36) in metadata; numeric filename prefixes as a human mirror** —
  insertion touches one file, ordering rebuilds from files alone.
- **Consolidation is journaled, mutex-serialized, and staged** — consumed snippets move to
  `.cowrite/undo/<opId>/` at apply time, so the tree of files asserts exactly one truth at every
  instant.
- **Snippet history collapses at consolidation, provenance survives** — final text plus every
  `runId` that touched a snippet are kept in `history.jsonl`; intermediate revision texts are
  discarded.
- **Staleness is derived, never a stored flag** — summaries stale on `sourceHash` mismatch or
  absence; illustrations stale on a >15 % word-count delta, absence, or explicit request.
- **External edits are reconciled, never fought** — adoption is the failure mode; no user file is
  ever deleted or quarantined.
- **Optimistic concurrency everywhere** — `baseRev` for snippets, `baseHash` for sections and
  the situation; conflicts are returned, not silently merged.
- **One writer per work** — advisory lockfile with pid-liveness and nonce re-validation, so
  suspend/resume cannot produce two writers.

---

## 1. Design principles

1. **Files are the source of truth; the database is a cache.** Everything a user cares about
   (prose, world entries, summaries, images, the situation) lives as plain Markdown/PNG/JSON in a
   layout a human can read, `grep`, back up, and put in git. The SQLite index is derived,
   disposable, and rebuildable from the files alone.
2. **One writer, many readers.** Exactly one server process owns a work at a time (advisory
   lockfile). External editors are tolerated readers *and* writers — we reconcile, we never fight.
3. **Append at the frontier, settle behind it.** The hot path (frontier snippets) is
   append-mostly with cheap per-snippet files and JSONL revision logs. Cold content (frozen
   sections) is plain Markdown any tool can edit; edits there "merely work" and only cost a
   staleness recomputation.
4. **Crash-safe by construction.** Single-file writes are atomic (tmp + fsync + rename). The one
   multi-file operation (consolidation) is journaled and idempotent. Correctness never depends on
   a clean shutdown.
5. **Resist fiddly features.** No CRDTs, no content-addressed blob store, no custom binary
   formats, no diffs-of-diffs. Snippets are small; store whole texts.

---

## 2. Entity model

```
Work 1 ──── 1 Situation        (singleton scratchpad, situation.md)
Work 1 ──── * Section          (tree: parentId; depth per work.levelScheme)
Work 1 ──── * Snippet          (the frontier; ordered, not yet owned by a Section)
Work 1 ──── * WorldEntry
Work 1 ──── * AgentRun
Section 1 ── 0..1 Illustration, 0..1 ShortSummary, 0..1 LongSummary   (enrichments)
Section 1 ── * ConsolidatedSnippet   (provenance records in history.jsonl)
Snippet 1 ── * RevisionEvent   (JSONL log; each revision may reference an AgentRun)
WorldEntry 1 ── 0..1 Image (+ IllustrationMeta sidecar)
AgentRun 1 ── * artifacts (snippet revisions, summaries, illustrations, boundary proposals)
```

### 2.1 Work
The root container; one directory per work under `<dataDir>/works/`. Holds title, the **level
scheme** (an ordered list of section kinds, e.g. `["part","chapter","scene"]`), schema version,
and tunable settings (consolidation thresholds, staleness delta). The level scheme lives in
`work.json` and is a backend/config concern — **editable in M1 by editing `work.json` directly**
(the tree schema, storage, context engine, and UI all handle arbitrary nesting generically),
which is how the brief's "easy to change on the back-end" is satisfied; it is never a
user-facing setting. What M2+ defers is only the boundary agent *proposing* multi-level splits
automatically (§13). Changing the scheme of a work with existing sections is a controlled data
migration (directory reshuffle + index rebuild).

**Default level scheme: `["chapter"]`** (flat list of chapters). The tree machinery is fully
general, so switching a work to `["part","chapter"]` later is a directory reshuffle plus index
rebuild, not a schema change.

### 2.2 Situation
A per-work singleton Markdown scratchpad (`situation.md` at the work root, no frontmatter): the
user's outline/instructions for the current scene. Read/written through
`getSituation`/`putSituation` (atomic replace, optimistic `baseHash` content token), tracked by the
reconciler, change-detected via a `contentHash` row in the index `meta` table. Served over
`GET/PUT /works/:w/situation` (03 §routes) and included in prompts as an always-full-fidelity
region (06).

### 2.3 Section
A node in the manuscript tree. **Leaf sections carry prose** (`content.md`); interior sections
are grouping nodes only — no mixed content, which keeps consolidation and context assembly
simple. A section is either **frozen** (the normal state — consolidated prose) or, transiently,
the target of an in-flight consolidation. Sections own their enrichments; staleness is derived
from their metadata (§6.5).

### 2.4 Snippet
The frontier unit: one contiguous chunk of prose (typically 100–2,000 words) at the growing tail
of the work, not yet assigned to any section. Snippets carry:

- `authorship`: `user` | `agent` | `mixed` (agent-drafted then user-edited, or vice versa)
- `originRunId`: the agent run that first produced it (null for user-typed)
- an ordered position among frontier snippets (`orderKey`, §4)
- a revision history: each accepted edit appends a full-text `RevisionEvent` to a per-snippet
  JSONL log, tagged `user` or `agent` (+ `runId`). This is what lets the UI show "which
  prompt/process produced this version." **One `reviseSnippet` call = one revision event**; save
  cadence (debounce, explicit commit) is the caller's policy, not storage's.

The un-consolidated snippet region is also the context engine's **local-context region**: every
un-consolidated snippet is included at full text in the default context map (06 §default map).
The consolidation thresholds in §6.2 are therefore what bound that region's size — worst case
`maxFrontierWords` ≈ 9,000 words before a consolidation attempt triggers. Raising the thresholds
directly raises every prompt's local-context cost; the defaults are chosen with that coupling in
mind.

### 2.5 Enrichments
Per section: `shortSummary` (1–3 sentences), `longSummary` (a few paragraphs), **at most one
illustration** (PNG), and an optional `title` (stored with `titleSource: user | agent` so a user
rename is never clobbered by the enrichment agent). Summary metadata records `source`
(`agent` | `user` — users may edit summaries directly), a nullable `runId`, `generatedAt`, and
the `sourceHash` of the `content.md` it was generated from. The illustration slot is a
three-state union: absent (`null`), present (`IllustrationMeta`, owned by 08 — includes `source`,
nullable `runId`, prompt/workflow/seed/score, `sourceWordCount`, and the `entities` depicted), or
a **tombstone** `{ suppressed: true, deletedAt }` recording that the user deleted the image and
the sweep must not regenerate it.

### 2.6 WorldEntry
World-info: `name`, optional `keys[]` (aliases; default `[]` — an entry with no keys is fully
legitimate), Markdown `body`, optional `image` (+ sidecar metadata), optional `shortSummary`.
Created by the user or proposed by an agent (`createdBy`). One Markdown file per entry. Keys are
**not** used to gate prompt inclusion (the context engine includes every entry at short fidelity
and manages the budget itself, 06); their server-side consumers are the **illustration
pipeline** (`matchWorldEntries` for intent briefs, 08 §compose) and search; the frontend uses
them for in-text highlighting (04).

### 2.7 AgentRun
The auditable record of one task execution: kind (= `TaskKind`, kebab-case: `continue`,
`instructed-continue`, `quick-edit`, `edit-task`, `enrich-section`, `propose-boundaries`,
`illustrate-section`, `world-image`), lane (`high` | `low`), model, spec, context snapshot,
messages, tool calls, streamed output, usage, and artifacts. One JSONL file per run, write-once
after the `result` line — with exactly one carve-out: the durable `proposal` resolution line
that apply/discard appends *after* `result` (mirroring 05 §5.1's proposals-from-run-JSONL). The event schema (`RunEvent`, `RunArtifact`, `ContextSnapshot`) is owned
by 05; **this document owns the file location, sink semantics, retention, and index tables**
(§7, §10.6).

---

## 3. IDs

- **All entity ids are bare ULIDs** (26-char Crockford base32): sortable by creation,
  collision-free, filename-safe, no coordination. Wherever ids of different kinds travel in one
  payload (context-engine items, tool arguments, mixed artifact lists), the payload carries an
  explicit `kind: 'section' | 'snippet' | 'world' | …` field — no id prefixes to parse.
  *Rejected:* UUIDv4 (not sortable, uglier in filenames); prefixed ids like `sec_…` (two
  spellings of every id, string surgery at every boundary); sequential ints (need a central
  counter, break under external file creation).
- Filenames embed a **short id** — the last 6 chars of the ULID — plus a human slug, e.g.
  `020-the-storm.k9v3qa/`. The full ULID lives in the entity's metadata; the filename short id is
  for human orientation and for re-associating a renamed or frontmatter-stripped file with its
  identity (§8).

---

## 4. Ordering: fractional order keys

Every ordered collection (sections among siblings, snippets in the frontier) is ordered by a
**fractional-index `orderKey`**: a string over the case-insensitive-safe alphabet `0-9a-z`
(base-36), generated between neighbors (à la the `fractional-indexing` package, restricted
alphabet). Sort lexicographically; tie-break by ULID.

- Insertion anywhere touches **one file** (the inserted item), never a central manifest.
- Ordering is derivable from the files alone → the index stays rebuildable.
- File and directory names carry a numeric prefix (`010-`, `020-`) as a *human-readable mirror*
  of order. The frontmatter/metadata `orderKey` is **authoritative**; when a filename prefix and
  the frontmatter disagree (e.g. the user renamed a file), frontmatter wins and the reconciler
  renumbers prefixes lazily. Foreign files without metadata get orderKeys assigned from their
  filename sort position at adoption time (§8).
- The base-36 alphabet means key order and filename order agree even on case-insensitive
  filesystems (Windows is a first-class target).

**Reserved keys.** `reserveOrderKey(workId)` allocates the next key after the current last
snippet *in memory* before any file exists — the harness reserves one at task start so the
agent's forthcoming snippet has a stable position. Reservations participate in subsequent key
generation: a user append while an agent run is streaming receives a key *after* the reservation,
so the user's new snippet lands after the agent's pending one (matching the order the work was
initiated). A reservation is released when its task ends without committing; fractional keys need
no contiguity, so a released reservation leaves no gap to repair.

*Rejected:* a central `order.json` per work (single hot file, contended by every insert, bypassed
by external file additions); mtime/ULID-only ordering (breaks on any insert or reorder).

---

## 5. On-disk format

### 5.1 File-format policy

| Data | Format | Why |
|---|---|---|
| Prose (section content, snippets, world bodies, situation) | **Markdown** (+ YAML frontmatter where the file needs identity) | Human-editable, git-diffable |
| Snippet revision history | **JSONL** (one event per line) | Append-only, crash-tolerant (torn last line droppable), streamable |
| Agent-run transcripts | **JSONL** | Runs are event streams by nature |
| Section/work metadata, consolidation provenance, journal | **JSON** (pretty-printed) | Structured, small, atomic-replace friendly |
| Images | **PNG** next to their owner | No blob store; trivially viewable |
| Index | **SQLite** (WAL mode) | Derived cache only |

### 5.2 Directory layout (canonical)

```
<dataDir>/                             # config.storage.dataDir, default ~/.cowrite/data
  works/
    <slug>/                            # one directory per work
      work.json                        # WorkMeta (schema ver, level scheme, settings)
      situation.md                     # singleton scene scratchpad (may be absent = empty)
      sections/                        # the frozen section tree; nesting mirrors levelScheme
        <NNN>-<slug>.<shortid>/        # one dir per section (leaf or interior)
          section.json                 # SectionMeta (id, kind, orderKey, enrichment metadata)
          content.md                   # leaf sections only: the consolidated prose
          summary-short.md             # enrichment (optional)
          summary-long.md              # enrichment (optional)
          illustration.png             # enrichment (optional, at most one)
          history.jsonl                # collapsed snippet provenance (§6.4)
          <child section dirs...>      # interior sections only
      frontier/
        snippets/
          <NNN>.<shortid>.md           # one file per live snippet (frontmatter + current text)
        revisions/
          <snippetId>.jsonl            # full-text revision events for that snippet
      world/
        entries/<slug>.<shortid>.md    # frontmatter (id, keys, summary, image ref) + md body
        images/<entryId>.png
        images/<entryId>.json          # IllustrationMeta sidecar (no section.json to live in)
      runs/
        <YYYY-MM>/                     # month shard keeps directories small
          <runId>.jsonl
      .cowrite/                        # app-private; deleting it loses only caches
        index.sqlite                   # rebuildable index (§7)
        pending-ops.json               # multi-file operation journal (§9.2); absent when idle
        lock                           # advisory single-writer lock (§9.3)
        undo/<opId>/                   # consumed snippets staged during the undo grace (§6.4)
        context/                       # context-engine caches: state.json, usage.jsonl (06)
        trash.json                     # present only inside a trashed work (below)
  .trash/
    <slug>-<ts>/                       # DELETE /works/:w moves the whole dir here (03)
```

Everything outside `.cowrite/` is user-facing and git-friendly. Deleting `.cowrite/` loses
nothing but caches, an idle-time lock, and any in-flight undo window. Work deletion is a move to
`<dataDir>/.trash/` — the API never hard-deletes prose; a `trash.json` (`{deletedAt,
originalSlug}`) is written into the trashed work's `.cowrite/` so restoration is mechanical.
Trash GC is manual (deferred).

### 5.3 Concrete example — a work with 2 chapters and a live frontier

```
works/salt-and-signal/
├── work.json
├── situation.md                           # "Mara confronts the harbormaster; storm building"
├── sections/
│   ├── 010-the-lighthouse-keeper.01hzqa/
│   │   ├── section.json
│   │   ├── content.md                     # 4,100 words, frozen 2026-07-01
│   │   ├── summary-short.md
│   │   ├── summary-long.md
│   │   ├── illustration.png
│   │   └── history.jsonl                  # 7 consolidated snippets' provenance
│   └── 020-the-storm-glass.01j2kf/
│       ├── section.json                   # summaries stale (user edited content.md in
│       ├── content.md                     #   VS Code yesterday; reconciler noticed)
│       ├── summary-short.md
│       ├── summary-long.md
│       ├── illustration.png
│       └── history.jsonl
├── frontier/
│   ├── snippets/
│   │   ├── 010.p2m9x1.md                  # agent-drafted, user-touched (mixed), rev 3
│   │   ├── 020.q8r2v7.md                  # user-typed, rev 1
│   │   └── 030.t5w0zn.md                  # agent-drafted 2 min ago, rev 1
│   └── revisions/
│       ├── 01J2P4...P2M9X1.jsonl          # 3 revision events
│       ├── 01J2P6...Q8R2V7.jsonl          # 1 revision event
│       └── 01J2P7...T5W0ZN.jsonl          # 1 revision event
├── world/
│   ├── entries/
│   │   ├── mara-voss.7f3akq.md            # keys: ["Mara", "Voss", "the keeper"]
│   │   └── the-storm-glass.9b1xte.md      # keys: []  (legitimate)
│   └── images/
│       ├── 01J2N8...7F3AKQ.png
│       └── 01J2N8...7F3AKQ.json
├── runs/
│   └── 2026-07/
│       ├── 01J2P7Q4V2M8Z6T1RD5FCW9XKB.jsonl   # continue run → snippet 030
│       └── 01J2P5H8A3N1Y7S4QE2GBV6MKD.jsonl   # propose-boundaries run → froze ch. 2
└── .cowrite/
    ├── index.sqlite
    ├── lock
    └── context/
        ├── state.json
        └── usage.jsonl
```

### 5.4 Sample file contents

`frontier/snippets/030.t5w0zn.md`:

```markdown
---
id: 01J2P7R9GT5W0ZNXK3M8QAB4CD
orderKey: a2
createdAt: 2026-07-06T14:02:11Z
updatedAt: 2026-07-06T14:02:11Z
authorship: agent
originRunId: 01J2P7Q4V2M8Z6T1RD5FCW9XKB
rev: 1
---
Mara pressed her palm against the storm glass and felt it hum...
```

`frontier/revisions/01J2P7R9GT5W0ZNXK3M8QAB4CD.jsonl` (one line per event, full text each time):

```jsonl
{"type":"revision","rev":1,"ts":"2026-07-06T14:02:11Z","author":"agent","runId":"01J2P7Q4V2M8Z6T1RD5FCW9XKB","text":"Mara pressed her palm against the storm glass..."}
```

`world/entries/mara-voss.7f3akq.md`:

```markdown
---
id: 01J2N8W2KQ7F3AKQY9C4MHT6VP
name: Mara Voss
keys: [Mara, Voss, the keeper]
image: ../images/01J2N8W2KQ7F3AKQY9C4MHT6VP.png
shortSummary: Lighthouse keeper of Cinder Point; hears the sea's dead.
createdBy: user
updatedAt: 2026-07-03T09:15:00Z
---
Mara Voss has kept the Cinder Point light for eleven years...
```

`runs/2026-07/01J2P7Q4...jsonl` (abridged; event schema owned by 05 §run persistence — the model
string is whatever the user's endpoint reports):

```jsonl
{"type":"meta","runId":"01J2P7Q4...","kind":"continue","lane":"high","model":"glm-5","spec":{...},"params":{"maxTokens":2048},"contextSnapshot":{...},"startedAt":"2026-07-06T14:01:58Z"}
{"type":"message","role":"system","text":"<instructions>You are co-writing a novel...</instructions>"}
{"type":"message","role":"user","text":"<world-info>...</world-info><global-context>...</global-context><local-context>...</local-context>"}
{"type":"output","text":"Mara pressed her palm against the storm glass..."}
{"type":"result","status":"ok","usageTotal":{"promptTokens":6412,"completionTokens":388},"artifacts":[{"kind":"snippet","snippetId":"01J2P7R9...","rev":1,"state":"committed"}],"endedAt":"2026-07-06T14:02:11Z"}
```

(The markup regions in the message texts follow the canonical tag grammar in 07-prompting.md;
storage treats message text as opaque.)

---

## 6. Frontier mechanics & consolidation

### 6.1 Appending and ordering
New prose — user-typed or an accepted agent draft — becomes a new snippet file with an `orderKey`
after the current last key (or a previously reserved key, §4). Inserting between snippets (rare
but allowed) generates a key between neighbors. Each accepted edit bumps `rev`, rewrites the
snippet `.md` atomically, and appends a `RevisionEvent` to the snippet's JSONL. Agent commits
record `authorship: 'agent'` (or flip a user snippet to `mixed`) plus the `runId` — including
commits made later via the proposal-apply route (03 §tasks), which go through the same
`reviseSnippet`/`appendSnippet` calls with `author: 'agent'` and the originating run id.

### 6.2 Consolidation trigger

Consolidation is evaluated by a scheduler in `apps/server` (storage itself is a passive library;
the server wires the timers), debounced **30 s** after the last frontier write. It proceeds when:

- the frontier exceeds **maxFrontierSnippets = 18** OR **maxFrontierWords = 9,000**, and
- an **eligible prefix** exists after excluding, from the tail forward:
  - the **active window** — the trailing **activeWindowSnippets = 6** snippets or
    **activeWindowWords = 3,000** words, whichever keeps more (the frontier the user is actually
    working in is never frozen out from under them);
  - any snippet that is the **target of a queued or running task** (target ids supplied by the
    harness scheduler);
  - any snippet flagged **editor-open** by the client via `POST /works/:w/editing
    {snippetId | null}` (03 §routes) — the signal is a per-work in-memory marker
    (`setEditingSnippet`), cleared on save/cancel and cleared server-side when the work's SSE
    subscriber count drops to zero (03 §routes), so a vanished tab can't pin consolidation
    forever.

The user can also invoke "Consolidate now." Defaults live in `work.json → settings` and are
tunable per work. There is no consolidate-on-close: on server shutdown or work close the boundary
agent is simply skipped and the next open consolidates (§9.4).

### 6.3 Who proposes boundaries

**Heuristics gate, agent decides, auto-apply with an undo window.**

1. **Heuristic pre-pass (pure code):** explicit break markers in the eligible prefix — a `***` /
   `---` scene-break line or a user "New chapter" command — split unconditionally.
2. **Boundary agent** (background task, kind `propose-boundaries`, low lane; prompt assembled by
   its harness handler from the eligible prefix plus the short summaries of the last two frozen
   sections — 05 §task handlers): returns a `BoundaryProposal` (§10.5) — 0..n boundaries inside
   the prefix. Snippets after the last boundary always stay live (implied; not a schema field).
   Validation: any `afterSnippetId` that is not in the eligible prefix (agent error, or the
   window moved) causes that boundary to be **dropped**; if all are dropped or none proposed,
   consolidation defers.
3. **Deferral back-off:** on deferral, the effective thresholds grow ×1.5 **in memory only**
   (never persisted into settings), capped at 2× the configured values, and reset on the next
   successful consolidation. After 3 consecutive deferrals the scheduler stops growing the
   thresholds and logs a server-side notice ("long frontier — consider splitting manually") —
   **a log line only in MVP, not a `WorkEvent`; the client renders nothing** — so a dead or
   garbage-returning endpoint cannot let the frontier grow without bound.
4. **Apply mode:** `settings.consolidation.mode = "auto"` (default) applies immediately with a
   toast ("Chapter 3 'The Storm Glass' frozen — Undo"); `"review"` mode stores the proposal and
   waits for confirmation. **M1 ships auto only; review mode is M2.**

*Rejected:* pure-heuristic boundaries (word-count chapter chopping reads terribly); manual-only
freezing (violates the automatic transition and accretes an unbounded frontier — which also
directly inflates every prompt's local-context region, §2.4).

### 6.4 Apply: collapse with provenance, stage for undo

Consolidation apply runs under the work's **single in-process write mutex** (the same mutex every
snippet/section write takes), journaled via `.cowrite/pending-ops.json` (§9.2):

1. **Plan** (journal `phase:"planned"`): boundaries, consumed `snippetIds`, and each snippet's
   plan-time `contentHash`.
2. **Create** section dir(s), `section.json`, `content.md`, `history.jsonl` — idempotent, keyed
   by `opId`. Under the mutex, each snippet file is **re-read at apply time**; if its text
   changed since plan (an edit landed while the boundary agent was thinking), the *newer* text is
   the one written into `content.md` and recorded as `finalText` — a mid-flight edit is folded
   in as if it were a normal post-freeze edit, never lost.
3. **Stage**: consumed snippet `.md` + revision `.jsonl` files **move atomically to
   `.cowrite/undo/<opId>/`**. From this instant `frontier/` is consistent — the reconciler, the
   context engine, and a full index rebuild see each byte of prose exactly once, with no journal
   awareness needed. Journal → `phase:"applied"`.
4. **Grace expiry** (undoGraceMs = 5 min, or server shutdown, whichever first): delete
   `.cowrite/undo/<opId>/`, delete the journal.

`content.md` holds the final text of each consumed snippet, in order, joined by blank lines
(scene-break markers preserved verbatim). `history.jsonl` gets one line per consumed snippet:

```jsonl
{"type":"consolidated","snippetId":"01J2...","orderKey":"a0","authorship":"mixed","originRunId":"01J2...","finalRev":3,"finalText":"...","revisionRunIds":["01J2...","01J2..."],"consolidatedAt":"2026-07-05T22:10:00Z","boundaryRunId":"01J2P5H8..."}
```

- **Intermediate revision texts are discarded** with the staged files. Final text + every `runId`
  that touched the snippet survive, so the provenance UI can still resolve "this paragraph came
  from run X" for frozen prose, and full prompts live on in `runs/` (run files are *not* pruned
  at consolidation — 05 §retention).
- Because `history.jsonl` records snippet order and final texts, un-freezing a section back into
  snippets is mechanically possible. Structured-for, deferred (§13).

**Undo** (within the grace window): reverse-replay the journal — delete the created section
dirs, move the staged files back into `frontier/`, delete the journal — and **cancel any queued
or running `enrich-section` / `illustrate-section` tasks targeting the un-frozen section ids**
(via the harness's cancel-by-target hook, 05 §scheduler) before touching the directories, so an
enrichment run never writes into a directory being deleted.

### 6.5 Editing behind the frontier & staleness

Frozen sections are plain Markdown; editing them **merely works**:

- **In-app edit:** the editor writes `content.md` atomically (with `baseHash` concurrency, §6.6),
  updates `contentHash` in `section.json`. No snippet-level history is kept behind the frontier
  ("put it in git" is the versioning story there).
- **External edit** (VS Code, Obsidian…): detected by the reconciler (§8); identical staleness
  consequences, computed from hashes.
- **User-edited summaries:** `putSummary(sectionId, kind, text, {source: 'user'})` writes the
  summary file and records `source: 'user'` with the *current* `sourceHash` — a user-edited
  summary is not stale until the prose changes again.
- Stale enrichments are **not** auto-regenerated on the spot; the section shows a subtle
  "out of date" badge and the enrichment sweep refreshes them in the background (05 §scheduler)
  — external edits never cause surprise API spend.
- Structural edits (split/merge/reorder of frozen sections) are journaled app operations that
  rewrite the affected `section.json` orderKeys/dirs; enrichments of affected sections go stale.
  Moving a chapter never rewrites its neighbors' content.

**Staleness is derived, never stored as a flag** — immune to crash-ordering and external edits:

| Enrichment | Stale iff |
|---|---|
| shortSummary / longSummary | `meta.sourceHash !== hash(content.md)` **or** the enrichment is missing on a frozen leaf section |
| illustration (`source:'agent'`) | `abs(wc(content.md) − meta.sourceWordCount) / meta.sourceWordCount > illustrationStaleWordDeltaPct/100` (default 15 %) **or** missing on a frozen leaf section (and not suppressed) **or** explicit user request |
| illustration (`source:'user'`) | never (user uploads are pinned until deleted or regenerated) |
| illustration tombstone (`suppressed`) | never (the sweep must not resurrect a deleted image) |

The "missing counts as stale" rule is what makes restart recovery work: a crash between
consolidation and enrichment leaves a frozen section with no summary, and the next sweep picks it
up with no queue state to persist. The word-count rule (not the hash) governs illustrations so
that a comma fix regenerates summaries but not art.

### 6.6 Optimistic concurrency contract

Storage owns conflict detection; every mutating call takes a concurrency token and returns a
typed result instead of throwing:

```ts
reviseSnippet(id, text, {author, runId?, baseRev})
    → {ok: true, rev} | {ok: false, conflict: {currentRev, currentText}}
restoreSnippet(id, rev, {author})                 // appends a NEW revision with the old text —
    → {ok: true, rev}                             // the log stays append-only ("cycle & roll back")
replaceSectionContent(sectionId, text, {baseHash})
    → {ok: true, contentHash} | {ok: false, conflict: {currentHash}}
replaceSectionSpan(sectionId, {startChar, endChar}, text, {runId?, baseHash})
    → same shape                                  // span offsets are valid against baseHash's text
putSituation(text, {baseHash})
    → {ok: true, updatedAt, hash} | {ok: false, conflict: {currentText, updatedAt, hash}}
```

A `conflict` result is what the API surfaces as HTTP 409 and what agent commits degrade to a
`state: "conflict"` artifact (05 §commit) — the target changed while the writer worked.
Sections use `contentHash` as the token; snippets use `rev`; the situation uses the xxh64 hash
of its text (mtime is display-only — coarse filesystem timestamps can collide across writes).
A target that has *vanished* (deleted or consolidated away) surfaces as a typed NotFound error
rather than a conflict result — the conflict shape carries the current state, which a missing
target cannot supply — and the API maps it to 404.

---

## 7. The rebuildable SQLite index

`.cowrite/index.sqlite`, WAL mode, one DB per work. It is a **cache**: any question it answers
must be answerable (slowly) from files alone.

### 7.1 Schema

```sql
PRAGMA user_version = 1;               -- index schema version; mismatch ⇒ rebuild

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
-- rows: workId, levelScheme, lastScanAt, situationHash

CREATE TABLE files (                    -- external-change detection (§8)
  path      TEXT PRIMARY KEY,          -- work-relative
  size      INTEGER NOT NULL,
  mtime_ms  INTEGER NOT NULL,
  xxh64     TEXT NOT NULL
);

CREATE TABLE sections (
  id           TEXT PRIMARY KEY,
  parent_id    TEXT REFERENCES sections(id),
  kind         TEXT NOT NULL,
  order_key    TEXT NOT NULL,
  title        TEXT,
  title_source TEXT NOT NULL DEFAULT 'agent',     -- 'user' | 'agent'
  dir_path     TEXT NOT NULL,
  word_count   INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT,
  frozen_at    TEXT,
  short_summary_stale INTEGER NOT NULL DEFAULT 0, -- derived at scan time (§6.5 rules)
  long_summary_stale  INTEGER NOT NULL DEFAULT 0,
  illustration_stale  INTEGER NOT NULL DEFAULT 0,
  illustration_hash   TEXT,             -- xxh64 of the PNG bytes ⇒ SectionRow.illustrationVersion
  illustration_width  INTEGER,          -- pixel dims, read from the PNG header at index time
  illustration_height INTEGER
);
CREATE INDEX ix_sections_tree ON sections(parent_id, order_key);

CREATE TABLE snippets (
  id             TEXT PRIMARY KEY,
  order_key      TEXT NOT NULL,
  authorship     TEXT NOT NULL,
  origin_run_id  TEXT,
  rev            INTEGER NOT NULL,
  revision_count INTEGER NOT NULL DEFAULT 1,      -- for SnippetDto.revisionCount (03)
  word_count     INTEGER NOT NULL,
  updated_at     TEXT NOT NULL,
  file_path      TEXT NOT NULL
);
CREATE INDEX ix_snippets_order ON snippets(order_key);

CREATE TABLE world_entries (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, short_summary TEXT,
  image_path TEXT, file_path TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE world_keys (               -- one row per alias; consumer: illustration pipeline (08)
  entry_id TEXT NOT NULL REFERENCES world_entries(id),
  key TEXT NOT NULL COLLATE NOCASE,
  PRIMARY KEY (entry_id, key)
);
CREATE INDEX ix_world_keys ON world_keys(key);

CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                   -- TaskKind, kebab-case (05)
  lane TEXT NOT NULL,                   -- 'high' | 'low' — the cost split the usage panel needs
  model TEXT,
  started_at TEXT NOT NULL, ended_at TEXT, status TEXT,
  prompt_tokens INTEGER, completion_tokens INTEGER,
  file_path TEXT NOT NULL
);
CREATE TABLE run_artifacts (            -- run ⇄ artifact join: "what produced this version?"
  run_id TEXT NOT NULL REFERENCES agent_runs(id),
  artifact_kind TEXT NOT NULL,          -- snippet | snippet-revision | section-span | section-title
                                        -- | summary-short | summary-long | illustration
                                        -- | world-image | boundary            (RunArtifact enum, 05)
  artifact_id TEXT NOT NULL,            -- snippetId, sectionId, or entryId
  rev INTEGER,                          -- for snippet revisions
  state TEXT NOT NULL DEFAULT 'committed',  -- committed | conflict | skipped
  PRIMARY KEY (run_id, artifact_kind, artifact_id, rev)
);
CREATE INDEX ix_artifacts_by_target ON run_artifacts(artifact_kind, artifact_id);

-- Full-text search over prose + world. Plain (contentful) FTS5: it stores a copy of the text,
-- which is fine — duplication is explicitly acceptable — and it keeps incremental updates and
-- deletes trivial, which contentless tables do not.
CREATE VIRTUAL TABLE fts USING fts5(kind, entity_id UNINDEXED, title, body);
```

### 7.2 Queries it serves

| Consumer | Query |
|---|---|
| UI: section sidebar / `GET /sections` | tree by `(parent_id, order_key)` with word counts, staleness, `illustration_hash` (cache-busting version) + pixel dims; summary texts read from files and inlined by the route (03 §sections) |
| UI: frontier pane | `snippets ORDER BY order_key` incl. `revision_count` |
| UI: provenance ("how was this written?") | `run_artifacts WHERE artifact_kind=? AND artifact_id=?` → run file paths, per rev |
| Illustration pipeline | `world_keys WHERE key IN (…)` behind `matchWorldEntries`; `listIllustrationMetas` |
| Enrichment sweep (05) | sections where any `*_stale = 1` (incl. missing-enrichment staleness, §6.5) |
| Search (⌘K) | FTS5 across prose, titles, world bodies |
| Usage panel | token sums over `agent_runs` grouped by `lane` / `kind` |

The context engine does **not** query the index for inclusion decisions; it reads prose,
summaries, and the situation through its injected readers and computes token counts itself
(06 §deps). The index only serves it indirectly via the same storage reads everyone uses.

### 7.3 Rebuild policy

- **Incremental (normal):** every app write updates files and index in one call; the reconciler
  patches rows for externally-changed files.
- **Full rebuild** — delete DB, scan, reparse, repopulate — on: `user_version` mismatch, SQLite
  corruption, missing `.cowrite/`, journal-replay inconsistency, or user request. For `runs/**`
  the rebuild parses **only each file's first line (`meta`) and final line (`result`)** — first
  line read + tail seek, never the full transcript — so run volume (plausibly thousands of files
  after a year) does not blow the budget. Target: **< 2 s for a 200k-word work's
  sections/frontier/world/situation tables**; run backfill proceeds in the same pass but is
  allowed to lag (the UI needs `agent_runs` rows lazily). Rebuild is the universal repair: any
  storage bug's worst case is "rebuild and move on."

---

## 8. Tolerating external edits (the reconciler)

Users *will* open these files in other editors. The reconciler runs at: **work open**, **before
every agent run** (context is never assembled from stale rows), and on a **30 s timer while the
work has ≥ 1 SSE subscriber** (the server-observable proxy for "the app is open" — there is no
window-focus signal in a console-server architecture, and none is needed).

```
reconcile():
  walk = all tracked paths (work.json, situation.md, sections/**, frontier/**, world/**)
  for each path in walk ∪ files-table:
    if missing on disk           → drop the entity's index rows; emit a one-shot
                                    'removed externally' warning event (no tombstone rows —
                                    they wouldn't survive a rebuild, so we don't pretend)
    else if (size, mtime_ms) match files row → skip            # fast path, no read
    else:
      h = xxh64(file)
      if h == files.xxh64        → update mtime row only        # e.g. touch(1)
      else                       → reparse:
          - valid frontmatter, known id    → update rows, recompute staleness (§6.5)
          - valid frontmatter, unknown id  → adopt as new entity
          - no/broken frontmatter         → per-directory adoption rules (below)
  renumber filename prefixes if drifted (lazy, batched)
  emit StorageChange events for everything that changed (§11) → API fans out over SSE
```

**Adoption rules, per directory** (adoption is the failure mode; we never delete or quarantine):

| Location of a foreign/frontmatter-less `.md` | Action |
|---|---|
| `frontier/snippets/` | adopt as a snippet: re-associate by filename short-id first (a stripped-frontmatter save keeps its identity and revision log); otherwise mint a ULID, derive `orderKey` from filename sort position, write frontmatter back atomically |
| `world/entries/` | adopt as a world entry (same short-id-first rule) |
| inside a section dir (e.g. a stray `notes.md`) | **never adopt** — list as an "unrecognized file" in the reconciler report; leave untouched |
| directly under `sections/` (not a section dir) | same: report, leave untouched |

The short-id re-association step exists precisely because frontmatter write-back can race an open
external editor: if the user's next save strips our frontmatter, the file is re-recognized by its
filename short id instead of being re-minted under a new ULID (which would orphan its revision
log).

Conflicts in the classic sense cannot happen — files are the truth, so an external edit simply
wins and index/staleness follow. The one guarded window: if the in-app editor holds unsaved
changes to a file the reconciler sees changed on disk, the UI surfaces a theirs/mine choice
(visible prompt, no silent merge) — plumbed via the `conflict` results of §6.6.

Because consumed snippets are *moved out* of `frontier/` at consolidation apply (§6.4), the
reconciler needs no awareness of the journal or the undo window: the file tree is unambiguous at
every instant, and so is a full rebuild.

---

## 9. Atomicity & crash safety

### 9.1 Single files
Every JSON/Markdown/PNG write: write `name.md.tmp-<ulid>` in the same directory → `fsync` file →
`rename` over target → `fsync` directory (POSIX; on Windows, `FlushFileBuffers` + `ReplaceFile`).
JSONL appends: a single `write()` of the whole line ending in `\n`; readers drop a torn final
line, and the reconciler re-derives anything lost from the primary files. Orphaned `tmp-*` files
are swept at startup.

### 9.2 Multi-file operations (consolidation, section split/merge/move)
Journaled two-phase apply via `.cowrite/pending-ops.json`, as sequenced in §6.4. Recovery at work
open:

- journal at `planned` → roll forward from step 2 (every step is idempotent, keyed by `opId`);
- at `applied` → resume the grace timer; on expiry (or immediately at shutdown) delete
  `.cowrite/undo/<opId>/` and the journal;
- a file found in *both* a new section (`content.md`) and `frontier/` (crash inside step 3's
  move loop) → the section wins; the frontier copy matching the journal's `snippetIds` is moved
  to staging.

Undo = reverse replay while phase ≤ `applied` (§6.4, including enrichment-task cancellation).

### 9.3 Single-writer lock
`.cowrite/lock` holds `{pid, hostname, nonce, acquiredAt}`, refreshed every 30 s. A second
instance opening the same work sees a live lock and opens **read-only** with a banner. Two
hardening rules:

- **Stale detection:** a lock is stale when it is > 2 min old **or** its pid is not alive on the
  same host — so a crash-restart reclaims its own work immediately instead of waiting out the
  age window.
- **Nonce re-validation:** before every write batch (and after any detected clock jump larger
  than the refresh interval — i.e. the process was suspended), the writer re-reads the lock and
  verifies its own nonce. Mismatch ⇒ another instance legitimately took over while we slept;
  drop to read-only with the banner. This closes the suspend/resume two-writer hole: a resumed
  process finds a foreign nonce and stands down rather than clobbering.

### 9.4 Work close
Close is defined by the API layer (03 §lifecycle): zero SSE subscribers for N minutes, or server
shutdown. On close, storage's part is: finish journal steps (staged undo dirs are purged — the
grace window does not survive a close), release the lock. The boundary agent is skipped at close;
the next open consolidates. **Correctness never depends on close** — the journal covers hard
kills.

---

## 10. Shared schemas (Zod)

These live in `packages/shared/src/` and are the single contract across server, web, and tests.
File placement follows the shared-package layout: `ids.ts`, `work.ts`, `section.ts`,
`snippet.ts`, `world.ts`, `situation.ts`, `enrichment.ts` (this subsystem's files); `runs.ts`,
`tasks.ts` (owned by 05); `illustration.ts` (owned by 08); `events.ts` (owned by 03);
`context.ts` (owned by 06).

### 10.1 Primitives (`ids.ts`)

```ts
import { z } from "zod";

export const Ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
export const OrderKey = z.string().regex(/^[0-9a-z]+$/);   // fractional index, base-36 (§4)
export const IsoTime = z.string().datetime();
export const Hash = z.string().regex(/^xxh64:[0-9a-f]{16}$/);
export const EntityKind = z.enum(["work", "section", "snippet", "world", "run"]);
// Ids are bare ULIDs everywhere; payloads mixing kinds carry an explicit `kind` field.
```

### 10.2 Work (`work.ts`)

```ts
export const ConsolidationSettings = z.object({
  activeWindowSnippets: z.number().int().positive().default(6),
  activeWindowWords:    z.number().int().positive().default(3000),
  maxFrontierSnippets:  z.number().int().positive().default(18),
  maxFrontierWords:     z.number().int().positive().default(9000),  // bounds the engine's
  debounceMs:           z.number().int().positive().default(30_000),// local-context region (§2.4)
  undoGraceMs:          z.number().int().positive().default(300_000),
  mode: z.enum(["auto", "review"]).default("auto"),                 // "review" is M2
});

export const WorkSettings = z.object({
  consolidation: ConsolidationSettings.default({}),
  illustrationStaleWordDeltaPct: z.number().default(15),
  contextOverrides: BudgetKnobs.partial().default({}),  // per-work overrides of the context
});                                                     //   engine's budget knobs (06 §8.1,
                                                        //   imported from context.ts; edited
                                                        //   via PATCH /works/:w, 03 §config)

export const WorkMeta = z.object({
  schemaVersion: z.literal(1),
  id: Ulid,
  title: z.string().min(1),
  levelScheme: z.array(z.string().min(1)).min(1).default(["chapter"]), // backend-owned
  createdAt: IsoTime,
  settings: WorkSettings.default({}),
});
```

### 10.3 Enrichment & section (`enrichment.ts`, `section.ts`)

```ts
// Summaries and titles. A user may edit summaries directly (03 §sections), so the run id is
// nullable and the source is recorded; staleness derives from sourceHash per §6.5.
export const EnrichmentMeta = z.object({
  source: z.enum(["agent", "user"]).default("agent"),
  runId: Ulid.nullable(),               // null iff source === "user"
  generatedAt: IsoTime,
  sourceHash: Hash,                     // hash of the content.md it was generated from
});

// The illustration slot is a three-state union (IllustrationMeta itself is owned by 08 §metadata:
// prompt/workflow/seed/score/attempts/guidance + source, nullable runId, sourceWordCount,
// entities: Ulid[] recorded at compose time).
export const IllustrationSlot = z.union([
  z.null(),                                                  // never had one / cleared
  IllustrationMeta,                                          // present
  z.object({ suppressed: z.literal(true), deletedAt: IsoTime }), // user deleted; do not regenerate
]);

export const SectionMeta = z.object({
  schemaVersion: z.literal(1),
  id: Ulid,
  kind: z.string(),                     // must ∈ work.levelScheme (validated at load)
  orderKey: OrderKey,
  title: z.string().nullable(),
  titleSource: z.enum(["user", "agent"]).default("agent"),
  frozenAt: IsoTime.nullable(),
  contentHash: Hash.nullable(),         // null for interior (non-leaf) sections
  enrichments: z.object({
    shortSummary: EnrichmentMeta.nullable(),
    longSummary:  EnrichmentMeta.nullable(),
    illustration: IllustrationSlot,
  }),
});
```

### 10.4 Snippet (`snippet.ts`)

```ts
export const SnippetMeta = z.object({
  id: Ulid,
  orderKey: OrderKey,
  createdAt: IsoTime,
  updatedAt: IsoTime,
  authorship: z.enum(["user", "agent", "mixed"]),
  originRunId: Ulid.nullable(),
  rev: z.number().int().positive(),
});

// frontier/revisions/<id>.jsonl — one line per accepted edit, FULL text each time
export const RevisionEvent = z.object({
  type: z.literal("revision"),
  rev: z.number().int().positive(),
  ts: IsoTime,
  author: z.enum(["user", "agent"]),
  runId: Ulid.optional(),               // present iff author === "agent"
  text: z.string(),                     // snippets are small; diffs rejected
});
```

### 10.5 Consolidation (`section.ts`)

```ts
// sections/**/history.jsonl — one line per consumed snippet
export const ConsolidatedSnippet = z.object({
  type: z.literal("consolidated"),
  snippetId: Ulid,
  orderKey: OrderKey,
  authorship: z.enum(["user", "agent", "mixed"]),
  originRunId: Ulid.nullable(),
  finalRev: z.number().int().positive(),
  finalText: z.string(),
  revisionRunIds: z.array(Ulid),        // every agent run that ever touched it
  consolidatedAt: IsoTime,
  boundaryRunId: Ulid.nullable(),       // null when a pure-heuristic break decided it
});

// Result contract of the propose-boundaries task (handler in 05). Boundaries outside the
// eligible prefix are dropped at validation (§6.3); snippets after the last boundary stay live.
export const BoundaryProposal = z.object({
  boundaries: z.array(z.object({
    afterSnippetId: Ulid,
    kind: z.string(),                   // ∈ levelScheme
    title: z.string(),
  })),
});
```

### 10.6 World (`world.ts`)

```ts
export const WorldEntryMeta = z.object({
  id: Ulid,
  name: z.string().min(1),
  keys: z.array(z.string().min(1)).default([]),  // optional aliases; not prompt-gating (§2.6)
  image: z.string().nullable(),                  // work-relative path
  shortSummary: z.string().nullable(),
  createdBy: z.enum(["user", "agent"]),
  updatedAt: IsoTime,
});
```

### 10.7 Runs — consumed, not defined here

`RunEvent`, `RunArtifact`, `ContextSnapshot` (`packages/shared/src/runs.ts`) and `TaskKind`
(`tasks.ts`) are owned by 05; `ContextSnapshot` *values* are produced by 06. Storage's
obligations toward them:

- `recordRun(runId)` returns an **append sink**: each `RunEvent` becomes one JSONL line at
  `runs/<YYYY-MM>/<runId>.jsonl`; the file is write-once after `result`, except for the one
  post-`result` `proposal` resolution line that proposal apply/discard appends through the
  same sink (05 §5.1 — the durable, idempotent resolution marker).
- Run files whose `result` never arrived (crash) are finalized at the next work open as
  `status:"error", code:"crash"` by appending a synthesized `result` line.
- The `agent_runs` / `run_artifacts` tables (§7.1) ingest exactly the `meta` and `result` lines:
  `kind` (TaskKind), `lane`, `promptTokens`/`completionTokens` → `prompt_tokens` /
  `completion_tokens`, the 9-kind artifact enum with `state`.
- Retention: run files are permanent by default; they are *not* collapsed at consolidation
  (their ids must keep resolving from `history.jsonl` for provenance on frozen prose). The
  `retention.pruneRunsAfterMonths` knob (default off, M2) deletes run files whose ids no longer
  appear in any `history.jsonl`, revision log, or enrichment metadata.

---

## 11. StorageService surface

One in-process service per open work, constructed by `openWork(slug)` (acquire lock → replay
journal → reconcile → open index). All calls are synchronous or promise-returning library calls;
the API layer (03) maps them to routes, the harness (05) and pipelines call them directly. All
writes go through the single per-work mutex.

```ts
interface StorageService {
  // lifecycle
  listWorks(): WorkSummary[];                       // scans <dataDir>/works/*/work.json
  createWork(title): WorkMeta;  trashWork(slug): void;      // move to <dataDir>/.trash/
  openWork(slug): WorkHandle;   closeWork(): void;          // §9.4

  // situation
  getSituation(): { text, updatedAt };
  putSituation(text, { baseHash }): OkOrConflict;

  // sections
  listSections(): SectionRowSource[];               // index-backed; route inlines summary text
  getSectionContent(id): { text, contentHash };
  replaceSectionContent(id, text, { baseHash }): OkOrConflict;
  replaceSectionSpan(id, span, text, { runId?, baseHash }): OkOrConflict;   // §6.6
  setSectionTitle(id, title, { source }): void;     // source:'user' pins against enrichment
  putSummary(id, "short" | "long", text, { source, runId? }): void;
  putIllustration(id, png, meta: IllustrationMeta): void;   // atomic overwrite; 08 commits here
  suppressIllustration(id): void;  clearSuppression(id): void;

  // frontier
  listSnippets(): SnippetRow[];
  reserveOrderKey(): OrderKey;                      // §4 reserved-key semantics
  appendSnippet(text, { author, runId?, orderKey? }): SnippetMeta;
  reviseSnippet(id, text, { author, runId?, baseRev }): OkOrConflict;
  restoreSnippet(id, rev, { author }): { rev };
  getRevisions(id): RevisionEvent[];
  setEditingSnippet(id | null): void;               // consolidation guard, fed by 03's route

  // consolidation
  maybeConsolidate(guards: { taskTargetIds: Ulid[] }): void;  // scheduler entry point (§6.2)
  applyBoundaries(proposal: BoundaryProposal, { boundaryRunId }): { opId };
  undoConsolidation(opId): void;                    // caller must first cancel-by-target (§6.4)

  // world
  listWorldEntries(): WorldEntry[];  getWorldEntry(id): WorldEntry;
  upsertWorldEntry(entry): WorldEntryMeta;  deleteWorldEntry(id): void;
  matchWorldEntries(text): WorldEntry[];            // key scan; consumer: illustration (08)
  putWorldImage(id, png, meta: IllustrationMeta): void;
  listIllustrationMetas(): Array<{ kind, id, meta }>;

  // runs
  recordRun(runId): RunSink;                        // append RunEvents; §10.7
  readRun(runId): RunEvent[];
  queryRunsByArtifact(kind, id): RunSummary[];

  // maintenance & events
  reconcile(): ReconcileReport;  rebuildIndex(): void;
  search(query): FtsHit[];
  onChange(cb: (e: StorageChange) => void): Unsubscribe;
}
```

**`onChange`** is the storage event hook: every committed mutation (including reconciler
adoptions and staleness flips) emits a `StorageChange` that maps 1:1 onto the storage-originated
members of the canonical `WorkEvent` union (`snippet.created`, `section.changed`,
`enrichment.updated`, `situation.changed`, …; union owned by 03 §SSE). The API layer subscribes
and fans out over the per-work SSE stream; the harness scheduler subscribes to staleness flips to
feed its enrichment sweep (05 §scheduler); the context engine subscribes to `enrichment.updated`
for its anchor refresh (06 §anchors). Storage itself never touches HTTP or SSE.

---

## 12. Failure modes & testing

| Failure | Behavior |
|---|---|
| Crash mid single-file write | tmp file orphaned (swept at startup), target intact |
| Crash mid consolidation | journal replay rolls forward or back deterministically (property-tested: kill at every step) |
| Edit lands between consolidation plan and apply | apply re-reads under the mutex; newer text is folded into `content.md` (§6.4) — never lost |
| Undo during enrichment of the frozen section | undo cancels enrich/illustrate tasks by target id before deleting dirs (§6.4) |
| Torn JSONL tail | last line dropped; the primary `.md` file is unaffected; index rebuilt if needed |
| SQLite corruption / deleted `.cowrite/` | full rebuild (< 2 s core tables, §7.3); zero user data lost |
| External edit / rename / new file | reconciler adopts per §8 rules; staleness derived from hashes |
| Frontmatter stripped by an external editor | re-associated by filename short id; identity and revision log survive |
| Two app instances | lockfile → second instance read-only with banner |
| Suspend/resume after a lock takeover | nonce mismatch on next write batch → resumed instance drops to read-only (§9.3) |
| Crash-restart within the lock age window | dead-pid check reclaims the lock immediately (§9.3) |
| Crash between consolidation and enrichment | missing enrichment on a frozen section counts as stale → next sweep repairs (§6.5) |
| Boundary agent returns garbage / unreachable | Zod-validated; invalid ⇒ deferral with capped in-memory back-off + log-only notice after 3 (§6.3) |
| Clock skew | ordering never depends on timestamps (orderKeys + ULID tiebreak); clock jumps trigger lock re-validation |

**Test strategy.** The storage layer has zero UI or HTTP dependencies — unit-test entity
round-trips against the shared Zod schemas; property-test fractional-index insertion (incl.
reserved keys) and journal crash-recovery (inject kill-points at every step, including inside the
step-3 move loop); golden-directory tests (fixture work dir in → expected index rows out); fuzz
the reconciler with random external mutations (rename/edit/delete/add/strip-frontmatter) and
assert the invariants: *no user file is ever deleted*, and *index state == fresh rebuild* after
every reconcile. Concurrency tests drive `reviseSnippet`/consolidation interleavings through the
mutex and assert no text is ever lost.

---

## 13. Milestones

**M1 (MVP):**
- Full on-disk layout (§5): work/situation/sections/frontier/world/runs/`.cowrite`, atomic
  writes, op journal, undo staging, lockfile with nonce + pid-liveness
- Snippet append/edit/revision log, `reserveOrderKey`, optimistic-concurrency contract (§6.6)
  incl. `restoreSnippet`; flat `["chapter"]` level scheme (schema + tree code fully general)
- Auto consolidation: heuristics + `propose-boundaries` agent, editing/task-target guards,
  capped deferral back-off, undo with task cancellation; collapse-with-provenance
- Situation storage; world entries with optional keys + `matchWorldEntries`
- Enrichment metadata incl. the illustration slot union; derived staleness (incl.
  missing-counts-as-stale) feeding the background sweep
- SQLite index incl. FTS5, run tables (`lane`, token columns, 9-kind artifacts + `state`),
  `revision_count`, illustration version/dimensions; full + incremental rebuild
- Reconciler (open / pre-run / 30 s-with-subscribers) with per-directory adoption rules
- Run sink, crash finalization, read/query APIs; `onChange` event hook
- Mock-free unit/property/golden/fuzz test suites as above

**M2:**
- `replaceSectionSpan` consumers go live (edit-task section-span commits)
- `review` consolidation mode
- Run pruning (`retention.pruneRunsAfterMonths`)
- Candidate staging dir (`.cowrite/illustration-candidates/`) for the picker (08)

**Structured-for, deferred beyond M2:**
- Un-freeze a frozen section back into snippets (mechanically supported by `history.jsonl`)
- Boundary agent proposing multi-level splits (`part/chapter/scene`) automatically — the
  schema, storage, engine, and UI already handle arbitrary `levelScheme` nesting in M1, where
  the scheme is changed by editing `work.json` (§2.1)
- Edit history behind the frontier ("use git" until then)
- Live fs-watcher (chokidar) replacing polling; run-file gzip archival; orphaned-image GC;
  cross-work library index; trash GC

---

## 14. Contracts

Shared schemas this subsystem **owns** (in `packages/shared/src/`):

| Schema | File | Consumers |
|---|---|---|
| `Ulid`, `OrderKey`, `IsoTime`, `Hash`, `EntityKind` | `ids.ts` | everyone |
| `WorkMeta`, `WorkSettings`, `ConsolidationSettings` | `work.ts` | 03 (config/works routes), 05 (scheduler), 06 (`contextOverrides` resolution) |
| `SectionMeta`, `ConsolidatedSnippet`, `BoundaryProposal` | `section.ts`, `enrichment.ts` | 03 §sections, 05 §task handlers, 06 §default map |
| `EnrichmentMeta`, `IllustrationSlot` | `enrichment.ts` | 03 §sections, 05 §sweep, 08 §metadata |
| `SnippetMeta`, `RevisionEvent` | `snippet.ts` | 03 §snippets, 04 §provenance, 05 §commit |
| `WorldEntryMeta` | `world.ts` | 03 §world, 04 §highlighting, 08 §compose |
| `SituationDto` | `situation.ts` | 03 §situation, 06 §regions |

Shared schemas this subsystem **consumes**:

| Schema | Owner | Used for |
|---|---|---|
| `TaskKind`, `RunEvent`, `RunArtifact` | 05 §run persistence | run sink, `agent_runs`/`run_artifacts` ingestion (`meta` + `result` lines) |
| `ContextSnapshot` | 05 (`runs.ts`; values produced by 06) | stored opaquely inside run `meta` events |
| `BudgetKnobs` | 06 (`context.ts`) | `WorkSettings.contextOverrides` (per-work partial overrides, §10.2) |
| `IllustrationMeta` | 08 §metadata | the present-state of `IllustrationSlot`; world-image sidecars |
| `WorkEvent` | 03 §SSE | `onChange` emissions map onto its storage-originated members |
| `ServerConfig` (`storage.dataDir`, retention) | 03 §config | dataDir resolution (default `~/.cowrite/data`), run pruning |

Cross-subsystem touchpoints: `POST /works/:w/editing` (03 §routes) feeds `setEditingSnippet`;
the harness scheduler supplies task-target ids to `maybeConsolidate` and exposes
cancel-by-target for undo (05 §scheduler); work *close* is defined in 03 §lifecycle (§9.4 here);
prompt markup inside run transcripts follows 07-prompting.md and is opaque to storage.
