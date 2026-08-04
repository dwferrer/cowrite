import fs from 'node:fs'
import path from 'node:path'
import type { Lane, RunArtifact, RunSummary, TaskKind } from '@cowrite/shared'
import Database from 'better-sqlite3'

/**
 * The rebuildable SQLite index (spec 02 §7): `.cowrite/index.sqlite`, WAL mode, one DB
 * per work. It is a cache — every question it answers must be answerable (slowly) from
 * the files alone. This module owns opening/closing, the DDL (§7.1 verbatim), the
 * rebuild-needed check (§7.3), and a thin typed query API for §7.2's consumers.
 */

// v3: agent_runs.usage_estimated (05 §9 usage honesty) — bumping forces the rebuild
// that backfills it from run files (the index is a cache; a rebuild is always safe).
export const INDEX_SCHEMA_VERSION = 3

// DDL exactly per spec 02 §7.1 (user_version is set by openIndex in the same transaction).
const DDL = `
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
  illustration_hash   TEXT,             -- xxh64 of the PNG bytes => SectionRow.illustrationVersion
  illustration_width  INTEGER,          -- pixel dims, read from the PNG header at index time
  illustration_height INTEGER,
  short_summary TEXT,                   -- summary-*.md text, inlined so GET /sections and the
  long_summary  TEXT                    -- SSE hydrator answer with zero per-row file reads (v2)
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
  usage_estimated INTEGER,              -- 1 when any usage component was a chars/4 estimate
  file_path TEXT NOT NULL
);
CREATE TABLE run_artifacts (            -- run <-> artifact join: "what produced this version?"
  run_id TEXT NOT NULL REFERENCES agent_runs(id),
  artifact_kind TEXT NOT NULL,          -- 9-kind RunArtifact enum (05)
  artifact_id TEXT NOT NULL,            -- snippetId, sectionId, or entryId
  rev INTEGER,                          -- for snippet revisions
  state TEXT NOT NULL DEFAULT 'committed',  -- committed | conflict | skipped
  PRIMARY KEY (run_id, artifact_kind, artifact_id, rev)
);
CREATE INDEX ix_artifacts_by_target ON run_artifacts(artifact_kind, artifact_id);

-- Full-text search over prose + world. Plain (contentful) FTS5: it stores a copy of the
-- text, which keeps incremental updates and deletes trivial (§7.1).
CREATE VIRTUAL TABLE fts USING fts5(kind, entity_id UNINDEXED, title, body);
`

// ---------------------------------------------------------------------------
// Row types (camelCase mirrors of the §7.1 columns)
// ---------------------------------------------------------------------------

export interface FileRow {
  path: string
  size: number
  mtimeMs: number
  xxh64: string
}

export interface SectionRow {
  id: string
  parentId: string | null
  kind: string
  orderKey: string
  title: string | null
  titleSource: 'user' | 'agent'
  dirPath: string
  wordCount: number
  contentHash: string | null
  frozenAt: string | null
  shortSummaryStale: boolean
  longSummaryStale: boolean
  illustrationStale: boolean
  illustrationHash: string | null
  illustrationWidth: number | null
  illustrationHeight: number | null
  /** summary-short.md text (null = no file) — inlined per v2 so reads skip the files. */
  shortSummary: string | null
  /** summary-long.md text (null = no file). */
  longSummary: string | null
}

export interface SnippetRow {
  id: string
  orderKey: string
  authorship: 'user' | 'agent' | 'mixed'
  originRunId: string | null
  rev: number
  revisionCount: number
  wordCount: number
  updatedAt: string
  filePath: string
}

export interface WorldEntryRow {
  id: string
  name: string
  shortSummary: string | null
  imagePath: string | null
  filePath: string
  updatedAt: string
}

export interface WorldKeyMatch {
  entryId: string
  key: string
}

export interface AgentRunRow {
  id: string
  kind: TaskKind
  lane: Lane
  model: string | null
  startedAt: string
  endedAt: string | null
  /** null while the run has no `result` line yet (in flight or crashed, §10.7). */
  status: 'ok' | 'error' | 'cancelled' | null
  promptTokens: number | null
  completionTokens: number | null
  /** 1 when any usage component was a chars/4 estimate (05 §9); null pre-result. */
  usageEstimated: number | null
  filePath: string
}

export interface RunArtifactRow {
  runId: string
  artifactKind: RunArtifact['kind']
  artifactId: string
  rev: number | null
  state: 'committed' | 'conflict' | 'skipped'
}

/**
 * One provenance hit: the SHARED RunSummary shape (03's list endpoints) plus the
 * artifact-join columns. Artifact rows only exist once a `result` line landed (§10.7),
 * so status/usageTotal are always present here.
 */
export type RunByArtifact = RunSummary & {
  rev: number | null
  artifactState: RunArtifactRow['state']
}

export type FtsKind = 'section' | 'snippet' | 'world'

export interface FtsHit {
  kind: FtsKind
  entityId: string
  title: string | null
  /** A short highlight-free excerpt of the matched body. */
  snippet: string
}

export interface LaneUsageRow {
  lane: Lane
  kind: TaskKind
  runs: number
  promptTokens: number
  completionTokens: number
}

// ---------------------------------------------------------------------------
// Raw (SQL-shaped) row helpers
// ---------------------------------------------------------------------------

type SectionSqlRow = Omit<
  SectionRow,
  'shortSummaryStale' | 'longSummaryStale' | 'illustrationStale'
> & {
  shortSummaryStale: number
  longSummaryStale: number
  illustrationStale: number
}

function mapSection(raw: SectionSqlRow): SectionRow {
  return {
    ...raw,
    shortSummaryStale: raw.shortSummaryStale === 1,
    longSummaryStale: raw.longSummaryStale === 1,
    illustrationStale: raw.illustrationStale === 1,
  }
}

const SECTION_SELECT = `SELECT id, parent_id AS parentId, kind, order_key AS orderKey, title,
  title_source AS titleSource, dir_path AS dirPath, word_count AS wordCount,
  content_hash AS contentHash, frozen_at AS frozenAt,
  short_summary_stale AS shortSummaryStale, long_summary_stale AS longSummaryStale,
  illustration_stale AS illustrationStale, illustration_hash AS illustrationHash,
  illustration_width AS illustrationWidth, illustration_height AS illustrationHeight,
  short_summary AS shortSummary, long_summary AS longSummary
FROM sections`

const SNIPPET_SELECT = `SELECT id, order_key AS orderKey, authorship, origin_run_id AS originRunId,
  rev, revision_count AS revisionCount, word_count AS wordCount, updated_at AS updatedAt,
  file_path AS filePath
FROM snippets`

const WORLD_SELECT = `SELECT id, name, short_summary AS shortSummary, image_path AS imagePath,
  file_path AS filePath, updated_at AS updatedAt
FROM world_entries`

const RUN_SELECT = `SELECT id, kind, lane, model, started_at AS startedAt, ended_at AS endedAt,
  status, prompt_tokens AS promptTokens, completion_tokens AS completionTokens,
  usage_estimated AS usageEstimated, file_path AS filePath
FROM agent_runs`

/** The ONE encoding of the works-list/WorkDetail aggregates (03 §3.1): counts, total
 *  words (frontier snippets + section prose), and max(updated_at) across snippets ∪
 *  world entries (null on an empty work). Shared by `IndexDb.workCounts` (open handle)
 *  and `readWorkCounts` (read-only, no lock) so the two can never drift. */
const WORK_COUNTS_SQL = `SELECT
  (SELECT COUNT(*) FROM snippets) AS snippetCount,
  (SELECT COUNT(*) FROM sections) AS sectionCount,
  (SELECT COALESCE(SUM(word_count), 0) FROM snippets)
    + (SELECT COALESCE(SUM(word_count), 0) FROM sections) AS wordCount,
  (SELECT MAX(u) FROM (
     SELECT MAX(updated_at) AS u FROM snippets
     UNION ALL SELECT MAX(updated_at) FROM world_entries)) AS updatedAt`

/** Quote each whitespace-separated token as an FTS5 phrase, restricted to title+body. */
function toFtsMatch(query: string): string | null {
  const tokens = query.split(/\s+/).filter((t) => t !== '')
  if (tokens.length === 0) return null
  const quoted = tokens.map((t) => `"${t.replaceAll('"', '""')}"`).join(' ')
  return `{title body} : (${quoted})`
}

// ---------------------------------------------------------------------------
// IndexDb — the thin typed query API of §7.2
// ---------------------------------------------------------------------------

export class IndexDb {
  private readonly db: Database.Database
  private readonly stmts = new Map<string, Database.Statement<unknown[]>>()

  constructor(db: Database.Database) {
    this.db = db
  }

  /** The raw better-sqlite3 handle (tests, one-off queries). */
  get handle(): Database.Database {
    return this.db
  }

  private prepare(sql: string): Database.Statement<unknown[]> {
    const cached = this.stmts.get(sql)
    if (cached) return cached
    const stmt = this.db.prepare(sql)
    this.stmts.set(sql, stmt)
    return stmt
  }

  /** Run `fn` inside a transaction (nested calls become savepoints). */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)()
  }

  close(): void {
    this.db.close()
  }

  /** Empty every table (the delete-all step of a full rebuild, §7.3). */
  deleteAll(): void {
    this.db.exec(
      `DELETE FROM meta; DELETE FROM files; DELETE FROM sections; DELETE FROM snippets;
       DELETE FROM world_keys; DELETE FROM world_entries; DELETE FROM run_artifacts;
       DELETE FROM agent_runs; DELETE FROM fts;`,
    )
  }

  // -- meta -----------------------------------------------------------------

  getMeta(key: string): string | null {
    const row = this.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string | null }
      | undefined
    return row?.value ?? null
  }

  setMeta(key: string, value: string): void {
    this.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value)
  }

  // -- files ----------------------------------------------------------------

  upsertFile(row: FileRow): void {
    this.prepare(
      'INSERT OR REPLACE INTO files (path, size, mtime_ms, xxh64) VALUES (?, ?, ?, ?)',
    ).run(row.path, row.size, row.mtimeMs, row.xxh64)
  }

  getFile(relPath: string): FileRow | null {
    const row = this.prepare(
      'SELECT path, size, mtime_ms AS mtimeMs, xxh64 FROM files WHERE path = ?',
    ).get(relPath) as FileRow | undefined
    return row ?? null
  }

  deleteFile(relPath: string): void {
    this.prepare('DELETE FROM files WHERE path = ?').run(relPath)
  }

  listFileRows(): FileRow[] {
    return this.prepare(
      'SELECT path, size, mtime_ms AS mtimeMs, xxh64 FROM files ORDER BY path',
    ).all() as FileRow[]
  }

  // -- sections ---------------------------------------------------------------

  upsertSection(row: SectionRow): void {
    this.prepare(
      `INSERT OR REPLACE INTO sections (id, parent_id, kind, order_key, title, title_source,
        dir_path, word_count, content_hash, frozen_at, short_summary_stale, long_summary_stale,
        illustration_stale, illustration_hash, illustration_width, illustration_height,
        short_summary, long_summary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      row.parentId,
      row.kind,
      row.orderKey,
      row.title,
      row.titleSource,
      row.dirPath,
      row.wordCount,
      row.contentHash,
      row.frozenAt,
      row.shortSummaryStale ? 1 : 0,
      row.longSummaryStale ? 1 : 0,
      row.illustrationStale ? 1 : 0,
      row.illustrationHash,
      row.illustrationWidth,
      row.illustrationHeight,
      row.shortSummary,
      row.longSummary,
    )
  }

  getSection(id: string): SectionRow | null {
    const raw = this.prepare(`${SECTION_SELECT} WHERE id = ?`).get(id) as SectionSqlRow | undefined
    return raw ? mapSection(raw) : null
  }

  /** The section whose row claims `dirPath` (work-relative) — the reconciler's §8
   *  unchanged-dir fast path resolves ids without reading section.json. */
  getSectionByDirPath(dirPath: string): SectionRow | null {
    const raw = this.prepare(`${SECTION_SELECT} WHERE dir_path = ? ORDER BY id LIMIT 1`).get(
      dirPath,
    ) as SectionSqlRow | undefined
    return raw ? mapSection(raw) : null
  }

  deleteSection(id: string): void {
    this.prepare('DELETE FROM sections WHERE id = ?').run(id)
  }

  /** Tree order: (parent_id, order_key), ULID tie-break (§4, §7.2). */
  listSectionRows(): SectionRow[] {
    const raw = this.prepare(
      `${SECTION_SELECT} ORDER BY parent_id, order_key, id`,
    ).all() as SectionSqlRow[]
    return raw.map(mapSection)
  }

  /**
   * Sections with stale enrichment — the enrichment sweep's queue (§7.2). This is THE
   * §6.5 staleness spelling for consumers: scope `'summary'` restricts to leaf sections
   * (interior rows carry no summaries) with a stale/missing summary — the Stage-4 sweep;
   * `'any'` (default) also includes illustration staleness (the Stage-5 sweep).
   */
  staleSections(scope: 'summary' | 'any' = 'any'): SectionRow[] {
    const where =
      scope === 'summary'
        ? `content_hash IS NOT NULL AND (short_summary_stale = 1 OR long_summary_stale = 1)`
        : `short_summary_stale = 1 OR long_summary_stale = 1 OR illustration_stale = 1`
    const raw = this.prepare(
      `${SECTION_SELECT} WHERE ${where} ORDER BY parent_id, order_key, id`,
    ).all() as SectionSqlRow[]
    return raw.map(mapSection)
  }

  // -- snippets ---------------------------------------------------------------

  upsertSnippet(row: SnippetRow): void {
    this.prepare(
      `INSERT OR REPLACE INTO snippets (id, order_key, authorship, origin_run_id, rev,
        revision_count, word_count, updated_at, file_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      row.orderKey,
      row.authorship,
      row.originRunId,
      row.rev,
      row.revisionCount,
      row.wordCount,
      row.updatedAt,
      row.filePath,
    )
  }

  getSnippet(id: string): SnippetRow | null {
    const row = this.prepare(`${SNIPPET_SELECT} WHERE id = ?`).get(id) as SnippetRow | undefined
    return row ?? null
  }

  deleteSnippet(id: string): void {
    this.prepare('DELETE FROM snippets WHERE id = ?').run(id)
  }

  /** Frontier order: order_key, ULID tie-break (§4, §7.2). */
  listSnippetRows(): SnippetRow[] {
    return this.prepare(`${SNIPPET_SELECT} ORDER BY order_key, id`).all() as SnippetRow[]
  }

  // -- world ------------------------------------------------------------------

  /** Upsert an entry and replace its alias rows atomically. */
  upsertWorldEntry(row: WorldEntryRow, keys: string[]): void {
    this.transaction(() => {
      this.prepare(
        `INSERT OR REPLACE INTO world_entries (id, name, short_summary, image_path, file_path,
          updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(row.id, row.name, row.shortSummary, row.imagePath, row.filePath, row.updatedAt)
      this.prepare('DELETE FROM world_keys WHERE entry_id = ?').run(row.id)
      for (const key of keys) {
        // OR IGNORE: keys differing only by case collide on the NOCASE PK; first wins.
        this.prepare('INSERT OR IGNORE INTO world_keys (entry_id, key) VALUES (?, ?)').run(
          row.id,
          key,
        )
      }
    })
  }

  getWorldEntry(id: string): WorldEntryRow | null {
    const row = this.prepare(`${WORLD_SELECT} WHERE id = ?`).get(id) as WorldEntryRow | undefined
    return row ?? null
  }

  deleteWorldEntry(id: string): void {
    this.transaction(() => {
      this.prepare('DELETE FROM world_keys WHERE entry_id = ?').run(id)
      this.prepare('DELETE FROM world_entries WHERE id = ?').run(id)
    })
  }

  listWorldEntryRows(): WorldEntryRow[] {
    return this.prepare(`${WORLD_SELECT} ORDER BY name, id`).all() as WorldEntryRow[]
  }

  worldKeys(entryId: string): string[] {
    const rows = this.prepare('SELECT key FROM world_keys WHERE entry_id = ? ORDER BY key').all(
      entryId,
    ) as Array<{ key: string }>
    return rows.map((r) => r.key)
  }

  /** Case-insensitive alias lookup — `matchWorldEntries`' index half (§2.6, 08). */
  matchWorldKeys(keys: string[]): WorldKeyMatch[] {
    if (keys.length === 0) return []
    const placeholders = keys.map(() => '?').join(', ')
    return this.prepare(
      `SELECT DISTINCT entry_id AS entryId, key FROM world_keys
       WHERE key IN (${placeholders}) ORDER BY entryId, key`,
    ).all(...keys) as WorldKeyMatch[]
  }

  // -- runs ---------------------------------------------------------------------

  /** Upsert a run and replace its artifact rows atomically (`meta` + `result` lines, §10.7). */
  upsertRun(run: AgentRunRow, artifacts: readonly RunArtifactRow[]): void {
    this.transaction(() => {
      this.prepare(
        `INSERT OR REPLACE INTO agent_runs (id, kind, lane, model, started_at, ended_at, status,
          prompt_tokens, completion_tokens, usage_estimated, file_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        run.id,
        run.kind,
        run.lane,
        run.model,
        run.startedAt,
        run.endedAt,
        run.status,
        run.promptTokens,
        run.completionTokens,
        run.usageEstimated,
        run.filePath,
      )
      this.prepare('DELETE FROM run_artifacts WHERE run_id = ?').run(run.id)
      for (const a of artifacts) {
        this.prepare(
          `INSERT OR REPLACE INTO run_artifacts (run_id, artifact_kind, artifact_id, rev, state)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(a.runId, a.artifactKind, a.artifactId, a.rev, a.state)
      }
    })
  }

  deleteRun(id: string): void {
    this.transaction(() => {
      this.prepare('DELETE FROM run_artifacts WHERE run_id = ?').run(id)
      this.prepare('DELETE FROM agent_runs WHERE id = ?').run(id)
    })
  }

  listRunRows(): AgentRunRow[] {
    return this.prepare(`${RUN_SELECT} ORDER BY started_at, id`).all() as AgentRunRow[]
  }

  /** Provenance: "which runs produced this artifact?" (§7.2). */
  runsByArtifact(kind: RunArtifact['kind'], artifactId: string): RunByArtifact[] {
    const raw = this.prepare(
      `SELECT r.id AS runId, r.kind, r.lane, r.model, r.status,
         r.started_at AS startedAt, r.ended_at AS endedAt,
         r.prompt_tokens AS promptTokens, r.completion_tokens AS completionTokens,
         r.usage_estimated AS usageEstimated,
         a.rev, a.state AS artifactState
       FROM run_artifacts a JOIN agent_runs r ON r.id = a.run_id
       WHERE a.artifact_kind = ? AND a.artifact_id = ?
       ORDER BY r.started_at, r.id, a.rev`,
    ).all(kind, artifactId) as Array<
      Omit<RunByArtifact, 'usageTotal'> & {
        promptTokens: number | null
        completionTokens: number | null
        usageEstimated: number | null
      }
    >
    return raw.map(({ promptTokens, completionTokens, usageEstimated, ...rest }) => ({
      ...rest,
      usageTotal: {
        promptTokens: promptTokens ?? 0,
        completionTokens: completionTokens ?? 0,
        estimated: usageEstimated === 1,
      },
    }))
  }

  /** The works-list/WorkDetail aggregates off this open index (one shared encoding). */
  workCounts(): WorkCounts {
    return this.prepare(WORK_COUNTS_SQL).get() as WorkCounts
  }

  /** Token sums grouped by lane and kind — the usage panel's query (§7.2). */
  usageByLane(): LaneUsageRow[] {
    return this.prepare(
      `SELECT lane, kind, COUNT(*) AS runs,
         COALESCE(SUM(prompt_tokens), 0) AS promptTokens,
         COALESCE(SUM(completion_tokens), 0) AS completionTokens
       FROM agent_runs GROUP BY lane, kind ORDER BY lane, kind`,
    ).all() as LaneUsageRow[]
  }

  // -- full-text search -----------------------------------------------------------

  /** Replace the FTS row(s) for an entity. */
  setFts(kind: FtsKind, entityId: string, title: string | null, body: string): void {
    this.transaction(() => {
      this.prepare('DELETE FROM fts WHERE kind = ? AND entity_id = ?').run(kind, entityId)
      this.prepare('INSERT INTO fts (kind, entity_id, title, body) VALUES (?, ?, ?, ?)').run(
        kind,
        entityId,
        title ?? '',
        body,
      )
    })
  }

  deleteFts(kind: FtsKind, entityId: string): void {
    this.prepare('DELETE FROM fts WHERE kind = ? AND entity_id = ?').run(kind, entityId)
  }

  /** ⌘K search across prose, titles, world bodies (§7.2). */
  ftsSearch(query: string, limit = 20): FtsHit[] {
    const match = toFtsMatch(query)
    if (match === null) return []
    return this.prepare(
      `SELECT kind, entity_id AS entityId, title, snippet(fts, 3, '', '', '…', 12) AS snippet
       FROM fts WHERE fts MATCH ? ORDER BY rank LIMIT ?`,
    ).all(match, limit) as FtsHit[]
  }
}

// ---------------------------------------------------------------------------
// Open / close / needsRebuild
// ---------------------------------------------------------------------------

/**
 * Open (creating if absent) the index at `indexPath` in WAL mode. A fresh database gets
 * the §7.1 DDL and `PRAGMA user_version = INDEX_SCHEMA_VERSION` in one transaction (the
 * mismatch on an old file is what routes it through the §7.3 full rebuild). An existing
 * database
 * with a different user_version throws — callers must check `needsRebuild` first and
 * delete the file before reopening (§7.3).
 */
export function openIndex(indexPath: string): IndexDb {
  fs.mkdirSync(path.dirname(indexPath), { recursive: true })
  const db = new Database(indexPath)
  try {
    db.pragma('journal_mode = WAL')
    const version = db.pragma('user_version', { simple: true }) as number
    if (version === 0) {
      db.transaction(() => {
        db.exec(DDL)
        db.pragma(`user_version = ${INDEX_SCHEMA_VERSION}`)
      })()
    } else if (version !== INDEX_SCHEMA_VERSION) {
      throw new Error(
        `index schema version ${version} != ${INDEX_SCHEMA_VERSION}; ` +
          'delete the index file and rebuild (spec 02 §7.3)',
      )
    }
    return new IndexDb(db)
  } catch (err) {
    db.close()
    throw err
  }
}

/** Cheap works-list aggregates for one work, read straight off its index (03 §3.1). */
export interface WorkCounts {
  snippetCount: number
  sectionCount: number
  /** Total words: frontier snippets + section prose (the index word_count columns). */
  wordCount: number
  /** max(updated_at) across snippets and world entries; null when the work is empty. */
  updatedAt: string | null
}

/**
 * Read the works-list counts from an existing `.cowrite/index.sqlite` via a READ-ONLY
 * connection — no work lock, no reconcile, no writes (this feeds the works-list screen,
 * which must stay fast and must never contend with a live writer). Returns null when the
 * index is missing, on a different schema version, or unreadable — callers surface null
 * counts rather than opening the work.
 */
export function readWorkCounts(indexPath: string): WorkCounts | null {
  if (!fs.existsSync(indexPath)) return null
  let db: Database.Database | null = null
  try {
    db = new Database(indexPath, { readonly: true, fileMustExist: true })
    const version = db.pragma('user_version', { simple: true }) as number
    if (version !== INDEX_SCHEMA_VERSION) return null
    return db.prepare(WORK_COUNTS_SQL).get() as WorkCounts
  } catch {
    return null // corrupt/locked-out index: the works list shows the work without counts
  } finally {
    db?.close()
  }
}

/**
 * True when the index must be rebuilt from files (§7.3): missing file, `user_version`
 * mismatch, or corruption. Corruption is probed with `PRAGMA quick_check` — the quick
 * path of integrity_check (skips index-content verification, catches malformed pages).
 */
export function needsRebuild(indexPath: string): boolean {
  if (!fs.existsSync(indexPath)) return true
  let db: Database.Database | null = null
  try {
    db = new Database(indexPath, { fileMustExist: true })
    const version = db.pragma('user_version', { simple: true }) as number
    if (version !== INDEX_SCHEMA_VERSION) return true
    const check = db.pragma('quick_check(1)', { simple: true }) as string
    return check !== 'ok'
  } catch {
    return true
  } finally {
    db?.close()
  }
}
