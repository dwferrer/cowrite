import fsp from 'node:fs/promises'
import path from 'node:path'
import {
  RunEvent,
  type SectionMeta,
  SnippetMeta,
  WorkMeta,
  WorkSettings,
  WorldEntryMeta,
} from '@cowrite/shared'
import { parseFrontmatter } from '../lib/frontmatter.js'
import { readBufferIfExists, readIfExists, readJsonlBoundaryLines } from '../lib/fsx.js'
import { wordCount, xxh64OfBuffer, xxh64OfString } from '../lib/hash.js'
import {
  revisionLogPath,
  revisionLogRelPath,
  sectionsDir,
  situationPath,
  workMetaPath,
} from '../lib/paths.js'
import { readPngDimensions } from '../lib/png.js'
import { parseSectionMeta, tryReadSectionMeta } from '../sectionStore.js'
import type {
  AgentRunRow,
  FileRow,
  IndexDb,
  RunArtifactRow,
  SectionRow,
  SnippetRow,
  WorldEntryRow,
} from './db.js'

/**
 * Incremental index ingestion (spec 02 §7.3 "incremental"): the per-entity loaders that
 * turn on-disk files into index rows, and the upsert/remove helpers the reconciler (§8)
 * and StorageService (§11) call after each write. Every helper keeps the files table and
 * FTS in sync with its entity's rows. `fullRebuild` (scan.ts) composes the same loaders
 * over a whole work directory.
 */

/** The files a section directory may contain, per §5.2 (child section dirs excluded). */
export const SECTION_FILE_NAMES = [
  'section.json',
  'content.md',
  'summary-short.md',
  'summary-long.md',
  'illustration.png',
  'history.jsonl',
] as const

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/** Work-relative path with '/' separators on every platform (files.path is portable). */
export function toWorkRelative(workDir: string, absPath: string): string {
  return path.relative(workDir, absPath).split(path.sep).join('/')
}

function resolveInWork(workDir: string, p: string): string {
  return path.isAbsolute(p) ? p : path.join(workDir, p)
}

/** Files-table row from an already-read buffer — every loader reads a file exactly
 *  once and derives both the hash and its content view from the same bytes (§7.3). */
async function fileRowFromBuffer(workDir: string, absPath: string, buf: Buffer): Promise<FileRow> {
  const stat = await fsp.stat(absPath)
  return {
    path: toWorkRelative(workDir, absPath),
    size: stat.size,
    mtimeMs: Math.trunc(stat.mtimeMs),
    xxh64: await xxh64OfBuffer(buf),
  }
}

/** Build a files-table row (size, mtime_ms, xxh64) for one file; null when absent. */
export async function fileRowFor(workDir: string, absPath: string): Promise<FileRow | null> {
  const buf = await readBufferIfExists(absPath)
  if (buf === null) return null
  return fileRowFromBuffer(workDir, absPath, buf)
}

/** The §6.5 staleness fallback, derived from the shared schema so it can never drift. */
const DEFAULT_ILLUSTRATION_STALE_PCT = WorkSettings.parse({}).illustrationStaleWordDeltaPct

/**
 * Read the work's illustration staleness knob. An ABSENT work.json falls back to the
 * schema default (the reconciler tolerates a deleted work.json, §8); a BROKEN one
 * throws — same policy as fullRebuild (scan.ts), because unparsable work metadata is a
 * real error the reconciler must surface, not silently paper over.
 */
async function illustrationDeltaPct(workDir: string): Promise<number> {
  const raw = await readIfExists(workMetaPath(workDir))
  if (raw === null) return DEFAULT_ILLUSTRATION_STALE_PCT
  return WorkMeta.parse(JSON.parse(raw)).settings.illustrationStaleWordDeltaPct
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

export interface LoadedSection {
  row: SectionRow
  meta: SectionMeta
  files: FileRow[]
  fts: { title: string | null; body: string }
}

/**
 * Read one section directory into its index row, deriving staleness EXACTLY per §6.5:
 * summaries stale on sourceHash mismatch or missing-on-frozen-leaf; agent illustrations
 * stale on a > `illustrationStaleWordDeltaPct` word-count delta or missing-on-frozen-leaf;
 * user illustrations and suppressed tombstones never stale. Returns null when
 * section.json is absent or invalid (adoption is the reconciler's job, §8).
 */
export async function loadSectionFromDisk(
  workDir: string,
  sectionDirAbs: string,
  parentId: string | null,
  illustrationStaleWordDeltaPct: number,
): Promise<LoadedSection | null> {
  // Read each tracked file exactly ONCE: the buffer feeds both its files-table row
  // (hash) and its content view (meta / prose / PNG dims) — §7.3's rebuild budget.
  // section.json first: the ONE section-dir predicate (§5.2/§8 — a dir is a section
  // dir iff its section.json is valid, shared with the reconciler and the read path)
  // rules non-section dirs out before any sibling file is touched.
  const metaBuf = await readBufferIfExists(path.join(sectionDirAbs, 'section.json'))
  const meta = metaBuf === null ? null : parseSectionMeta(metaBuf.toString('utf8'))
  if (meta === null || metaBuf === null) return null

  const rows = new Map<string, FileRow>()
  const buffers = new Map<string, Buffer>([['section.json', metaBuf]])
  rows.set(
    'section.json',
    await fileRowFromBuffer(workDir, path.join(sectionDirAbs, 'section.json'), metaBuf),
  )
  for (const name of SECTION_FILE_NAMES) {
    if (name === 'section.json') continue
    const absPath = path.join(sectionDirAbs, name)
    const buf = await readBufferIfExists(absPath)
    if (buf === null) continue
    buffers.set(name, buf)
    rows.set(name, await fileRowFromBuffer(workDir, absPath, buf))
  }

  const content = buffers.get('content.md')?.toString('utf8') ?? null
  const png = buffers.get('illustration.png') ?? null

  const files: FileRow[] = [...rows.values()]
  const fileNames = new Set(rows.keys())

  const isLeaf = content !== null
  const frozen = meta.frozenAt !== null
  const contentHash = isLeaf ? await xxh64OfString(content) : null
  const wc = isLeaf ? wordCount(content) : 0

  // §6.5 summaries: sourceHash mismatch OR missing (no metadata or no file) on a frozen leaf.
  const summaryStale = (
    enrichment: SectionMeta['enrichments']['shortSummary'],
    fileExists: boolean,
  ): boolean => {
    if (!isLeaf) return false
    if (enrichment === null || !fileExists) return frozen
    return enrichment.sourceHash !== contentHash
  }

  // §6.5 illustrations: the word-count rule (not the hash) so a comma fix regenerates
  // summaries but not art.
  const slot = meta.enrichments.illustration
  let illustrationStale = false
  if (isLeaf) {
    if (slot === null) {
      illustrationStale = frozen // missing counts as stale on a frozen leaf
    } else if ('suppressed' in slot) {
      illustrationStale = false // tombstone: the sweep must not resurrect a deleted image
    } else if (slot.source === 'user') {
      illustrationStale = false // user uploads are pinned until deleted or regenerated
    } else if (png === null) {
      illustrationStale = frozen // metadata without a PNG = missing
    } else if (slot.sourceWordCount !== null && slot.sourceWordCount > 0) {
      illustrationStale =
        Math.abs(wc - slot.sourceWordCount) / slot.sourceWordCount >
        illustrationStaleWordDeltaPct / 100
      // sourceWordCount null/0 on an agent illustration is unexpected metadata; the delta
      // is incomputable, so we leave it fresh rather than trigger surprise API spend.
    }
  }

  let illustrationHash: string | null = null
  let illustrationWidth: number | null = null
  let illustrationHeight: number | null = null
  if (png !== null) {
    // same bytes as the files row: reuse its hash instead of hashing the PNG twice
    illustrationHash = rows.get('illustration.png')?.xxh64 ?? (await xxh64OfBuffer(png))
    const dims = readPngDimensions(png)
    illustrationWidth = dims?.width ?? null
    illustrationHeight = dims?.height ?? null
  }

  const row: SectionRow = {
    id: meta.id,
    parentId,
    kind: meta.kind,
    orderKey: meta.orderKey,
    title: meta.title,
    titleSource: meta.titleSource,
    dirPath: toWorkRelative(workDir, sectionDirAbs),
    wordCount: wc,
    contentHash,
    frozenAt: meta.frozenAt,
    shortSummaryStale: summaryStale(
      meta.enrichments.shortSummary,
      fileNames.has('summary-short.md'),
    ),
    longSummaryStale: summaryStale(meta.enrichments.longSummary, fileNames.has('summary-long.md')),
    illustrationStale,
    illustrationHash,
    illustrationWidth,
    illustrationHeight,
    // Inlined summary text (schema v2): the buffers were already read for the files
    // rows, so GET /sections and the SSE hydrator can answer without touching disk.
    shortSummary: buffers.get('summary-short.md')?.toString('utf8') ?? null,
    longSummary: buffers.get('summary-long.md')?.toString('utf8') ?? null,
  }
  return { row, meta, files, fts: { title: meta.title, body: content ?? '' } }
}

function applyLoadedSection(db: IndexDb, loaded: LoadedSection): void {
  db.transaction(() => {
    db.upsertSection(loaded.row)
    const present = new Set(loaded.files.map((f) => f.path))
    for (const name of SECTION_FILE_NAMES) {
      const rel = `${loaded.row.dirPath}/${name}`
      if (!present.has(rel)) db.deleteFile(rel)
    }
    for (const f of loaded.files) db.upsertFile(f)
    db.setFts('section', loaded.row.id, loaded.fts.title, loaded.fts.body)
  })
}

/**
 * Re-index one section directory from disk (row + files table + FTS). `sectionDir` may
 * be absolute or work-relative. The parent id is derived from directory containment:
 * the enclosing dir's section.json (§5.2 — dir nesting = tree).
 */
export async function upsertSectionFromDisk(
  db: IndexDb,
  workDir: string,
  sectionDir: string,
): Promise<SectionRow | null> {
  const abs = resolveInWork(workDir, sectionDir)
  const parentDir = path.dirname(abs)
  let parentId: string | null = null
  if (path.resolve(parentDir) !== path.resolve(sectionsDir(workDir))) {
    parentId = (await tryReadSectionMeta(parentDir))?.id ?? null
  }
  const loaded = await loadSectionFromDisk(
    workDir,
    abs,
    parentId,
    await illustrationDeltaPct(workDir),
  )
  if (loaded === null) return null
  applyLoadedSection(db, loaded)
  return loaded.row
}

/**
 * Re-derive one section's staleness (and the content/illustration fields it depends on)
 * after a prose or enrichment write — the "staleness recomputation" of §6.5. The section
 * must already be indexed; its dir_path and parent_id are taken from the existing row.
 */
export async function recomputeSectionStaleness(
  db: IndexDb,
  workDir: string,
  sectionId: string,
): Promise<SectionRow | null> {
  const existing = db.getSection(sectionId)
  if (existing === null) return null
  const abs = path.join(workDir, ...existing.dirPath.split('/'))
  const loaded = await loadSectionFromDisk(
    workDir,
    abs,
    existing.parentId,
    await illustrationDeltaPct(workDir),
  )
  if (loaded === null) return null
  applyLoadedSection(db, loaded)
  return loaded.row
}

// ---------------------------------------------------------------------------
// Snippets
// ---------------------------------------------------------------------------

export interface LoadedSnippet {
  row: SnippetRow
  meta: SnippetMeta
  files: FileRow[]
  body: string
}

/** Complete ('\n'-terminated) line count of a JSONL buffer — a torn unterminated tail
 *  is excluded, matching what readJsonl would drop, WITHOUT parsing every line (§7.3). */
function countJsonlLines(buf: Buffer): number {
  let count = 0
  for (let i = buf.indexOf(0x0a); i !== -1; i = buf.indexOf(0x0a, i + 1)) count++
  return count
}

/**
 * Read one frontier snippet file (frontmatter + body) into its index row.
 * revision_count = revision-log line count (§7.1). Returns null when the frontmatter is
 * absent or invalid (adoption is the reconciler's job, §8). `knownFileRow` lets a caller
 * that already hashed the .md (the reconciler's classify, §8) skip re-hashing it.
 */
export async function loadSnippetFromDisk(
  workDir: string,
  fileAbs: string,
  knownFileRow?: FileRow,
): Promise<LoadedSnippet | null> {
  const buf = await readBufferIfExists(fileAbs)
  if (buf === null) return null
  const fm = parseFrontmatter(buf.toString('utf8'))
  const parsed = SnippetMeta.safeParse(fm.data)
  if (!parsed.success) return null
  const meta = parsed.data

  const relPath = toWorkRelative(workDir, fileAbs)
  const files: FileRow[] = [
    knownFileRow !== undefined && knownFileRow.path === relPath
      ? knownFileRow
      : await fileRowFromBuffer(workDir, fileAbs, buf),
  ]

  // ONE read of the revision log serves both its files row and the line count — do
  // not JSON.parse every revision just to count them (§7.3).
  const revLogAbs = revisionLogPath(workDir, meta.id)
  const revBuf = await readBufferIfExists(revLogAbs) // missing file reads as empty
  let revLogLines = 0
  if (revBuf !== null) {
    files.push(await fileRowFromBuffer(workDir, revLogAbs, revBuf))
    revLogLines = countJsonlLines(revBuf)
  }
  // A snippet with no (or an empty) revision log still embodies one revision — the DDL
  // default; the log is re-derivable state, the .md file is the truth (§9.1).
  const revisionCount = revLogLines > 0 ? revLogLines : 1

  const row: SnippetRow = {
    id: meta.id,
    orderKey: meta.orderKey,
    authorship: meta.authorship,
    originRunId: meta.originRunId,
    rev: meta.rev,
    revisionCount,
    wordCount: wordCount(fm.body),
    updatedAt: meta.updatedAt,
    filePath: toWorkRelative(workDir, fileAbs),
  }
  return { row, meta, files, body: fm.body }
}

/** Re-index one snippet file from disk (row + files table incl. revision log + FTS). */
export async function upsertSnippetFromDisk(
  db: IndexDb,
  workDir: string,
  snippetFile: string,
  knownFileRow?: FileRow,
): Promise<SnippetRow | null> {
  const loaded = await loadSnippetFromDisk(
    workDir,
    resolveInWork(workDir, snippetFile),
    knownFileRow,
  )
  if (loaded === null) return null
  db.transaction(() => {
    db.upsertSnippet(loaded.row)
    const present = new Set(loaded.files.map((f) => f.path))
    const revRel = revisionLogRelPath(loaded.row.id)
    if (!present.has(revRel)) db.deleteFile(revRel)
    for (const f of loaded.files) db.upsertFile(f)
    db.setFts('snippet', loaded.row.id, null, loaded.body)
  })
  return loaded.row
}

// ---------------------------------------------------------------------------
// World entries
// ---------------------------------------------------------------------------

export interface LoadedWorldEntry {
  row: WorldEntryRow
  meta: WorldEntryMeta
  keys: string[]
  files: FileRow[]
  body: string
}

/**
 * Read one world-entry file into its index row (+ image/sidecar files rows if present).
 * `knownFileRow` lets a caller that already hashed the .md skip re-hashing it (§8).
 */
export async function loadWorldEntryFromDisk(
  workDir: string,
  fileAbs: string,
  knownFileRow?: FileRow,
): Promise<LoadedWorldEntry | null> {
  const buf = await readBufferIfExists(fileAbs)
  if (buf === null) return null
  const fm = parseFrontmatter(buf.toString('utf8'))
  const parsed = WorldEntryMeta.safeParse(fm.data)
  if (!parsed.success) return null
  const meta = parsed.data

  const relPath = toWorkRelative(workDir, fileAbs)
  const files: FileRow[] = [
    knownFileRow !== undefined && knownFileRow.path === relPath
      ? knownFileRow
      : await fileRowFromBuffer(workDir, fileAbs, buf),
  ]

  if (meta.image !== null) {
    // §5.4's sample spells `image` relative to the entry file ('../images/…'); §10.6's
    // doc comment says work-relative. Accept both — first resolution that exists wins.
    const candidates = [
      path.resolve(path.dirname(fileAbs), meta.image),
      path.resolve(workDir, meta.image),
    ]
    for (const candidate of candidates) {
      if (toWorkRelative(workDir, candidate).startsWith('..')) continue // escaped the work dir
      const pngRow = await fileRowFor(workDir, candidate)
      if (pngRow === null) continue
      files.push(pngRow)
      if (candidate.toLowerCase().endsWith('.png')) {
        const sidecarRow = await fileRowFor(workDir, `${candidate.slice(0, -4)}.json`)
        if (sidecarRow) files.push(sidecarRow)
      }
      break
    }
  }

  const row: WorldEntryRow = {
    id: meta.id,
    name: meta.name,
    shortSummary: meta.shortSummary,
    imagePath: meta.image,
    filePath: toWorkRelative(workDir, fileAbs),
    updatedAt: meta.updatedAt,
  }
  return { row, meta, keys: meta.keys, files, body: fm.body }
}

/** Re-index one world-entry file from disk (row + alias keys + files table + FTS). */
export async function upsertWorldEntryFromDisk(
  db: IndexDb,
  workDir: string,
  entryFile: string,
  knownFileRow?: FileRow,
): Promise<WorldEntryRow | null> {
  const loaded = await loadWorldEntryFromDisk(
    workDir,
    resolveInWork(workDir, entryFile),
    knownFileRow,
  )
  if (loaded === null) return null
  db.transaction(() => {
    db.upsertWorldEntry(loaded.row, loaded.keys)
    for (const f of loaded.files) db.upsertFile(f)
    db.setFts('world', loaded.row.id, loaded.row.name, loaded.body)
  })
  return loaded.row
}

// ---------------------------------------------------------------------------
// Agent runs — parse ONLY the first (meta) and last (result) lines (§7.3)
// ---------------------------------------------------------------------------

export interface LoadedRun {
  run: AgentRunRow
  artifacts: RunArtifactRow[]
}

/**
 * Read a run file's first line and last non-empty line without loading the transcript
 * (§7.3 — run volume must not blow the rebuild budget). Shared with the crash
 * finalization pass (runStore, §10.7); the implementation lives in lib/fsx.
 */
export const readRunBoundaryLines = readJsonlBoundaryLines

function parseRunEvent(line: string): RunEvent | null {
  let json: unknown
  try {
    json = JSON.parse(line)
  } catch {
    return null
  }
  const parsed = RunEvent.safeParse(json)
  return parsed.success ? parsed.data : null
}

/**
 * Read one run transcript's `meta` and `result` lines into agent_runs/run_artifacts row
 * shapes. A run whose `result` never arrived (crash before finalization, §10.7) yields
 * status/ended_at/token columns null and no artifacts. Returns null when the first line
 * is not a valid `meta` event.
 */
export async function loadRunFromDisk(workDir: string, fileAbs: string): Promise<LoadedRun | null> {
  const { first, last } = await readRunBoundaryLines(fileAbs)
  if (first === null) return null
  const meta = parseRunEvent(first)
  if (meta === null || meta.type !== 'meta') return null

  let result: Extract<RunEvent, { type: 'result' }> | null = null
  if (last !== null && last !== first) {
    const ev = parseRunEvent(last)
    if (ev !== null && ev.type === 'result') result = ev
  }

  const run: AgentRunRow = {
    id: meta.runId,
    kind: meta.kind,
    lane: meta.lane,
    model: meta.model,
    startedAt: meta.startedAt,
    endedAt: result?.endedAt ?? null,
    status: result?.status ?? null,
    promptTokens: result?.usageTotal.promptTokens ?? null,
    completionTokens: result?.usageTotal.completionTokens ?? null,
    filePath: toWorkRelative(workDir, fileAbs),
  }
  const artifacts: RunArtifactRow[] = []
  for (const a of result?.artifacts ?? []) {
    const artifactId = a.snippetId ?? a.sectionId ?? a.entryId
    if (artifactId === undefined) continue
    artifacts.push({
      runId: meta.runId,
      artifactKind: a.kind,
      artifactId,
      rev: a.rev ?? null,
      state: a.state,
    })
  }
  return { run, artifacts }
}

/**
 * Ingest one run file's meta+result lines into agent_runs/run_artifacts. Run files are
 * not part of the §8 files-table walk set, so no files row is written.
 */
export async function ingestRunFile(
  db: IndexDb,
  workDir: string,
  runFile: string,
): Promise<AgentRunRow | null> {
  const loaded = await loadRunFromDisk(workDir, resolveInWork(workDir, runFile))
  if (loaded === null) return null
  db.upsertRun(loaded.run, loaded.artifacts)
  return loaded.run
}

// ---------------------------------------------------------------------------
// Situation, file rows, entity removal
// ---------------------------------------------------------------------------

/**
 * Recompute the situation's meta `situationHash` and files row. An absent situation.md
 * is an empty situation (§2.2): its hash row is still written, its files row dropped.
 */
export async function refreshSituation(db: IndexDb, workDir: string): Promise<string> {
  const abs = situationPath(workDir)
  const text = await readIfExists(abs)
  const hash = await xxh64OfString(text ?? '')
  const fileRow = text === null ? null : await fileRowFor(workDir, abs)
  db.transaction(() => {
    db.setMeta('situationHash', hash)
    if (fileRow) db.upsertFile(fileRow)
    else db.deleteFile(toWorkRelative(workDir, abs))
  })
  return hash
}

export function removeFileRow(db: IndexDb, workDir: string, filePath: string): void {
  db.deleteFile(toWorkRelative(workDir, resolveInWork(workDir, filePath)))
}

/**
 * The id of the snippet / world entry whose index row claims `relPath`, or null when the
 * path is unclaimed. The reconciler (§8) uses this before adopting a path under a new
 * identity: when the file's old identity cannot be re-associated (frontmatter stripped
 * or replaced, no parsable filename short id), the previous claimant's rows would
 * otherwise linger as ghosts and break index == fullRebuild.
 */
export function findEntityIdByPath(
  db: IndexDb,
  kind: 'snippet' | 'world',
  relPath: string,
): string | null {
  const rows = kind === 'snippet' ? db.listSnippetRows() : db.listWorldEntryRows()
  return rows.find((r) => r.filePath === relPath)?.id ?? null
}

/**
 * Drop every index row belonging to one entity (entity table, FTS, and its known
 * files-table rows) — the "missing on disk" path of the reconciler (§8). Removing a
 * section does not cascade to its children; callers remove each vanished entity.
 */
export function removeEntityRows(
  db: IndexDb,
  kind: 'section' | 'snippet' | 'world' | 'run',
  id: string,
): void {
  db.transaction(() => {
    switch (kind) {
      case 'section': {
        const row = db.getSection(id)
        if (row) {
          for (const name of SECTION_FILE_NAMES) db.deleteFile(`${row.dirPath}/${name}`)
        }
        db.deleteSection(id)
        db.deleteFts('section', id)
        break
      }
      case 'snippet': {
        const row = db.getSnippet(id)
        if (row) db.deleteFile(row.filePath)
        db.deleteFile(revisionLogRelPath(id))
        db.deleteSnippet(id)
        db.deleteFts('snippet', id)
        break
      }
      case 'world': {
        const row = db.getWorldEntry(id)
        if (row) db.deleteFile(row.filePath)
        db.deleteWorldEntry(id)
        db.deleteFts('world', id)
        break
      }
      case 'run': {
        db.deleteRun(id)
        break
      }
    }
  })
}
