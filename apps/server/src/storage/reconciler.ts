import fsp from 'node:fs/promises'
import path from 'node:path'
import {
  type EntityKind,
  RevisionEvent,
  SnippetMeta,
  WorkMeta,
  WorldEntryMeta,
} from '@cowrite/shared'
import { ulid } from 'ulid'
import type { StorageChange } from './events.js'
import type { FileRow, IndexDb } from './index/db.js'
import {
  fileRowFor,
  findEntityIdByPath,
  recomputeSectionStaleness,
  refreshSituation,
  removeEntityRows,
  SECTION_FILE_NAMES,
  toWorkRelative,
  upsertSectionFromDisk,
  upsertSnippetFromDisk,
  upsertWorldEntryFromDisk,
} from './index/ingest.js'
import { parseFrontmatter } from './lib/frontmatter.js'
import {
  appendJsonlLine,
  ensureDir,
  isTmpFile,
  readdirSorted,
  readIfExists,
  writeFileAtomic,
} from './lib/fsx.js'
import { compareOrderKeys, keyBetween } from './lib/orderKeys.js'
import {
  frontierRevisionsDir,
  frontierSnippetsDir,
  parseSnippetFileName,
  parseWorldEntryFileName,
  revisionLogPath,
  sectionsDir,
  shortId,
  situationPath,
  snippetFileName,
  workMetaPath,
  worldEntriesDir,
  worldImagesDir,
} from './lib/paths.js'
import { tryReadSectionMeta } from './sectionStore.js'
import { getRevisions, serializeSnippet } from './snippetStore.js'
import { serializeEntry } from './worldStore.js'

/**
 * The external-edit reconciler (spec 02 §8), run at work open, before every agent run,
 * and on the server's 30 s subscriber timer. For every path in the walk set
 * (work.json, situation.md, sections/**, frontier/**, world/**) ∪ the files table:
 *
 * - missing on disk        → drop the entity's index rows + a 'removed externally' entry
 * - (size, mtime) match    → skip (fast path, no read)
 * - xxh64 match            → update the mtime row only (e.g. touch(1))
 * - else reparse           → valid frontmatter + known id ⇒ update rows & staleness;
 *                            valid frontmatter + unknown id ⇒ adopt as new entity;
 *                            no/broken frontmatter ⇒ per-directory adoption rules below
 *
 * Adoption rules (§8 — adoption is the failure mode; no user file is ever deleted):
 * frontier snippets and world entries re-associate by filename short id first, then mint
 * a ULID (orderKey from filename sort position for snippets) and write frontmatter back;
 * strays inside section dirs and loose files under sections/ are reported as
 * unrecognized and never touched. Filename prefixes are renumbered lazily, only when
 * frontmatter order and prefix order disagree.
 */

export interface ReconcileEntry {
  kind: EntityKind
  id: string
  /** Work-relative path ('/'-separated) of the file or directory involved. */
  path: string
}

export interface ReconcileReport {
  adopted: ReconcileEntry[]
  changed: ReconcileEntry[]
  removed: ReconcileEntry[]
  /** Foreign files we never adopt or touch (§8 rules table). Work-relative paths. */
  unrecognized: string[]
  /** Snippet files renamed by the lazy prefix renumbering pass. */
  renumbered: number
}

export interface ReconcileDeps {
  workDir: string
  db: IndexDb
  /** Change fan-out (§11). Optional so index-only tooling can reconcile silently. */
  emit?: (event: StorageChange) => void
}

// Orphaned atomic-write temp files (§9.1, isTmpFile) are swept at startup, never reconciled.
const REVISION_LOG = /^[0-9A-HJKMNP-TV-Z]{26}\.jsonl$/
const SECTION_FILES = new Set<string>(SECTION_FILE_NAMES)

interface Ctx {
  workDir: string
  db: IndexDb
  emit: (event: StorageChange) => void
  report: ReconcileReport
  /** Work-relative paths seen on disk during the walk (missing = files-table − seen). */
  seen: Set<string>
}

export async function reconcile(deps: ReconcileDeps): Promise<ReconcileReport> {
  const ctx: Ctx = {
    workDir: deps.workDir,
    db: deps.db,
    emit: deps.emit ?? (() => {}),
    report: { adopted: [], changed: [], removed: [], unrecognized: [], renumbered: 0 },
    seen: new Set(),
  }
  await reconcileWorkMeta(ctx)
  await reconcileSituation(ctx)
  await reconcileSections(ctx)
  await reconcileSnippets(ctx)
  await reconcileRevisionLogs(ctx)
  await reconcileWorldEntries(ctx)
  await reconcileWorldImages(ctx)
  await dropMissing(ctx)
  await renumberSnippetPrefixes(ctx)
  ctx.db.setMeta('lastScanAt', new Date().toISOString())
  return ctx.report
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString()
}

function relOf(ctx: Ctx, absPath: string): string {
  return toWorkRelative(ctx.workDir, absPath)
}

function workId(ctx: Ctx): string {
  return ctx.db.getMeta('workId') ?? ''
}

/**
 * Track a snippet's revision log as an orphan after its owner's rows were removed while
 * the log itself is still on disk: orphan logs are 'tracked but never deleted' (§8), and
 * fullRebuild rows every log present on disk, so reconcile must keep the files row too.
 */
async function keepOrphanRevisionLogTracked(ctx: Ctx, snippetId: string): Promise<void> {
  const logRow = await fileRowFor(ctx.workDir, revisionLogPath(ctx.workDir, snippetId))
  if (logRow !== null) ctx.db.upsertFile(logRow)
}

/**
 * `abs` is about to be (re)indexed as entity `winnerId` (§8 adoption / re-association).
 * If a DIFFERENT entity's rows still claim the same file_path — e.g. frontmatter was
 * stripped from a file whose name carries no parsable short id, so the reconciler mints
 * a NEW ULID for the path — drop the stale claimant's rows (entity table, FTS, files)
 * first; they would otherwise linger as ghosts and break index == fullRebuild.
 */
async function dropStaleClaimant(
  ctx: Ctx,
  kind: 'snippet' | 'world',
  abs: string,
  winnerId: string,
): Promise<void> {
  const rel = relOf(ctx, abs)
  const claimant = findEntityIdByPath(ctx.db, kind, rel)
  if (claimant === null || claimant === winnerId) return
  removeEntityRows(ctx.db, kind, claimant)
  ctx.report.removed.push({ kind, id: claimant, path: rel })
  if (kind === 'snippet') {
    await keepOrphanRevisionLogTracked(ctx, claimant)
    ctx.emit({ type: 'snippet.removed', snippetId: claimant })
  } else {
    ctx.emit({ type: 'world.removed', entryId: claimant })
  }
}

type Classified =
  | { state: 'absent' }
  | { state: 'unchanged' }
  | { state: 'touched' | 'changed' | 'new'; row: FileRow }

/** The §8 change ladder for one file: fast (size, mtime) path, then the xxh64 confirm. */
async function classify(ctx: Ctx, absPath: string): Promise<Classified> {
  const rel = relOf(ctx, absPath)
  let stat: Awaited<ReturnType<typeof fsp.stat>>
  try {
    stat = await fsp.stat(absPath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'absent' }
    throw err
  }
  ctx.seen.add(rel)
  const prev = ctx.db.getFile(rel)
  if (prev !== null && prev.size === stat.size && prev.mtimeMs === Math.trunc(stat.mtimeMs)) {
    return { state: 'unchanged' }
  }
  const row = await fileRowFor(ctx.workDir, absPath)
  if (row === null) return { state: 'absent' } // deleted between stat and read
  if (prev === null) return { state: 'new', row }
  if (prev.xxh64 === row.xxh64) return { state: 'touched', row }
  return { state: 'changed', row }
}

// ---------------------------------------------------------------------------
// work.json & situation.md
// ---------------------------------------------------------------------------

async function reconcileWorkMeta(ctx: Ctx): Promise<void> {
  const abs = workMetaPath(ctx.workDir)
  const c = await classify(ctx, abs)
  if (c.state === 'absent' || c.state === 'unchanged') return
  ctx.db.upsertFile(c.row)
  if (c.state === 'touched') return
  const raw = await readIfExists(abs)
  let meta: WorkMeta
  try {
    meta = WorkMeta.parse(JSON.parse(raw ?? ''))
  } catch {
    // Broken work.json: files are the truth, but there is nothing safe to ingest —
    // report and keep the previous meta rows.
    ctx.report.unrecognized.push('work.json')
    return
  }
  ctx.db.setMeta('workId', meta.id)
  ctx.db.setMeta('levelScheme', JSON.stringify(meta.levelScheme))
  ctx.report.changed.push({ kind: 'work', id: meta.id, path: 'work.json' })
  ctx.emit({ type: 'work.changed' })
}

async function reconcileSituation(ctx: Ctx): Promise<void> {
  const abs = situationPath(ctx.workDir)
  const c = await classify(ctx, abs)
  if (c.state === 'absent' || c.state === 'unchanged') return
  if (c.state === 'touched') {
    ctx.db.upsertFile(c.row)
    return
  }
  await refreshSituation(ctx.db, ctx.workDir)
  ctx.report.changed.push({ kind: 'work', id: workId(ctx), path: 'situation.md' })
  ctx.emit({ type: 'situation.changed' })
}

// ---------------------------------------------------------------------------
// sections/** — never adopt strays; recompute staleness on change (§6.5, §8).
// The section-dir predicate (valid section.json) is shared with sectionStore's tree
// walk and the index scan — dir names are a human mirror only.
// ---------------------------------------------------------------------------

async function reconcileSections(ctx: Ctx): Promise<void> {
  await walkSectionChildren(ctx, sectionsDir(ctx.workDir), new Set())
}

/**
 * Handle one directory level: files not in `knownFileNames` are unrecognized (loose
 * files under sections/, strays inside a section dir); child dirs are section dirs iff
 * they carry a valid section.json, otherwise unrecognized and never entered.
 *
 * §7.3 fast path: section.json is classified via (size, mtime) FIRST, and an unchanged
 * file resolves its section id from the existing index row by dir_path — the 30 s
 * no-change tick must perform ZERO full-file reads. Only a changed/new section.json
 * (or an index miss) is read and parsed.
 */
async function walkSectionChildren(
  ctx: Ctx,
  dirAbs: string,
  knownFileNames: ReadonlySet<string>,
): Promise<void> {
  for (const entry of await readdirSorted(dirAbs)) {
    if (isTmpFile(entry.name)) continue
    const childAbs = path.join(dirAbs, entry.name)
    if (entry.isFile()) {
      if (!knownFileNames.has(entry.name)) ctx.report.unrecognized.push(relOf(ctx, childAbs))
      continue
    }
    if (!entry.isDirectory()) continue

    const c = await classify(ctx, path.join(childAbs, 'section.json'))
    if (c.state === 'absent') {
      ctx.report.unrecognized.push(relOf(ctx, childAbs))
      continue
    }
    if (c.state === 'unchanged' || c.state === 'touched') {
      const row = ctx.db.getSectionByDirPath(relOf(ctx, childAbs))
      if (row !== null) {
        if (c.state === 'touched') ctx.db.upsertFile(c.row)
        await processSectionDir(ctx, childAbs, row.id, false)
        continue
      }
      // index miss (files row without a sections row): fall through to a real read
    }
    const meta = await tryReadSectionMeta(childAbs)
    if (meta === null) ctx.report.unrecognized.push(relOf(ctx, childAbs))
    else await processSectionDir(ctx, childAbs, meta.id, c.state !== 'unchanged')
  }
}

/**
 * The section analogue of dropStaleClaimant: `dirAbs` is about to be (re)indexed as
 * section `winnerId`, but a DIFFERENT section id's rows still claim the same dir_path —
 * a hand-edited section.json swapped the id in place (§8). Drop the old claimant's rows
 * (sections row, files rows, FTS) first, or they linger as ghosts and break
 * index == fullRebuild.
 */
function dropStaleSectionClaimant(ctx: Ctx, dirAbs: string, winnerId: string): void {
  const rel = relOf(ctx, dirAbs)
  const claimant = ctx.db.getSectionByDirPath(rel)?.id ?? null
  if (claimant === null || claimant === winnerId) return
  removeEntityRows(ctx.db, 'section', claimant)
  ctx.report.removed.push({ kind: 'section', id: claimant, path: rel })
  ctx.emit({ type: 'section.changed', sectionId: claimant })
}

/**
 * Reconcile one section dir whose id is already resolved (from the index row on the
 * unchanged fast path, or a fresh section.json parse). `metaDirty` says section.json
 * itself changed; the other tracked files are classified here (stat-only when nothing
 * changed).
 */
async function processSectionDir(
  ctx: Ctx,
  dirAbs: string,
  sectionId: string,
  metaDirty: boolean,
): Promise<void> {
  let dirty = metaDirty
  for (const name of SECTION_FILE_NAMES) {
    if (name === 'section.json') continue // classified by walkSectionChildren
    const fileAbs = path.join(dirAbs, name)
    const c = await classify(ctx, fileAbs)
    switch (c.state) {
      case 'absent':
        // A tracked file vanished from a still-present section dir: the section loader
        // drops the row and re-derives staleness (missing enrichment counts stale, §6.5).
        if (ctx.db.getFile(relOf(ctx, fileAbs)) !== null) dirty = true
        break
      case 'touched':
        ctx.db.upsertFile(c.row)
        break
      case 'new':
      case 'changed':
        dirty = true
        break
      default:
        break
    }
  }

  const prev = ctx.db.getSection(sectionId)
  if (dirty || prev === null) {
    dropStaleSectionClaimant(ctx, dirAbs, sectionId)
    const row = await upsertSectionFromDisk(ctx.db, ctx.workDir, dirAbs)
    if (row !== null) {
      const entry: ReconcileEntry = { kind: 'section', id: sectionId, path: relOf(ctx, dirAbs) }
      if (prev === null) ctx.report.adopted.push(entry)
      else ctx.report.changed.push(entry)
      ctx.emit({ type: 'section.changed', sectionId })
      if (prev !== null) {
        // Staleness flips feed the enrichment sweep (§11).
        if (prev.shortSummaryStale !== row.shortSummaryStale) {
          ctx.emit({ type: 'enrichment.updated', sectionId, enrichment: 'shortSummary' })
        }
        if (prev.longSummaryStale !== row.longSummaryStale) {
          ctx.emit({ type: 'enrichment.updated', sectionId, enrichment: 'longSummary' })
        }
        if (prev.illustrationStale !== row.illustrationStale) {
          ctx.emit({ type: 'enrichment.updated', sectionId, enrichment: 'illustration' })
        }
      }
    }
  }

  await walkSectionChildren(ctx, dirAbs, SECTION_FILES)
}

// ---------------------------------------------------------------------------
// frontier/snippets/** — adopt per §8 (short-id re-association first)
// ---------------------------------------------------------------------------

async function reconcileSnippets(ctx: Ctx): Promise<void> {
  const dirAbs = frontierSnippetsDir(ctx.workDir)
  for (const entry of await readdirSorted(dirAbs)) {
    if (!entry.isFile() || isTmpFile(entry.name)) continue
    const abs = path.join(dirAbs, entry.name)
    if (!entry.name.endsWith('.md')) {
      ctx.report.unrecognized.push(relOf(ctx, abs))
      continue
    }
    const c = await classify(ctx, abs)
    if (c.state === 'absent' || c.state === 'unchanged') continue
    if (c.state === 'touched') {
      ctx.db.upsertFile(c.row)
      continue
    }
    await reparseSnippetFile(ctx, abs, entry.name, c.row)
  }
}

async function reparseSnippetFile(
  ctx: Ctx,
  abs: string,
  fileName: string,
  fileRow?: FileRow,
): Promise<void> {
  const raw = (await readIfExists(abs)) ?? ''
  const fm = parseFrontmatter(raw)
  const parsed = SnippetMeta.safeParse(fm.data)

  if (parsed.success) {
    const known = ctx.db.getSnippet(parsed.data.id) !== null
    await dropStaleClaimant(ctx, 'snippet', abs, parsed.data.id)
    // classify already hashed these bytes: hand its FileRow down instead of re-hashing
    const row = await upsertSnippetFromDisk(ctx.db, ctx.workDir, abs, fileRow)
    if (row === null) return
    const entry: ReconcileEntry = { kind: 'snippet', id: row.id, path: relOf(ctx, abs) }
    if (known) {
      ctx.report.changed.push(entry)
      ctx.emit({ type: 'snippet.updated', snippetId: row.id })
    } else {
      ctx.report.adopted.push(entry)
      ctx.emit({ type: 'snippet.created', snippetId: row.id })
    }
    return
  }

  // No/broken frontmatter. Short-id re-association first (§8): a stripped-frontmatter
  // save keeps its identity and revision log instead of being re-minted.
  const sid = parseSnippetFileName(fileName)?.shortId ?? null
  const existing =
    sid === null ? undefined : ctx.db.listSnippetRows().find((r) => shortId(r.id) === sid)
  if (existing !== undefined) {
    const revisions = await getRevisions(ctx.workDir, existing.id).catch(
      () => [] as RevisionEvent[],
    )
    const meta = SnippetMeta.parse({
      id: existing.id,
      orderKey: existing.orderKey,
      // The .md frontmatter is gone; the earliest revision event is the best surviving
      // record of creation time.
      createdAt: revisions[0]?.ts ?? existing.updatedAt,
      updatedAt: nowIso(),
      authorship: existing.authorship,
      originRunId: existing.originRunId,
      rev: existing.rev,
    })
    await writeFileAtomic(abs, serializeSnippet(meta, fm.body))
    await dropStaleClaimant(ctx, 'snippet', abs, existing.id)
    await upsertSnippetFromDisk(ctx.db, ctx.workDir, abs)
    ctx.report.changed.push({ kind: 'snippet', id: existing.id, path: relOf(ctx, abs) })
    ctx.emit({ type: 'snippet.updated', snippetId: existing.id })
    return
  }

  // Foreign file: mint a ULID, orderKey from filename sort position, write frontmatter
  // back atomically (§8), and seed the revision log so history starts at adoption.
  const ts = nowIso()
  const meta = SnippetMeta.parse({
    id: ulid(),
    orderKey: await orderKeyFromFilenamePosition(ctx, fileName),
    createdAt: ts,
    updatedAt: ts,
    authorship: 'user', // a foreign file is a user artifact by definition
    originRunId: null,
    rev: 1,
  })
  await writeFileAtomic(abs, serializeSnippet(meta, fm.body))
  await ensureDir(frontierRevisionsDir(ctx.workDir))
  await appendJsonlLine(
    revisionLogPath(ctx.workDir, meta.id),
    RevisionEvent.parse({ type: 'revision', rev: 1, ts, author: 'user', text: fm.body }),
  )
  // Re-mint: identity could not be recovered, so any entity that used to claim this
  // path is gone for good — its rows must go with it (index == fullRebuild).
  await dropStaleClaimant(ctx, 'snippet', abs, meta.id)
  await upsertSnippetFromDisk(ctx.db, ctx.workDir, abs)
  ctx.report.adopted.push({ kind: 'snippet', id: meta.id, path: relOf(ctx, abs) })
  ctx.emit({ type: 'snippet.created', snippetId: meta.id })
}

/** §8: a foreign snippet's orderKey comes from its filename sort position. */
async function orderKeyFromFilenamePosition(ctx: Ctx, fileName: string): Promise<string> {
  const dirAbs = frontierSnippetsDir(ctx.workDir)
  const names = (await readdirSorted(dirAbs))
    .filter((e) => e.isFile() && e.name.endsWith('.md') && !isTmpFile(e.name))
    .map((e) => e.name)
  const keyOf = async (name: string): Promise<string | null> => {
    const raw = await readIfExists(path.join(dirAbs, name))
    if (raw === null) return null
    const parsed = SnippetMeta.safeParse(parseFrontmatter(raw).data)
    return parsed.success ? parsed.data.orderKey : null
  }
  const at = names.indexOf(fileName)
  let before: string | null = null
  for (let i = at - 1; i >= 0; i--) {
    const key = await keyOf(names[i] ?? '')
    if (key !== null) {
      before = key
      break
    }
  }
  let after: string | null = null
  for (let i = at + 1; i < names.length; i++) {
    const key = await keyOf(names[i] ?? '')
    if (key !== null) {
      after = key
      break
    }
  }
  try {
    return keyBetween(before, after)
  } catch {
    // Neighbors' keys disagree with filename order (prefix drift): append after the
    // larger key; the renumber pass restores the filename mirror afterwards.
    const last =
      before !== null && after !== null
        ? compareOrderKeys(before, after) >= 0
          ? before
          : after
        : (before ?? after)
    return keyBetween(last, null)
  }
}

// ---------------------------------------------------------------------------
// frontier/revisions/** — logs are secondary to their snippet's .md (§9.1)
// ---------------------------------------------------------------------------

async function reconcileRevisionLogs(ctx: Ctx): Promise<void> {
  const dirAbs = frontierRevisionsDir(ctx.workDir)
  for (const entry of await readdirSorted(dirAbs)) {
    if (!entry.isFile() || isTmpFile(entry.name)) continue
    const abs = path.join(dirAbs, entry.name)
    if (!REVISION_LOG.test(entry.name)) {
      ctx.report.unrecognized.push(relOf(ctx, abs))
      continue
    }
    const c = await classify(ctx, abs)
    if (c.state === 'absent' || c.state === 'unchanged') continue
    if (c.state === 'touched') {
      ctx.db.upsertFile(c.row)
      continue
    }
    const snippetId = entry.name.slice(0, 26)
    const owner = ctx.db.getSnippet(snippetId)
    if (owner !== null) {
      // Refresh revision_count (+ this log's files row) through the snippet loader.
      await upsertSnippetFromDisk(ctx.db, ctx.workDir, owner.filePath)
    } else {
      ctx.db.upsertFile(c.row) // orphan log: tracked but never deleted (§8)
    }
  }
}

// ---------------------------------------------------------------------------
// world/** — same adoption rules as snippets, no orderKey (§8)
// ---------------------------------------------------------------------------

async function reconcileWorldEntries(ctx: Ctx): Promise<void> {
  const dirAbs = worldEntriesDir(ctx.workDir)
  for (const entry of await readdirSorted(dirAbs)) {
    if (!entry.isFile() || isTmpFile(entry.name)) continue
    const abs = path.join(dirAbs, entry.name)
    if (!entry.name.endsWith('.md')) {
      ctx.report.unrecognized.push(relOf(ctx, abs))
      continue
    }
    const c = await classify(ctx, abs)
    if (c.state === 'absent' || c.state === 'unchanged') continue
    if (c.state === 'touched') {
      ctx.db.upsertFile(c.row)
      continue
    }
    await reparseWorldEntryFile(ctx, abs, entry.name, c.row)
  }
}

async function reparseWorldEntryFile(
  ctx: Ctx,
  abs: string,
  fileName: string,
  fileRow?: FileRow,
): Promise<void> {
  const raw = (await readIfExists(abs)) ?? ''
  const fm = parseFrontmatter(raw)
  const parsed = WorldEntryMeta.safeParse(fm.data)

  if (parsed.success) {
    const known = ctx.db.getWorldEntry(parsed.data.id) !== null
    await dropStaleClaimant(ctx, 'world', abs, parsed.data.id)
    // classify already hashed these bytes: hand its FileRow down instead of re-hashing
    const row = await upsertWorldEntryFromDisk(ctx.db, ctx.workDir, abs, fileRow)
    if (row === null) return
    const entry: ReconcileEntry = { kind: 'world', id: row.id, path: relOf(ctx, abs) }
    if (known) ctx.report.changed.push(entry)
    else ctx.report.adopted.push(entry)
    ctx.emit({ type: 'world.updated', entryId: row.id })
    return
  }

  const sid = parseWorldEntryFileName(fileName)?.shortId ?? null
  const existing =
    sid === null ? undefined : ctx.db.listWorldEntryRows().find((r) => shortId(r.id) === sid)
  if (existing !== undefined) {
    const meta = WorldEntryMeta.parse({
      id: existing.id,
      name: existing.name,
      keys: ctx.db.worldKeys(existing.id),
      image: existing.imagePath,
      shortSummary: existing.shortSummary,
      // createdBy is not indexed and the frontmatter that held it is gone; a stripped
      // save means a user was editing, so 'user' is the least-wrong reconstruction.
      createdBy: 'user',
      updatedAt: nowIso(),
    })
    await writeFileAtomic(abs, serializeEntry(meta, fm.body))
    await dropStaleClaimant(ctx, 'world', abs, existing.id)
    await upsertWorldEntryFromDisk(ctx.db, ctx.workDir, abs)
    ctx.report.changed.push({ kind: 'world', id: existing.id, path: relOf(ctx, abs) })
    ctx.emit({ type: 'world.updated', entryId: existing.id })
    return
  }

  const meta = WorldEntryMeta.parse({
    id: ulid(),
    name: parseWorldEntryFileName(fileName)?.slug ?? fileName.replace(/\.md$/, ''),
    keys: [],
    image: null,
    shortSummary: null,
    createdBy: 'user',
    updatedAt: nowIso(),
  })
  await writeFileAtomic(abs, serializeEntry(meta, fm.body))
  // Re-mint: identity could not be recovered (no frontmatter, no filename short id) —
  // drop the rows of whichever entry claimed this path before (index == fullRebuild).
  await dropStaleClaimant(ctx, 'world', abs, meta.id)
  await upsertWorldEntryFromDisk(ctx.db, ctx.workDir, abs)
  ctx.report.adopted.push({ kind: 'world', id: meta.id, path: relOf(ctx, abs) })
  ctx.emit({ type: 'world.updated', entryId: meta.id })
}

async function reconcileWorldImages(ctx: Ctx): Promise<void> {
  const dirAbs = worldImagesDir(ctx.workDir)
  for (const entry of await readdirSorted(dirAbs)) {
    if (!entry.isFile() || isTmpFile(entry.name)) continue
    const c = await classify(ctx, path.join(dirAbs, entry.name))
    if (c.state === 'absent' || c.state === 'unchanged') continue
    ctx.db.upsertFile(c.row)
  }
}

// ---------------------------------------------------------------------------
// Missing on disk → drop rows + 'removed externally' (§8; no tombstones)
// ---------------------------------------------------------------------------

async function dropMissing(ctx: Ctx): Promise<void> {
  const rows = ctx.db.listFileRows()
  // section.json rows first, so whole-entity removal precedes per-file cleanup of the
  // same directory (the entity removal deletes the sibling rows in one shot).
  const ordered = [
    ...rows.filter((r) => r.path.endsWith('/section.json')),
    ...rows.filter((r) => !r.path.endsWith('/section.json')),
  ]
  for (const row of ordered) {
    if (ctx.seen.has(row.path)) continue
    if (ctx.db.getFile(row.path) === null) continue // already dropped by an earlier removal
    const abs = path.join(ctx.workDir, ...row.path.split('/'))
    try {
      await fsp.stat(abs)
      continue // exists but outside the walk (e.g. inside an unrecognized dir): keep rows
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    await handleMissingPath(ctx, row.path)
  }
}

async function handleMissingPath(ctx: Ctx, rel: string): Promise<void> {
  if (rel === 'work.json') {
    ctx.db.deleteFile(rel)
    ctx.report.removed.push({ kind: 'work', id: workId(ctx), path: rel })
    ctx.emit({ type: 'work.changed' })
    return
  }
  if (rel === 'situation.md') {
    await refreshSituation(ctx.db, ctx.workDir) // drops the row, hashes '' (§2.2)
    ctx.report.removed.push({ kind: 'work', id: workId(ctx), path: rel })
    ctx.emit({ type: 'situation.changed' })
    return
  }
  if (rel.startsWith('sections/')) {
    const dirRel = rel.slice(0, rel.lastIndexOf('/'))
    const section = ctx.db.getSectionByDirPath(dirRel) ?? undefined
    if (rel.endsWith('/section.json') && section !== undefined) {
      removeEntityRows(ctx.db, 'section', section.id)
      ctx.report.removed.push({ kind: 'section', id: section.id, path: dirRel })
      ctx.emit({ type: 'section.changed', sectionId: section.id })
      return
    }
    ctx.db.deleteFile(rel)
    if (section !== undefined) {
      // e.g. a summary or content.md deleted externally: re-derive staleness (§6.5).
      await recomputeSectionStaleness(ctx.db, ctx.workDir, section.id)
      ctx.report.changed.push({ kind: 'section', id: section.id, path: dirRel })
      ctx.emit({ type: 'section.changed', sectionId: section.id })
    }
    return
  }
  if (rel.startsWith('frontier/snippets/')) {
    const snippet = ctx.db.listSnippetRows().find((s) => s.filePath === rel)
    if (snippet !== undefined) {
      removeEntityRows(ctx.db, 'snippet', snippet.id)
      // The revision log usually survives the .md's deletion; it stays tracked as an
      // orphan (§8), exactly as fullRebuild would row it.
      await keepOrphanRevisionLogTracked(ctx, snippet.id)
      ctx.report.removed.push({ kind: 'snippet', id: snippet.id, path: rel })
      ctx.emit({ type: 'snippet.removed', snippetId: snippet.id })
    } else {
      ctx.db.deleteFile(rel)
    }
    return
  }
  if (rel.startsWith('frontier/revisions/')) {
    ctx.db.deleteFile(rel)
    const snippetId = rel.slice('frontier/revisions/'.length).replace(/\.jsonl$/, '')
    const owner = ctx.db.getSnippet(snippetId)
    // The .md file is the truth; a deleted log only resets revision_count (§9.1).
    if (owner !== null) await upsertSnippetFromDisk(ctx.db, ctx.workDir, owner.filePath)
    return
  }
  if (rel.startsWith('world/entries/')) {
    const entry = ctx.db.listWorldEntryRows().find((e) => e.filePath === rel)
    if (entry !== undefined) {
      removeEntityRows(ctx.db, 'world', entry.id)
      ctx.report.removed.push({ kind: 'world', id: entry.id, path: rel })
      ctx.emit({ type: 'world.removed', entryId: entry.id })
    } else {
      ctx.db.deleteFile(rel)
    }
    return
  }
  ctx.db.deleteFile(rel) // world/images/* and anything else: file row only
}

// ---------------------------------------------------------------------------
// Lazy filename-prefix renumbering (§4, §8) — frontmatter is authoritative
// ---------------------------------------------------------------------------

/**
 * Renumber frontier snippet filenames to `010.<shortid>.md, 020.…` in orderKey order,
 * but only when the current names disagree with that order (lazy, batched). Section-dir
 * prefixes are NOT renumbered in M1: renaming a directory invalidates every child path
 * for open external editors, which is a worse failure than a drifted human mirror.
 */
async function renumberSnippetPrefixes(ctx: Ctx): Promise<void> {
  const rows = ctx.db.listSnippetRows() // order_key order, ULID tiebreak
  if (rows.length === 0) return

  let drifted = false
  let prevPrefix = -1
  for (const row of rows) {
    const base = row.filePath.slice(row.filePath.lastIndexOf('/') + 1)
    const parsed = parseSnippetFileName(base)
    if (parsed === null || parsed.shortId !== shortId(row.id) || parsed.prefix <= prevPrefix) {
      drifted = true
      break
    }
    prevPrefix = parsed.prefix
  }
  if (!drifted) return

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (row === undefined) continue
    const finalName = snippetFileName((i + 1) * 10, row.id)
    const base = row.filePath.slice(row.filePath.lastIndexOf('/') + 1)
    if (base === finalName) continue
    // Distinct snippets always get distinct final names (the short id is embedded), so a
    // single rename pass cannot collide with another live snippet file.
    const oldAbs = path.join(ctx.workDir, ...row.filePath.split('/'))
    const newAbs = path.join(frontierSnippetsDir(ctx.workDir), finalName)
    await fsp.rename(oldAbs, newAbs)
    ctx.db.deleteFile(row.filePath)
    await upsertSnippetFromDisk(ctx.db, ctx.workDir, newAbs)
    ctx.report.renumbered++
  }
}
