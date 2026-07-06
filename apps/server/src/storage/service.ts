import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type {
  BoundaryProposal,
  EnrichmentMeta,
  IllustrationMeta,
  RevisionEvent,
  RunArtifact,
  RunEvent,
  SituationDto,
  SnippetMeta,
  WorkMeta,
} from '@cowrite/shared'
import { IllustrationMeta as IllustrationMetaSchema } from '@cowrite/shared'
import { StorageError } from './errors.js'
import { type StorageChangeListener, StorageEvents, type Unsubscribe } from './events.js'
import {
  type FtsHit,
  type IndexDb,
  needsRebuild,
  openIndex,
  type RunByArtifact,
  type SectionRow,
  type SnippetRow,
} from './index/db.js'
import {
  ingestRunFile,
  recomputeSectionStaleness,
  refreshSituation,
  removeEntityRows,
  removeFileRow,
  upsertSnippetFromDisk,
  upsertWorldEntryFromDisk,
} from './index/ingest.js'
import { fullRebuild } from './index/scan.js'
import { readIfExists, sweepTmpFiles } from './lib/fsx.js'
import { Mutex } from './lib/mutex.js'
import {
  cowriteDir,
  indexPath,
  workDir as workDirOf,
  worldImageRelPath,
  worldImageSidecarPath,
  worldImageSidecarRelPath,
} from './lib/paths.js'
import { type LockOptions, WorkLock } from './lock.js'
import { type ReconcileReport, reconcile } from './reconciler.js'
import { finalizeCrashedRuns, type RunSink, readRun, recordRun } from './runStore.js'
import * as sections from './sectionStore.js'
import * as situation from './situationStore.js'
import * as snippets from './snippetStore.js'
import { OrderKeyReservations } from './snippetStore.js'
import type {
  SectionWriteResult,
  SituationWriteResult,
  SnippetWriteResult,
  WorkSummary,
  WorldEntry,
} from './storageTypes.js'
import type { TrashedWork } from './workStore.js'
import { type CreatedWork, createWork, listWorks, readWorkMeta, trashWork } from './workStore.js'
import * as world from './worldStore.js'

/**
 * The StorageService surface (spec 02 §11): one in-process service per data dir, one
 * WorkHandle per open work. openWork = acquire lock → sweep orphaned tmp files →
 * finalize crashed runs → open-or-rebuild the index → reconcile. Every mutating call
 * runs inside the per-work FIFO mutex AND behind a lock nonce re-validation (§9.3);
 * a foreign nonce drops the handle to read-only and mutations throw ReadOnlyError.
 * Each mutation updates file + index in one call and emits the matching StorageChange.
 */

/** Thrown by every mutating call when the single-writer lock is not (or no longer) ours. */
export class ReadOnlyError extends StorageError {
  constructor(readonly slug: string) {
    super(
      `work '${slug}' is read-only: the single-writer lock is held elsewhere (spec 02 §9.3)`,
      'read_only',
      { kind: 'work', id: slug },
    )
    this.name = 'ReadOnlyError'
  }
}

/** Consolidation entry points exist on the interface but land in M1 Stage 4 (docs/10). */
export class NotImplementedError extends StorageError {
  constructor(what: string) {
    super(`${what} is not implemented yet (M1 Stage 4)`, 'not_implemented')
    this.name = 'NotImplementedError'
  }
}

export class WorkClosedError extends StorageError {
  constructor(readonly slug: string) {
    super(`work '${slug}' has been closed`, 'invalid', { kind: 'work', id: slug })
    this.name = 'WorkClosedError'
  }
}

export interface OpenWorkOptions {
  /** Lock tuning (test injection of refresh/staleness windows). */
  lock?: LockOptions
}

export interface WorkHandle {
  readonly slug: string
  readonly workDir: string
  readonly work: WorkMeta
  /** true when another live instance holds the lock, or after a nonce takeover. */
  readonly readOnly: boolean

  // situation (§2.2). The §6.6 token is the content hash; updatedAt is display-only.
  getSituation(): Promise<SituationDto>
  putSituation(text: string, opts: { baseHash: string }): Promise<SituationWriteResult>

  // sections (§2.3, §2.5, §6.5, §6.6). A vanished target — the section was deleted or
  // consolidated away while the caller worked — throws a typed SectionNotFoundError
  // (never a conflict result: the conflict shape cannot represent a missing target);
  // the API layer maps it to 404.
  listSections(): SectionRow[]
  getSectionContent(sectionId: string): Promise<{ text: string; contentHash: string }>
  replaceSectionContent(
    sectionId: string,
    text: string,
    opts: { baseHash: string | null },
  ): Promise<SectionWriteResult>
  replaceSectionSpan(
    sectionId: string,
    span: { startChar: number; endChar: number },
    text: string,
    opts: { runId?: string; baseHash: string | null },
  ): Promise<SectionWriteResult>
  setSectionTitle(
    sectionId: string,
    title: string,
    opts: { source: 'user' | 'agent' },
  ): Promise<{ applied: boolean }>
  putSummary(
    sectionId: string,
    kind: 'short' | 'long',
    text: string,
    opts: { source: 'user' | 'agent'; runId?: string },
  ): Promise<EnrichmentMeta>
  putIllustration(sectionId: string, png: Uint8Array, meta: IllustrationMeta): Promise<void>
  suppressIllustration(sectionId: string): Promise<void>
  clearSuppression(sectionId: string): Promise<void>

  // frontier (§2.4, §4, §6.1, §6.6). As with sections, a vanished target throws a typed
  // NotFound error — SnippetNotFoundError, or RevisionNotFoundError for an unknown
  // revision — for the API layer to map to 404; conflicts are returned, never thrown.
  listSnippets(): SnippetRow[]
  reserveOrderKey(): Promise<string>
  /** Release a reservation whose task ended without committing (§4). */
  releaseOrderKey(orderKey: string): void
  appendSnippet(
    text: string,
    opts: { author: 'user' | 'agent'; runId?: string; orderKey?: string },
  ): Promise<SnippetMeta>
  reviseSnippet(
    snippetId: string,
    text: string,
    opts: { author: 'user' | 'agent'; runId?: string; baseRev: number },
  ): Promise<SnippetWriteResult>
  restoreSnippet(
    snippetId: string,
    rev: number,
    opts: { author: 'user' | 'agent' },
  ): Promise<{ ok: true; rev: number; filePath: string }>
  getRevisions(snippetId: string): Promise<RevisionEvent[]>
  /** In-memory consolidation guard, fed by 03's POST /works/:w/editing route (§6.2). */
  setEditingSnippet(snippetId: string | null): void
  getEditingSnippet(): string | null

  // consolidation — API shape is stable now; the engine lands in M1 Stage 4 (docs/10)
  maybeConsolidate(guards: { taskTargetIds: string[] }): void
  applyBoundaries(
    proposal: BoundaryProposal,
    opts: { boundaryRunId: string | null },
  ): { opId: string }
  undoConsolidation(opId: string): void

  // world (§2.6)
  listWorldEntries(): Promise<WorldEntry[]>
  getWorldEntry(entryId: string): Promise<WorldEntry>
  upsertWorldEntry(input: world.WorldEntryUpsert): Promise<WorldEntry>
  deleteWorldEntry(entryId: string): Promise<void>
  matchWorldEntries(text: string): Promise<WorldEntry[]>
  putWorldImage(
    entryId: string,
    png: Uint8Array,
    meta: IllustrationMeta,
  ): Promise<{ imagePath: string }>
  listIllustrationMetas(): Promise<
    Array<{ kind: 'section' | 'world'; id: string; meta: IllustrationMeta }>
  >

  // runs (§2.7, §10.7). Deviation from the §11 one-arg spelling: the sink needs the
  // run's start instant to pick the runs/<YYYY-MM>/ shard before any event arrives.
  recordRun(runId: string, startedAtIso: string): Promise<RunSink>
  readRun(runId: string): Promise<RunEvent[]>
  queryRunsByArtifact(kind: RunArtifact['kind'], artifactId: string): RunByArtifact[]

  // maintenance & events (§7.3, §8, §11)
  reconcile(): Promise<ReconcileReport>
  rebuildIndex(): Promise<void>
  search(query: string): FtsHit[]
  onChange(listener: StorageChangeListener): Unsubscribe
  close(): Promise<void>
}

export interface StorageService {
  /** Scans every `<dataDir>/works/<slug>/work.json`; broken works surface as warnings (§11). */
  listWorks(): Promise<WorkSummary[]>
  createWork(title: string): Promise<CreatedWork>
  /** Move the whole work dir to `<dataDir>/.trash/` — never a hard delete (§5.2). */
  trashWork(slug: string): Promise<TrashedWork>
  openWork(slug: string, opts?: OpenWorkOptions): Promise<WorkHandle>
}

export function createStorage(dataDir: string): StorageService {
  return {
    listWorks: () => listWorks(dataDir),
    createWork: (title) => createWork(dataDir, title),
    trashWork: (slug) => trashWork(dataDir, slug),
    openWork: (slug, opts) => openWork(dataDir, slug, opts),
  }
}

async function removeIndexFiles(idxPath: string): Promise<void> {
  for (const suffix of ['', '-wal', '-shm']) {
    await fsp.rm(`${idxPath}${suffix}`, { force: true })
  }
}

export async function openWork(
  dataDir: string,
  slug: string,
  opts: OpenWorkOptions = {},
): Promise<WorkHandle> {
  const dir = workDirOf(dataDir, slug)
  const work = await readWorkMeta(dir) // throws for an unknown or broken work

  let readOnly = false
  let closed = false
  let editingSnippetId: string | null = null
  const events = new StorageEvents()
  const mutex = new Mutex()
  const reservations = new OrderKeyReservations()

  const callerStandDown = opts.lock?.onStandDown
  const acquired = await WorkLock.acquire(dir, {
    ...opts.lock,
    onStandDown: () => {
      readOnly = true
      callerStandDown?.()
    },
  })
  const lock = acquired.acquired ? acquired.lock : null
  if (lock === null) readOnly = true

  // §11 open lifecycle (writer only — a read-only opener must not write anything the
  // live writer owns): sweep tmp orphans (§9.1), finalize crashed runs (§10.7), then
  // open-or-rebuild the index (§7.3). Deviation from §11 pending Stage 4: the
  // pending-ops.json journal replay slots in here once consolidation (the only journal
  // writer) exists — until then there is never a journal to replay.
  const idxPath = indexPath(dir)
  const openOrRebuildIndex = async (): Promise<IndexDb> => {
    if (!readOnly) {
      await sweepTmpFiles(dir, true)
      const { finalized } = await finalizeCrashedRuns(dir)
      if (needsRebuild(idxPath)) {
        await removeIndexFiles(idxPath)
        const fresh = openIndex(idxPath)
        try {
          await fullRebuild(fresh, dir) // also ingests the freshly finalized runs
        } catch (err) {
          fresh.close()
          throw err
        }
        return fresh
      }
      const opened = openIndex(idxPath)
      try {
        // Runs are outside the reconciler's walk set (§8), so on a HEALTHY index the
        // crash results synthesized above must be re-ingested here — otherwise those
        // agent_runs rows keep status NULL forever (§7.3, §10.7).
        for (const run of finalized) await ingestRunFile(opened, dir, run.filePath)
      } catch (err) {
        opened.close()
        throw err
      }
      return opened
    }
    if (needsRebuild(idxPath)) {
      // No healthy on-disk index and we may not create one: rebuild into a private
      // in-memory index; reads still answer purely from files (§1).
      const mem = openIndex(':memory:')
      try {
        await fullRebuild(mem, dir)
      } catch (err) {
        mem.close()
        throw err
      }
      return mem
    }
    return openIndex(idxPath) // WAL: a second reader connection sees the writer's commits
  }

  let db: IndexDb
  try {
    db = await openOrRebuildIndex()
  } catch (err) {
    // A failed open must not leak the held lock, its 30 s refresh timer, or a db
    // handle — that would force every later in-process open of this work read-only.
    await lock?.release().catch(() => {})
    throw err
  }

  const guardWritable = async (): Promise<void> => {
    if (closed) throw new WorkClosedError(slug)
    if (readOnly || lock === null) throw new ReadOnlyError(slug)
    if (!(await lock.revalidateNonce())) {
      readOnly = true
      throw new ReadOnlyError(slug)
    }
  }
  /** Per-work FIFO mutex + §9.3 nonce guard around every write batch. */
  const mutate = <T>(fn: () => Promise<T>): Promise<T> =>
    mutex.runExclusive(async () => {
      await guardWritable()
      return fn()
    })

  /** Re-index one snippet. Callers that already know the written file (revise/restore
   *  return it) pass it in; otherwise readSnippet resolves it (index-hint fast path). */
  const indexSnippet = async (snippetId: string, filePath?: string): Promise<void> => {
    const resolved =
      filePath ??
      (await snippets.readSnippet(dir, snippetId, db.getSnippet(snippetId)?.filePath)).filePath
    await upsertSnippetFromDisk(db, dir, resolved)
  }
  const reindexSection = async (sectionId: string): Promise<void> => {
    await recomputeSectionStaleness(db, dir, sectionId)
  }
  /** Index-row dir_path hint so section stores skip the whole-tree walk (§7.3). */
  const sectionDirHint = (sectionId: string): string | undefined =>
    db.getSection(sectionId)?.dirPath
  const snippetPathHint = (snippetId: string): string | undefined =>
    db.getSnippet(snippetId)?.filePath

  const handle: WorkHandle = {
    slug,
    workDir: dir,
    work,
    get readOnly() {
      return readOnly
    },

    // -- situation ----------------------------------------------------------
    getSituation: () => situation.getSituation(dir),
    putSituation: (text, o) =>
      mutate(async () => {
        const res = await situation.putSituation(dir, text, o)
        if (res.ok) {
          await refreshSituation(db, dir)
          events.emit({ type: 'situation.changed' })
        }
        return res
      }),

    // -- sections -------------------------------------------------------------
    listSections: () => db.listSectionRows(),
    getSectionContent: (id) => sections.getSectionContent(dir, id, sectionDirHint(id)),
    replaceSectionContent: (id, text, o) =>
      mutate(async () => {
        const res = await sections.replaceSectionContent(dir, id, text, o, sectionDirHint(id))
        if (res.ok) {
          await reindexSection(id)
          events.emit({ type: 'section.changed', sectionId: id })
        }
        return res
      }),
    replaceSectionSpan: (id, span, text, o) =>
      mutate(async () => {
        const res = await sections.replaceSectionSpan(dir, id, span, text, o, sectionDirHint(id))
        if (res.ok) {
          await reindexSection(id)
          events.emit({ type: 'section.changed', sectionId: id })
        }
        return res
      }),
    setSectionTitle: (id, title, o) =>
      mutate(async () => {
        const res = await sections.setSectionTitle(dir, id, title, o, sectionDirHint(id))
        if (res.applied) {
          await reindexSection(id)
          events.emit({ type: 'enrichment.updated', sectionId: id, enrichment: 'title' })
        }
        return res
      }),
    putSummary: (id, kind, text, o) =>
      mutate(async () => {
        const meta = await sections.putSummary(dir, id, kind, text, o, sectionDirHint(id))
        await reindexSection(id)
        events.emit({
          type: 'enrichment.updated',
          sectionId: id,
          enrichment: kind === 'short' ? 'shortSummary' : 'longSummary',
        })
        return meta
      }),
    putIllustration: (id, png, meta) =>
      mutate(async () => {
        await sections.putIllustration(dir, id, png, meta, sectionDirHint(id))
        await reindexSection(id)
        events.emit({ type: 'enrichment.updated', sectionId: id, enrichment: 'illustration' })
      }),
    suppressIllustration: (id) =>
      mutate(async () => {
        await sections.suppressIllustration(dir, id, sectionDirHint(id))
        await reindexSection(id)
        events.emit({ type: 'enrichment.updated', sectionId: id, enrichment: 'illustration' })
      }),
    clearSuppression: (id) =>
      mutate(async () => {
        await sections.clearSuppression(dir, id, sectionDirHint(id))
        await reindexSection(id)
        events.emit({ type: 'enrichment.updated', sectionId: id, enrichment: 'illustration' })
      }),

    // -- frontier ----------------------------------------------------------------
    listSnippets: () => db.listSnippetRows(),
    reserveOrderKey: () => mutate(() => snippets.reserveOrderKey(dir, reservations)),
    releaseOrderKey: (orderKey) => {
      reservations.release(orderKey)
    },
    appendSnippet: (text, o) =>
      mutate(async () => {
        const meta = await snippets.appendSnippet(dir, text, { ...o, reservations })
        await indexSnippet(meta.id)
        events.emit({ type: 'snippet.created', snippetId: meta.id })
        return meta
      }),
    reviseSnippet: (id, text, o) =>
      mutate(async () => {
        const res = await snippets.reviseSnippet(dir, id, text, {
          ...o,
          filePathHint: snippetPathHint(id),
        })
        if (res.ok) {
          await indexSnippet(id, res.filePath)
          events.emit({ type: 'snippet.updated', snippetId: id })
        }
        return res
      }),
    restoreSnippet: (id, rev, o) =>
      mutate(async () => {
        const res = await snippets.restoreSnippet(dir, id, rev, {
          ...o,
          filePathHint: snippetPathHint(id),
        })
        await indexSnippet(id, res.filePath)
        events.emit({ type: 'snippet.updated', snippetId: id })
        return res
      }),
    getRevisions: (id) => snippets.getRevisions(dir, id),
    setEditingSnippet: (id) => {
      editingSnippetId = id
    },
    getEditingSnippet: () => editingSnippetId,

    // -- consolidation (M1 Stage 4) ------------------------------------------------
    maybeConsolidate: () => {
      throw new NotImplementedError('maybeConsolidate')
    },
    applyBoundaries: () => {
      throw new NotImplementedError('applyBoundaries')
    },
    undoConsolidation: () => {
      throw new NotImplementedError('undoConsolidation')
    },

    // -- world -----------------------------------------------------------------------
    listWorldEntries: () => world.listWorldEntries(dir),
    getWorldEntry: (id) => world.getWorldEntry(dir, id),
    upsertWorldEntry: (input) =>
      mutate(async () => {
        const entry = await world.upsertWorldEntry(dir, input)
        await upsertWorldEntryFromDisk(db, dir, entry.filePath)
        events.emit({ type: 'world.updated', entryId: entry.meta.id })
        return entry
      }),
    deleteWorldEntry: (id) =>
      mutate(async () => {
        await world.deleteWorldEntry(dir, id)
        removeEntityRows(db, 'world', id)
        removeFileRow(db, dir, worldImageRelPath(id))
        removeFileRow(db, dir, worldImageSidecarRelPath(id))
        events.emit({ type: 'world.removed', entryId: id })
      }),
    matchWorldEntries: async (text) =>
      world.matchWorldEntries(await world.listWorldEntries(dir), text),
    putWorldImage: (id, png, meta) =>
      mutate(async () => {
        const res = await world.putWorldImage(dir, id, png, meta)
        const entry = await world.getWorldEntry(dir, id)
        await upsertWorldEntryFromDisk(db, dir, entry.filePath)
        events.emit({ type: 'world.updated', entryId: id })
        return res
      }),
    listIllustrationMetas: async () => {
      const out: Array<{ kind: 'section' | 'world'; id: string; meta: IllustrationMeta }> = []
      for (const node of await sections.walkSectionTree(dir)) {
        const slot = node.meta.enrichments.illustration
        if (slot !== null && !('suppressed' in slot)) {
          out.push({ kind: 'section', id: node.meta.id, meta: slot })
        }
      }
      for (const entry of await world.listWorldEntries(dir)) {
        if (entry.meta.image === null) continue
        const raw = await readIfExists(worldImageSidecarPath(dir, entry.meta.id))
        if (raw === null) continue
        try {
          const meta = IllustrationMetaSchema.parse(JSON.parse(raw))
          out.push({ kind: 'world', id: entry.meta.id, meta })
        } catch {
          // a hand-mangled sidecar hides its meta but must not break the listing
        }
      }
      return out
    },

    // -- runs ---------------------------------------------------------------------------
    recordRun: async (runId, startedAtIso) => {
      const sink = await mutate(() => recordRun(dir, runId, startedAtIso))
      // Wrap the sink so index ingestion and the run.recorded event ride the same
      // mutex + nonce guard as every other write (§11).
      return {
        filePath: sink.filePath,
        get closed() {
          return sink.closed
        },
        append: (event: RunEvent) =>
          mutate(async () => {
            await sink.append(event)
            if (event.type === 'meta' || event.type === 'result') {
              await ingestRunFile(db, dir, sink.filePath)
            }
            if (event.type === 'result') events.emit({ type: 'run.recorded', runId })
          }),
      }
    },
    readRun: (runId) => readRun(dir, runId),
    queryRunsByArtifact: (kind, artifactId) => db.runsByArtifact(kind, artifactId),

    // -- maintenance & events ---------------------------------------------------------
    reconcile: () => mutate(() => reconcile({ workDir: dir, db, emit: (e) => events.emit(e) })),
    rebuildIndex: () =>
      mutate(async () => {
        // Reads (listSections & co.) are synchronous and un-mutexed, so the live db must
        // keep serving them for the whole rebuild: build the replacement into a sibling
        // path first, then swap it in WITHOUT yielding to the event loop — better-sqlite3
        // is fully synchronous, so a no-await close/rename/reopen window is invisible to
        // readers (§7.3).
        const buildPath = `${idxPath}.rebuild`
        for (const suffix of ['', '-wal', '-shm']) {
          fs.rmSync(`${buildPath}${suffix}`, { force: true })
        }
        const next = openIndex(buildPath)
        try {
          await fullRebuild(next, dir)
        } catch (err) {
          next.close()
          for (const suffix of ['', '-wal', '-shm']) {
            fs.rmSync(`${buildPath}${suffix}`, { force: true })
          }
          throw err
        }
        next.close() // checkpoints; the -wal/-shm siblings are gone after this
        db.close()
        for (const suffix of ['', '-wal', '-shm']) {
          fs.rmSync(`${idxPath}${suffix}`, { force: true })
          if (fs.existsSync(`${buildPath}${suffix}`)) {
            fs.renameSync(`${buildPath}${suffix}`, `${idxPath}${suffix}`)
          }
        }
        db = openIndex(idxPath)
      }),
    search: (query) => db.ftsSearch(query),
    onChange: (listener) => events.on(listener),

    close: () =>
      mutex.runExclusive(async () => {
        if (closed) return
        closed = true
        if (lock?.isValid) {
          // §9.4: the undo grace window does not survive a close.
          await fsp.rm(path.join(cowriteDir(dir), 'undo'), { recursive: true, force: true })
        }
        await lock?.release()
        db.close()
      }),
  }

  // §8: reconcile at work open (writer only — reconciliation writes frontmatter back).
  if (!readOnly) {
    try {
      await handle.reconcile()
    } catch (err) {
      // Same rule as above: a failed open leaks nothing — close() releases the lock,
      // stops its refresh timer, and closes the db before we rethrow.
      await handle.close().catch(() => {})
      throw err
    }
  }

  return handle
}
