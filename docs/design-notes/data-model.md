# Data Model & On-Disk Storage — Subsystem Design

**App:** Cowrite — a local-first, illustrated long-form co-writing tool ("simple, modern, snappy")
**Subsystem owner:** Data model & storage
**Status:** Proposal v1 (2026-07-06)

> **Provenance note.** The product-brief path supplied to this task resolved to `undefined` and no
> brief file exists in the repository (the repo contains only a LICENSE at the time of writing).
> This design is built from the detailed subsystem charter in the task itself. Every assumption
> that would normally come from the brief — especially the fixed baseline stack — is called out
> explicitly in [§13 Interface assumptions](#13-interface-assumptions) so it can be cross-checked
> against the real brief.

---

## 1. Design principles

1. **Files are the source of truth; the database is a cache.** Everything a user cares about
   (prose, world entries, summaries, images) lives as plain Markdown/PNG/JSON on disk in a layout
   a human can read, `grep`, back up, and put in git. The SQLite index is derived, disposable, and
   rebuildable from the files alone.
2. **One writer, many readers.** Exactly one app process owns a work at a time (advisory
   lockfile). External editors are tolerated readers *and* writers — we reconcile, we never fight.
3. **Append at the frontier, settle behind it.** The hot path (frontier snippets) is
   append-mostly with cheap per-snippet files and JSONL revision logs. Cold content (frozen
   sections) is boring Markdown that any tool can edit; edits there "merely work" and only cost a
   staleness flag.
4. **Crash-safe by construction, not by cleverness.** Single-file writes are atomic
   (tmp+fsync+rename). The one multi-file operation (consolidation) is journaled and idempotent.
5. **Resist fiddly features.** No CRDTs, no content-addressed blob store, no custom binary
   formats, no diffs-of-diffs. Snippets are small; store whole texts.

---

## 2. Entity model

```
Work 1 ──── * Section          (tree: parentId, depth per work.levelScheme)
Work 1 ──── * Snippet          (the frontier; ordered, not yet owned by a Section)
Work 1 ──── * WorldEntry
Work 1 ──── * AgentRun
Section 1 ── 0..1 Illustration, 0..1 ShortSummary, 0..1 LongSummary   (enrichments)
Section 1 ── * ConsolidatedSnippet   (provenance records inside history.jsonl)
Snippet 1 ── * RevisionEvent   (JSONL log; each revision may reference an AgentRun)
WorldEntry 1 ── 0..1 Image
AgentRun 1 ── * artifacts (snippet revisions, summaries, illustrations, boundary proposals)
```

### 2.1 Work
The root container. One directory per work. Holds title, the **level scheme** (an ordered list of
section kinds, e.g. `["part","chapter","scene"]`), schema version, and tunable settings
(consolidation thresholds). The level scheme lives in `work.json` and is a backend/config concern —
changing it is a data migration we control, never a user-facing setting, exactly as the charter
requires.

**MVP default level scheme: `["chapter"]`** (flat list of chapters). The tree machinery below is
fully general so switching a work to `["part","chapter"]` or `["chapter","scene"]` later is a
directory reshuffle plus index rebuild, not a schema change.

### 2.2 Section
A node in the manuscript tree. **Leaf sections carry prose** (`content.md`); interior sections are
grouping nodes only (no mixed content — keeps consolidation and context-window logic simple).
A section is either **frozen** (normal state — consolidated prose) or, transiently, the target of
an in-flight consolidation. Sections own their enrichments and their staleness flags.

### 2.3 Snippet
The frontier unit. A snippet is one contiguous chunk of prose (typically 100–2,000 words) at the
growing tail of the work, **not yet assigned to any section**. Snippets carry:

- `authorship`: `user` | `agent` | `mixed` (agent-drafted then user-edited, or vice versa)
- `originRunId`: the AgentRun that first produced it (null for user-typed)
- an ordered position among frontier snippets (`orderKey`, §4)
- a revision history: every accepted edit appends a full-text `RevisionEvent` to a per-snippet
  JSONL log, each event tagged `user` or `agent` (+ `runId`). This is what lets the UI show "which
  prompt/process produced this version."

### 2.4 Enrichments
Per section: `shortSummary` (1–3 sentences, used in context assembly), `longSummary` (a few
paragraphs, used for "previously on…" and deep-context), **exactly one illustration** (PNG), and an
optional generated `title` (the "name" enrichment — stored as the section title with a
`titleSource: user|agent` flag so a user rename is never clobbered). Each enrichment records the
`runId` that produced it, `generatedAt`, the `contentHash` of `content.md` it was generated from,
and a derived `stale` state.

### 2.5 WorldEntry (world-info / context entries)
`name`, `keys[]` (trigger strings/aliases for the context engine's key scan), Markdown `body`,
optional `image`, optional `shortSummary` (compressed form for tight context budgets). Created by
the user or proposed by an agent (`createdBy`). One Markdown file per entry.

### 2.6 AgentRun
An auditable record of one agent invocation: kind (`draft`, `revise`, `summarize`, `boundary`,
`illustrate`, `world-extract`), model + params, the fully-assembled prompt (messages), streaming
output, tool calls, token usage, timing, and references to the artifacts it produced. One JSONL
file per run. Runs are **write-once**: nothing edits a run file after `result` is appended.

---

## 3. IDs

- **All entity IDs are ULIDs** (26-char Crockford base32). Sortable-by-creation, collision-free,
  filename-safe, no coordination needed. *Rejected:* UUIDv4 (not sortable, uglier in filenames);
  sequential ints (require a central counter, break under external file creation).
- Filenames embed a **short id** — the last 6 chars of the ULID — plus a human slug, e.g.
  `020-the-storm.k9v3qa/`. The full ULID lives in the entity's metadata; the short id in the
  filename is only for human orientation and for re-associating a renamed file with its identity.

---

## 4. Ordering: fractional order keys

Every ordered collection (sections among siblings, snippets in the frontier) is ordered by a
**fractional-index `orderKey`**: a base-62 string generated between neighbors
(à la Figma / `fractional-indexing` npm package). Sort lexicographically; tie-break by ULID.

- Insertion anywhere touches **one file** (the inserted item), never a central manifest.
- Ordering is derivable from the files alone → index stays rebuildable.
- Directory/file names carry a numeric prefix (`010-`, `020-`) as a *human-readable mirror* of
  order. The `orderKey` in metadata is authoritative; the reconciler (§8) renumbers prefixes
  lazily and assigns orderKeys to foreign files by filename sort.

*Rejected:* a central `order.json` array per work (single hot file, contended by every insert, and
external file additions bypass it); mtime/ULID-only ordering (breaks the moment anything is
inserted or re-ordered).

---

## 5. On-disk format

### 5.1 File-format policy

| Data | Format | Why |
|---|---|---|
| Prose (frozen sections, snippets, world bodies) | **Markdown + YAML frontmatter** | Human-editable, git-diffable; frontmatter carries identity/meta |
| Snippet revision history | **JSONL** (one event per line) | Append-only, crash-tolerant (torn last line is droppable), streamable |
| Agent-run transcripts | **JSONL** | Same properties; runs are event streams by nature |
| Section/work metadata, consolidation provenance | **JSON** (pretty-printed) | Structured, small, atomic-replace friendly |
| Images | **PNG** files next to their owner | No blob store; trivially viewable |
| Index | **SQLite** (WAL mode) | Derived cache only |

### 5.2 Directory layout (canonical)

```
<work-dir>/                          # e.g. ~/Cowrite/salt-and-signal/
  work.json                          # WorkMeta (schema ver, level scheme, settings)
  manuscript/                        # the frozen section tree; nesting mirrors levelScheme
    <NNN>-<slug>.<shortid>/          # one dir per section (leaf or interior)
      section.json                   # SectionMeta (id, kind, orderKey, enrichment state)
      content.md                     # leaf sections only: the consolidated prose
      summary-short.md               # enrichment (optional)
      summary-long.md                # enrichment (optional)
      illustration.png               # enrichment (optional, exactly one)
      history.jsonl                  # collapsed snippet provenance (§6.4)
      <child section dirs...>        # interior sections only
  frontier/
    snippets/
      <orderKey>.<shortid>.md        # one file per live snippet (frontmatter + current text)
    revisions/
      <snippetId>.jsonl              # full-text revision events for that snippet
  world/
    entries/<slug>.<shortid>.md      # frontmatter (id, keys, summary, image ref) + md body
    images/<entryId>.png
  runs/
    <YYYY-MM>/                       # month shard to keep dirs small
      <runId>.jsonl
  .cowrite/                          # app-private; safe to delete entirely
    index.sqlite                     # rebuildable index (§7)
    pending-ops.json                 # multi-file operation journal (§9.2), absent when idle
    lock                             # advisory single-writer lockfile (pid + timestamp)
```

Everything outside `.cowrite/` is user-facing and git-friendly. Deleting `.cowrite/` loses nothing
but cache and an idle-time lock.

### 5.3 Concrete example — a work with 2 chapters and a live frontier

```
salt-and-signal/
├── work.json
├── manuscript/
│   ├── 010-the-lighthouse-keeper.01hzqa/
│   │   ├── section.json
│   │   ├── content.md                      # 4,100 words, frozen 2026-07-01
│   │   ├── summary-short.md
│   │   ├── summary-long.md
│   │   ├── illustration.png
│   │   └── history.jsonl                   # 7 consolidated snippets' provenance
│   └── 020-the-storm-glass.01j2kf/
│       ├── section.json                    # summaries stale=true (user edited content.md
│       ├── content.md                      #   in VS Code yesterday; reconciler noticed)
│       ├── summary-short.md
│       ├── summary-long.md
│       ├── illustration.png
│       └── history.jsonl
├── frontier/
│   ├── snippets/
│   │   ├── a0.p2m9x1.md                    # agent-drafted, user-touched (mixed), rev 3
│   │   ├── a1.q8r2v7.md                    # user-typed, rev 1
│   │   └── a2.t5w0zn.md                    # agent-drafted 2 min ago, rev 1
│   └── revisions/
│       ├── 01J2P4...P2M9X1.jsonl           # 3 revision events
│       ├── 01J2P6...Q8R2V7.jsonl           # 1 revision event
│       └── 01J2P7...T5W0ZN.jsonl           # 1 revision event
├── world/
│   ├── entries/
│   │   ├── mara-voss.7f3akq.md             # keys: ["Mara", "Voss", "the keeper"]
│   │   └── the-storm-glass.9b1xte.md
│   └── images/
│       └── 01J2N8...7F3AKQ.png
├── runs/
│   └── 2026-07/
│       ├── 01J2P7Q4V2M8Z6T1RD5FCW9XKB.jsonl   # draft run → snippet a2
│       └── 01J2P5H8A3N1Y7S4QE2GBV6MKD.jsonl   # boundary run → froze ch. 2
└── .cowrite/
    ├── index.sqlite
    └── lock
```

### 5.4 Sample file contents

`frontier/snippets/a2.t5w0zn.md`:

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

`runs/2026-07/01J2P7Q4...jsonl` (abridged):

```jsonl
{"type":"meta","runId":"01J2P7Q4...","kind":"draft","model":"claude-sonnet-4-5","params":{"maxTokens":2048,"temperature":1.0},"startedAt":"2026-07-06T14:01:58Z"}
{"type":"message","role":"system","text":"You are co-writing a novel..."}
{"type":"message","role":"user","text":"<context: long summary ch1-2, world: Mara Voss, storm glass, last 2 snippets>\nContinue the scene..."}
{"type":"output","text":"Mara pressed her palm against the storm glass..."}
{"type":"result","status":"ok","usage":{"inputTokens":6412,"outputTokens":388},"artifacts":[{"kind":"snippet","snippetId":"01J2P7R9...","rev":1}],"endedAt":"2026-07-06T14:02:11Z"}
```

---

## 6. Frontier mechanics

### 6.1 Appending and ordering
New prose — whether the user types it or accepts an agent draft — becomes a new snippet file with
an `orderKey` generated after the current last key. Inserting between snippets (rare but allowed)
generates a key between neighbors. Each accepted edit bumps `rev`, rewrites the snippet `.md`
atomically, and appends a `RevisionEvent` to the snippet's JSONL. "Accepted edit" = editor
debounce boundary (default **2,000 ms** idle) or explicit agent write — we do not log keystrokes.

### 6.2 Consolidation ("freezing"): trigger

Consolidation runs when **all** of these hold, evaluated by a background task debounced
**30 s** after the last frontier write (and always on work close):

- frontier exceeds **maxFrontierSnippets = 18** OR **maxFrontierWords = 9,000**, and
- the eligible prefix excludes the **active window**: the trailing
  **activeWindowSnippets = 6** snippets or **activeWindowWords = 3,000** words, whichever keeps
  more — the frontier the user is actually working in is never frozen out from under them.

The user can also invoke "Consolidate now" manually. Defaults live in `work.json → settings` and
are tunable per work.

### 6.3 Who proposes boundaries

**Recommendation: heuristics gate, agent decides, auto-apply with undo-window.**

1. **Heuristic pre-pass (pure code):** honor explicit break markers in the eligible prefix —
   a `***` / `---` scene break line or a user "New chapter" command splits unconditionally.
2. **Boundary agent (background AgentRun, kind `boundary`):** receives the eligible prefix plus
   the short summaries of the last 2 frozen sections, returns
   `{ boundaries: [{afterSnippetId, title, kind}] , remainderStaysLive: true }` — i.e. it may
   propose 0..n section boundaries inside the prefix and must leave a coherent tail. If it
   proposes none (the prose genuinely doesn't break), consolidation defers and the thresholds
   grow by 50% for the next attempt (so we never freeze mid-scene just to hit a number).
3. **Apply mode:** `settings.consolidation.mode = "auto"` (default) applies immediately and shows
   a toast ("Chapter 3 'The Storm Glass' frozen — Undo"); `"review"` mode stores the proposal in
   the index and waits for user confirmation. **MVP ships auto only**; review mode is a flag away.

*Rejected:* pure-heuristic boundaries (word-count chapter chopping reads terribly);
user-only manual freezing (violates "automatic transition" and accretes an unbounded frontier).

### 6.4 What consolidation does to snippet history

The brief leans toward collapsing, and we collapse — **but keep provenance**:

- `content.md` gets the final text of each consolidated snippet, in order, joined by blank lines
  (scene-break markers preserved verbatim).
- `history.jsonl` in the section dir gets one line per consolidated snippet:

```jsonl
{"type":"consolidated","snippetId":"01J2...","orderKey":"a0","authorship":"mixed","originRunId":"01J2...","finalRev":3,"finalText":"...","revisionRunIds":["01J2...","01J2..."],"consolidatedAt":"2026-07-05T22:10:00Z","boundaryRunId":"01J2P5H8..."}
```

- **Intermediate revision texts are discarded** (the per-snippet `revisions/*.jsonl` files are
  deleted). Final text + every `runId` that touched the snippet survive, so the UI can still show
  "this paragraph came from run X" for frozen prose, and the full prompts live on in `runs/`.
- Because `history.jsonl` records snippet order and final texts, **un-freezing a section is
  mechanically possible** (recreate snippet files from history). Structured-for, deferred (§12).

The undo-window for the toast is trivially cheap: consolidation is journaled (§9.2), and undo
within the session replays the journal in reverse before the snippet files are purged (purge is
the journal's final step, executed after a **5-minute** undo grace or on work close).

### 6.5 Editing behind the frontier

Frozen sections are plain Markdown; editing them **merely works**, by design:

- **In-app edit:** the editor writes `content.md` atomically, updates `contentHash` in
  `section.json`, and flips staleness: `shortSummary.stale = longSummary.stale = true` on *any*
  change; `illustration.stale = true` only when the change is large (default: word count of the
  section changes by **>15%**, or the user explicitly requests re-illustration — regenerating art
  because someone fixed a comma would be noise). No snippet-level history is kept behind the
  frontier in MVP (plain files + "put it in git" is the versioning story there).
- **External edit (VS Code, etc.):** detected by the reconciler (§8); same staleness rules apply,
  computed by comparing the stored `contentHash` against the file.
- Stale enrichments are **not** auto-regenerated; the section renders with a subtle "summary out
  of date" badge, and the enrichment agent refreshes them lazily (next time the context engine
  needs that summary, or via a background sweep when the app is idle). This keeps external edits
  free of surprise API spend.
- Structural edits (splitting/merging frozen sections, reordering chapters) are app operations
  that rewrite the affected `section.json` orderKeys/dirs; enrichments of affected sections go
  stale. Moving a chapter never rewrites its neighbors' content.

Staleness is **derived, not stored as a boolean**: an enrichment is stale iff
`enrichment.sourceHash !== hash(content.md)`. That makes it immune to crash-ordering and external
edits — no flag to forget to set.

---

## 7. The rebuildable SQLite index

Lives at `.cowrite/index.sqlite`, WAL mode, one DB per work. It is a **cache**: any question it
answers must be answerable (slowly) from files alone.

### 7.1 Schema

```sql
PRAGMA user_version = 1;               -- index schema version; mismatch ⇒ rebuild

CREATE TABLE meta      (key TEXT PRIMARY KEY, value TEXT);   -- workId, levelScheme, lastScanAt

CREATE TABLE files (                    -- external-change detection (§8)
  path      TEXT PRIMARY KEY,          -- work-relative
  size      INTEGER NOT NULL,
  mtime_ms  INTEGER NOT NULL,
  xxh64     TEXT NOT NULL
);

CREATE TABLE sections (
  id         TEXT PRIMARY KEY,
  parent_id  TEXT REFERENCES sections(id),
  kind       TEXT NOT NULL,
  order_key  TEXT NOT NULL,
  title      TEXT,
  title_source TEXT NOT NULL DEFAULT 'agent',      -- 'user' | 'agent'
  dir_path   TEXT NOT NULL,
  word_count INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT,
  frozen_at  TEXT,
  short_summary_stale INTEGER NOT NULL DEFAULT 0,  -- derived at scan time
  long_summary_stale  INTEGER NOT NULL DEFAULT 0,
  illustration_stale  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ix_sections_tree ON sections(parent_id, order_key);

CREATE TABLE snippets (
  id          TEXT PRIMARY KEY,
  order_key   TEXT NOT NULL,
  authorship  TEXT NOT NULL,
  origin_run_id TEXT,
  rev         INTEGER NOT NULL,
  word_count  INTEGER NOT NULL,
  updated_at  TEXT NOT NULL,
  file_path   TEXT NOT NULL
);
CREATE INDEX ix_snippets_order ON snippets(order_key);

CREATE TABLE world_entries (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, short_summary TEXT,
  image_path TEXT, file_path TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE world_keys (               -- one row per trigger key, for the context engine
  entry_id TEXT NOT NULL REFERENCES world_entries(id),
  key TEXT NOT NULL COLLATE NOCASE,
  PRIMARY KEY (entry_id, key)
);
CREATE INDEX ix_world_keys ON world_keys(key);

CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, model TEXT,
  started_at TEXT NOT NULL, ended_at TEXT, status TEXT,
  input_tokens INTEGER, output_tokens INTEGER, file_path TEXT NOT NULL
);
CREATE TABLE run_artifacts (            -- run ⇄ artifact join: "what produced this version?"
  run_id TEXT NOT NULL REFERENCES agent_runs(id),
  artifact_kind TEXT NOT NULL,          -- snippet | section-summary | illustration | boundary | world
  artifact_id TEXT NOT NULL,            -- snippetId, sectionId, entryId
  rev INTEGER,                          -- for snippet revisions
  PRIMARY KEY (run_id, artifact_kind, artifact_id, rev)
);
CREATE INDEX ix_artifacts_by_target ON run_artifacts(artifact_kind, artifact_id);

-- Full-text search over prose + world (contentless FTS5, repopulated from files)
CREATE VIRTUAL TABLE fts USING fts5(kind, entity_id UNINDEXED, title, body);
```

### 7.2 Queries it serves

| Consumer | Query |
|---|---|
| UI: manuscript sidebar | section tree ordered by `(parent_id, order_key)` with word counts + staleness badges |
| UI: frontier pane | `snippets ORDER BY order_key` |
| UI: "how was this written?" | `run_artifacts WHERE artifact_kind='snippet' AND artifact_id=? ` → run file paths, per rev |
| Context engine | `world_keys WHERE key IN (…scanned tokens…)`; last-N snippets; short summaries of preceding sections; stale-summary list |
| Search (⌘K) | FTS5 across prose, titles, world bodies |
| Enrichment sweeper | sections where any `*_stale = 1` |
| Cost/usage panel | token sums over `agent_runs` |

### 7.3 Rebuild policy

- **Incremental (normal):** every app write updates files and index in the same call; the
  reconciler (§8) patches rows for externally-changed files.
- **Full rebuild** — delete DB, scan every file, reparse frontmatter/JSON, repopulate — happens
  when: `PRAGMA user_version` mismatches, SQLite reports corruption, `.cowrite/` is missing, the
  journal replay finds inconsistency, or the user runs "Rebuild index." Target: **< 2 s for a
  200k-word work** (a few hundred small files; trivially within budget for `better-sqlite3` in a
  single transaction). Rebuild is the universal repair: any storage bug's worst case is "rebuild
  and move on."

---

## 8. Tolerating external edits (reconciler)

Users *will* open these files in Obsidian/VS Code. The reconciler runs at: app start, window
focus, before any agent run (so context is never assembled from stale index rows), and every
**30 s** while the app is focused. (A live fs-watcher is deferred — polling on those triggers is
simpler and plenty snappy.)

```
reconcile():
  walk = list all tracked file paths (manuscript/**, frontier/**, world/**, work.json)
  for each path in walk ∪ files-table:
    if missing on disk        → mark entity deleted (sections: tombstone row + warn in UI)
    else if (size, mtime_ms) match files row → skip           # fast path, no read
    else:
      h = xxh64(file)
      if h == files.xxh64     → update mtime row only         # e.g. touch(1)
      else                    → reparse:
          - valid frontmatter with known id → update entity row, recompute staleness
          - valid frontmatter, unknown id   → adopt as new entity
          - no/broken frontmatter (.md in manuscript/ or world/entries/)
              → adopt: mint ULID, derive orderKey from filename sort position,
                write frontmatter back (atomically), index it
  renumber human filename prefixes if drifted (lazy, batched)
```

Rules of engagement: we **never delete or quarantine** a user's file; adoption is the failure
mode. Conflicts can't happen in the classic sense — files are the truth, so an external edit
simply wins and the index/staleness follow. The only guarded window: if the in-app editor has
unsaved changes to a file the reconciler sees changed on disk, the UI surfaces a
theirs/mine/merge choice (last-writer-wins with a visible prompt; no silent merge).

---

## 9. Atomicity & crash safety

### 9.1 Single files
Every JSON/Markdown write: write `name.md.tmp-<ulid>` in the same directory → `fsync` file →
`rename` over target → `fsync` directory (POSIX; on Windows, `FlushFileBuffers` + `ReplaceFile`).
JSONL appends: single `write()` of the whole line ending in `\n`; readers drop a torn final line
(and the reconciler re-derives anything lost from the primary files).

### 9.2 Multi-file operations (consolidation, section split/merge/move)
Journaled two-phase apply via `.cowrite/pending-ops.json`:

```
1. Write journal: { opId, type:"consolidate", boundaries, snippetIds, targetDirs, phase:"planned" }   (atomic)
2. Create section dir(s) + section.json + content.md + history.jsonl                                   (idempotent: keyed by opId)
3. Update journal phase:"applied"                                                                       (atomic)
4. After undo grace (5 min) or work close: delete consumed frontier snippet+revision files
5. Delete journal
```

Recovery on startup: journal at `planned` → roll forward from step 2 (all steps keyed by `opId`,
so re-running is safe); at `applied` → finish 4–5. If both section content **and** snippet files
exist (crash inside step 4), section wins and duplicates in `frontier/` matching journal
`snippetIds` are removed. Undo = inverse replay while phase ≤ `applied`.

### 9.3 Single-writer lock
`.cowrite/lock` holds `{pid, hostname, acquiredAt}`, refreshed every 30 s; a second instance
opening the same work sees a fresh lock and opens read-only with a banner. Stale lock (> 2 min
old) is broken automatically.

---

## 10. TypeScript / Zod type sketches

```ts
import { z } from "zod";

export const Ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
export const OrderKey = z.string().min(1);            // fractional index, base-62
export const IsoTime = z.string().datetime();
export const Hash = z.string().regex(/^xxh64:[0-9a-f]{16}$/);

// ---------- work.json ----------
export const ConsolidationSettings = z.object({
  activeWindowSnippets: z.number().int().positive().default(6),
  activeWindowWords:    z.number().int().positive().default(3000),
  maxFrontierSnippets:  z.number().int().positive().default(18),
  maxFrontierWords:     z.number().int().positive().default(9000),
  debounceMs:           z.number().int().positive().default(30_000),
  undoGraceMs:          z.number().int().positive().default(300_000),
  mode: z.enum(["auto", "review"]).default("auto"),
});

export const WorkMeta = z.object({
  schemaVersion: z.literal(1),
  id: Ulid,
  title: z.string().min(1),
  levelScheme: z.array(z.string().min(1)).min(1).default(["chapter"]), // backend-owned
  createdAt: IsoTime,
  settings: z.object({
    consolidation: ConsolidationSettings.default({}),
    illustrationStaleWordDeltaPct: z.number().default(15),
  }).default({}),
});

// ---------- section.json ----------
export const EnrichmentMeta = z.object({
  runId: Ulid,
  generatedAt: IsoTime,
  sourceHash: Hash,          // hash of content.md it was generated from ⇒ staleness is derived
});

export const SectionMeta = z.object({
  schemaVersion: z.literal(1),
  id: Ulid,
  kind: z.string(),                       // must ∈ work.levelScheme (validated at load)
  orderKey: OrderKey,
  title: z.string().nullable(),
  titleSource: z.enum(["user", "agent"]).default("agent"),
  frozenAt: IsoTime.nullable(),
  contentHash: Hash.nullable(),           // null for interior (non-leaf) sections
  enrichments: z.object({
    shortSummary:  EnrichmentMeta.nullable(),
    longSummary:   EnrichmentMeta.nullable(),
    illustration:  EnrichmentMeta.extend({ prompt: z.string() }).nullable(),
  }),
});

// ---------- snippet frontmatter ----------
export const SnippetMeta = z.object({
  id: Ulid,
  orderKey: OrderKey,
  createdAt: IsoTime,
  updatedAt: IsoTime,
  authorship: z.enum(["user", "agent", "mixed"]),
  originRunId: Ulid.nullable(),
  rev: z.number().int().positive(),
});

// ---------- frontier/revisions/<id>.jsonl ----------
export const RevisionEvent = z.object({
  type: z.literal("revision"),
  rev: z.number().int().positive(),
  ts: IsoTime,
  author: z.enum(["user", "agent"]),
  runId: Ulid.optional(),                 // present iff author === "agent"
  text: z.string(),                       // FULL text; snippets are small, diffs rejected
});

// ---------- manuscript/**/history.jsonl ----------
export const ConsolidatedSnippet = z.object({
  type: z.literal("consolidated"),
  snippetId: Ulid,
  orderKey: OrderKey,
  authorship: z.enum(["user", "agent", "mixed"]),
  originRunId: Ulid.nullable(),
  finalRev: z.number().int().positive(),
  finalText: z.string(),
  revisionRunIds: z.array(Ulid),          // every agent run that ever touched it
  consolidatedAt: IsoTime,
  boundaryRunId: Ulid.nullable(),         // null when a pure-heuristic break decided it
});

// ---------- world entry frontmatter ----------
export const WorldEntryMeta = z.object({
  id: Ulid,
  name: z.string().min(1),
  keys: z.array(z.string().min(1)).min(1),
  image: z.string().nullable(),           // work-relative path
  shortSummary: z.string().nullable(),
  createdBy: z.enum(["user", "agent"]),
  updatedAt: IsoTime,
});

// ---------- runs/**/<runId>.jsonl ----------
export const RunKind = z.enum(["draft","revise","summarize","boundary","illustrate","world-extract"]);
export const RunEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("meta"), runId: Ulid, kind: RunKind, model: z.string(),
             params: z.record(z.string(), z.unknown()), startedAt: IsoTime }),
  z.object({ type: z.literal("message"), role: z.enum(["system","user","assistant"]), text: z.string() }),
  z.object({ type: z.literal("toolCall"), name: z.string(), input: z.unknown(), output: z.unknown() }),
  z.object({ type: z.literal("output"), text: z.string() }),
  z.object({ type: z.literal("result"), status: z.enum(["ok","error","cancelled"]),
             error: z.string().optional(),
             usage: z.object({ inputTokens: z.number().int(), outputTokens: z.number().int() }).optional(),
             artifacts: z.array(z.object({
               kind: z.enum(["snippet","section-summary","illustration","boundary","world"]),
               snippetId: Ulid.optional(), sectionId: Ulid.optional(), entryId: Ulid.optional(),
               rev: z.number().int().optional() })),
             endedAt: IsoTime }),
]);

// ---------- boundary agent contract ----------
export const BoundaryProposal = z.object({
  boundaries: z.array(z.object({
    afterSnippetId: Ulid,
    kind: z.string(),                     // ∈ levelScheme
    title: z.string(),
  })),
});
```

---

## 11. Failure modes & testing

| Failure | Behavior |
|---|---|
| Crash mid single-file write | tmp file orphaned (swept at startup), target intact |
| Crash mid consolidation | journal replay rolls forward or back deterministically (property-tested: kill at every step) |
| Torn JSONL tail | last line dropped; snippet `.md` (primary) unaffected; index rebuilt if needed |
| SQLite corruption / deleted `.cowrite/` | full rebuild < 2 s; zero user data lost |
| External edit / rename / new file | reconciler adopts; staleness derived from hashes |
| Two app instances | lockfile → second instance read-only |
| Boundary agent returns garbage | Zod-validated; invalid ⇒ consolidation deferred, thresholds grow 50%, error logged to run file |
| Clock skew | ordering never depends on timestamps (orderKeys + ULID tiebreak) |

**Test strategy:** the storage layer is a pure library (`packages/storage`) with zero UI deps —
unit-test entity round-trips against Zod schemas; property-test fractional-index insertion and
journal crash-recovery (inject kill-points); golden-directory tests (fixture work dir in, expected
index rows out); fuzz the reconciler with random external mutations (rename/edit/delete/add) and
assert invariants: no user file ever deleted, index == fresh rebuild after reconcile.

---

## 12. MVP cut

**Ships first:**
- Flat `["chapter"]` level scheme (schema + tree code fully general)
- Snippet append/edit/revision log; auto consolidation (heuristics + boundary agent, auto mode
  with undo toast); collapse-with-provenance (`history.jsonl`)
- Full on-disk layout, atomic writes, op journal, lockfile
- Reconciler (start/focus/pre-run/30 s poll) + full index rebuild
- SQLite index incl. FTS5, world key table, run artifacts
- Derived staleness + lazy enrichment refresh

**Structured-for, deferred:**
- Un-freeze / re-open a frozen section back into snippets (format supports it via `history.jsonl`)
- `review` consolidation mode UI; multi-level schemes (`part/chapter/scene`) enabled per work
- Edit history behind the frontier (recommend "use git" in MVP; per-section edit log later)
- Live fs-watcher (chokidar) replacing polling; run-file gzip archival; image GC for orphaned
  illustrations; cross-work library index

---

## 13. Interface assumptions

To be cross-checked against the brief and sibling subsystem designs:

1. **Baseline stack (assumed — brief unavailable, see provenance note):** TypeScript throughout;
   a local Node.js runtime owns storage (Electron main process or a local server behind the UI);
   `better-sqlite3` (synchronous, WAL) for the index; `zod` for schema validation;
   `fractional-indexing` for order keys; `js-yaml` + `gray-matter`-style frontmatter parsing;
   xxhash for content hashes. If the fixed stack differs (e.g. Tauri/Rust core), the *formats* in
   this doc stand and only the library choices move.
2. **Storage is a library, not a service:** sibling subsystems call an in-process
   `StorageService` API (openWork, listSections, appendSnippet, reviseSnippet, consolidate,
   upsertWorldEntry, recordRun, query*) — no HTTP surface of its own; the app's endpoint layer
   wraps it.
3. **Context engine** consumes: `world_keys` index scans, last-N frontier snippets, section
   short/long summaries (reading the `.md` enrichment files), and staleness queries. It never
   writes files; it requests enrichment regeneration via the agent orchestrator.
4. **Agent orchestrator** owns prompt assembly and model calls; it streams `RunEvent`s to storage
   (`recordRun`) and commits artifacts through storage APIs (never writes work files directly).
   The boundary agent honors the `BoundaryProposal` contract in §10.
5. **Illustration pipeline** hands storage a finished PNG + prompt + runId; storage places it at
   `<section>/illustration.png` (exactly one per section — replacement overwrites atomically).
6. **UI** shows staleness badges, the consolidation undo toast, the read-only second-instance
   banner, and the external-edit theirs/mine prompt; it treats the SQLite index as its read model
   (queries in §7.2).
7. **Single user, single machine, no sync** in scope; the layout is deliberately friendly to
   git/Dropbox operated *by the user*, but conflict resolution beyond the reconciler is out of
   scope for this subsystem.
