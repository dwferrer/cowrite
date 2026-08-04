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
  WorkSettings,
} from '@cowrite/shared'
import {
  IllustrationMeta as IllustrationMetaSchema,
  WorkMeta as WorkMetaSchema,
} from '@cowrite/shared'
import {
  applyPlannedOp,
  applyPlannedOpWithRollback,
  computeEligiblePrefix,
  DeferralBackoff,
  effectiveThresholds,
  heuristicBoundaryIds,
  type PlannedBoundary,
  planConsolidation,
  purgeAppliedOp,
  type ReplayResult,
  replayPendingOp,
  undoAppliedOp,
} from './consolidation.js'
import { StorageError } from './errors.js'
import { type StorageChangeListener, StorageEvents, type Unsubscribe } from './events.js'
import {
  type FtsHit,
  type IndexDb,
  needsRebuild,
  openIndex,
  type RunByArtifact,
  readWorkCounts,
  type SectionRow,
  type SnippetRow,
  type WorkCounts,
} from './index/db.js'
import {
  fileRowFor,
  ingestRunFile,
  recomputeSectionStaleness,
  refreshSituation,
  removeEntityRows,
  removeFileRow,
  toWorkRelative,
  upsertSectionFromDisk,
  upsertSnippetFromDisk,
  upsertWorldEntryFromDisk,
} from './index/ingest.js'
import { fullRebuild } from './index/scan.js'
import { type PendingOp, readPendingOp, writePendingOp } from './journal.js'
import { readIfExists, sweepTmpFiles } from './lib/fsx.js'
import { Mutex } from './lib/mutex.js'
import {
  frontierSnippetsDir,
  indexPath,
  sectionsDir,
  workDir as workDirOf,
  workMetaPath,
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
  SnippetFile,
  SnippetWithText,
  SnippetWriteResult,
  WorkListing,
  WorldEntry,
  WorldEntryWriteResult,
} from './storageTypes.js'
import type { TrashedWork } from './workStore.js'
import {
  type CreatedWork,
  createWork,
  listWorks,
  readWorkMeta,
  trashWork,
  writeWorkMeta,
} from './workStore.js'
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

/** Interface-stable entry points whose subsystem has not landed yet (docs/10 stages). */
export class NotImplementedError extends StorageError {
  constructor(what: string) {
    super(`${what} is not implemented yet (see docs/10-roadmap.md)`, 'not_implemented')
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
  /**
   * Sink for the §6.3 log-only consolidation notice ("long frontier — consider
   * splitting manually"); NOT a WorkEvent — the client renders nothing in MVP.
   * Defaults to console.warn.
   */
  onNotice?: (message: string) => void
}

// ---------------------------------------------------------------------------
// Consolidation seam (02 §6.2–§6.4). The harness scheduler (05 §scheduler) is the ONE
// caller: it debounces frontier writes, supplies the live-task guard ids, runs the
// boundary agent, and drives apply/undo. Storage owns the evaluation (thresholds,
// active window, eligible prefix), the scene-break heuristic, the in-memory deferral
// back-off, and the journaled apply/undo with its grace window.
// ---------------------------------------------------------------------------

export interface ConsolidationGuards {
  /** Snippet ids targeted by queued/running tasks — excluded from the prefix (05 §5.6). */
  taskTargetIds: string[]
  /** "Consolidate now": skip the threshold gate; the eligibility guards still apply. */
  force?: boolean
}

export type ConsolidationEvaluation =
  /** Below thresholds, or no eligible prefix after exclusions — nothing to do. */
  | { status: 'idle' }
  /** Over thresholds with an eligible prefix: run the boundary agent over these ids. */
  | { status: 'needs-boundaries'; eligibleSnippetIds: string[] }
  /** A §6.3 rule-1 scene-break split applied immediately — no boundary agent needed. */
  | ({ status: 'applied' } & ConsolidationApplied)

export interface ConsolidationApplied {
  /** The journal opId — doubles as the undo token (02 §6.4, 03 §3.8). */
  opId: string
  /** The newly created (frozen) section ids, in document order. */
  sectionIds: string[]
  /** ISO instant the undo grace window closes (§6.4 step 4). */
  undoDeadline: string
}

export type ApplyBoundariesResult =
  | ({ ok: true } & ConsolidationApplied)
  /** §6.3: every proposed boundary fell outside the eligible prefix (or none were
   *  proposed) — consolidation defers and the in-memory back-off grows. */
  | { ok: false; deferred: true; droppedBoundaries: number }

/** The op currently inside its undo grace window, if any (drives 03 §3.8's undo route). */
export interface PendingConsolidation {
  opId: string
  sectionIds: string[]
  undoDeadline: string | null
}

/** Thrown by undoConsolidation when the token is unknown, expired, or already undone —
 *  the API layer maps the 'conflict' code to the 409 of 03 §3.8. */
export class ConsolidationUndoExpiredError extends StorageError {
  constructor(readonly opId: string) {
    super(
      `consolidation ${opId} cannot be undone: the undo grace window has expired or the token is unknown (spec 02 §6.4)`,
      'conflict',
      { kind: 'consolidation', id: opId },
    )
    this.name = 'ConsolidationUndoExpiredError'
  }
}

export interface WorkHandle {
  readonly slug: string
  readonly workDir: string
  /** Current validated work.json metadata; refreshed by updateWork. */
  readonly work: WorkMeta
  /** true when another live instance holds the lock, or after a nonce takeover. */
  readonly readOnly: boolean
  /** ISO instant of the last completed reconcile on this handle; null before the first. */
  readonly lastReconcileAt: string | null

  /** Validated title/settings patch of work.json (03 §3.1 PATCH) + 'work.changed'. */
  updateWork(patch: { title?: string; settings?: WorkSettings }): Promise<WorkMeta>

  // situation (§2.2). The §6.6 token is the content hash; updatedAt is display-only.
  getSituation(): Promise<SituationDto>
  putSituation(text: string, opts: { baseHash: string }): Promise<SituationWriteResult>

  // sections (§2.3, §2.5, §6.5, §6.6). A vanished target — the section was deleted or
  // consolidated away while the caller worked — throws a typed SectionNotFoundError
  // (never a conflict result: the conflict shape cannot represent a missing target);
  // the API layer maps it to 404.
  listSections(): SectionRow[]
  /** THE §6.5 staleness query (index-derived): scope 'summary' returns leaf sections
   *  with stale/missing summaries — the enrichment sweep's queue; 'any' (default)
   *  includes illustration staleness for Stage 5. */
  staleSections(scope?: 'summary' | 'any'): SectionRow[]
  /** One index row by id (point lookup, no file I/O); null for an unknown section. */
  getSection(sectionId: string): SectionRow | null
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
  getSummaries(sectionId: string): Promise<{ short: string | null; long: string | null }>
  putSummary(
    sectionId: string,
    kind: 'short' | 'long',
    text: string,
    opts: {
      source: 'user' | 'agent'
      runId?: string
      /** Agent commits: the ASSEMBLY-TIME contentHash the summary was derived from
       *  (02 §6.5); absent (user edits) the current content.md is hashed at commit. */
      sourceHash?: string
    },
  ): Promise<EnrichmentMeta>
  putIllustration(sectionId: string, png: Uint8Array, meta: IllustrationMeta): Promise<void>
  suppressIllustration(sectionId: string): Promise<void>
  clearSuppression(sectionId: string): Promise<void>
  /**
   * Absolute PNG path + version (content hash) for streaming the section illustration
   * (03 §3.9) — the route does its containment check, then streams. null when the
   * section has no illustration, including the §2.5 suppressed tombstone. Throws
   * SectionNotFoundError for an unknown section.
   */
  sectionIllustrationPath(sectionId: string): { absPath: string; version: string } | null

  // frontier (§2.4, §4, §6.1, §6.6). As with sections, a vanished target throws a typed
  // NotFound error — SnippetNotFoundError, or RevisionNotFoundError for an unknown
  // revision — for the API layer to map to 404; conflicts are returned, never thrown.
  listSnippets(): SnippetRow[]
  /** Rows + full text + revisionCount in orderKey order — the SnippetDto list (03 §3.3). */
  listSnippetsWithText(): Promise<SnippetWithText[]>
  /** One snippet row + full text. Throws SnippetNotFoundError for the API's 404. */
  getSnippet(snippetId: string): Promise<SnippetWithText>
  /** Remove the snippet file AND its revision log (03 §3.3); emits 'snippet.removed'. */
  deleteSnippet(snippetId: string): Promise<void>
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

  // consolidation (§6.2–§6.4). All three run under the work mutex; applying while a
  // previous op is still inside its grace window finalizes (purges) that op first —
  // pending-ops.json holds exactly one op (§5.2).
  /**
   * The §6.2 trigger + eligibility evaluation, called by the scheduler after its 30 s
   * debounce (and by "Consolidate now" with `force`). When the eligible prefix contains
   * explicit scene-break markers, the split is applied immediately (§6.3 rule 1) and
   * `status: 'applied'` is returned; otherwise the caller runs the boundary agent over
   * `eligibleSnippetIds` and feeds its proposal to `applyBoundaries`.
   */
  maybeConsolidate(guards: ConsolidationGuards): Promise<ConsolidationEvaluation>
  /**
   * Validate a BoundaryProposal against the CURRENT eligible prefix (§6.3: out-of-prefix
   * boundaries are dropped; all-dropped/none ⇒ deferral) and run the §6.4 journaled
   * apply. Emits `sections.restructured` + `consolidation.applied` and starts the undo
   * grace timer. The §6.6 conflict story is fold-in, not conflict: snippets edited
   * between plan and apply are re-read under the mutex and the newer text wins.
   */
  applyBoundaries(
    proposal: BoundaryProposal,
    opts: { boundaryRunId: string | null; taskTargetIds?: string[] },
  ): Promise<ApplyBoundariesResult>
  /**
   * Reverse-replay an applied op inside its grace window (§6.4). CONTRACT: the caller
   * (harness) must first cancel queued/running enrich-section / illustrate-section
   * tasks targeting `pendingConsolidation().sectionIds` via its cancel-by-target hook
   * (05 §6.2) — storage never calls the harness, and an enrichment run must never
   * write into a directory being deleted. Throws ConsolidationUndoExpiredError (409)
   * when the token is unknown or the window is gone.
   */
  undoConsolidation(opId: string): Promise<void>
  /** The op currently inside its undo grace window; null when idle. */
  pendingConsolidation(): Promise<PendingConsolidation | null>
  /**
   * Record a boundary-agent deferral that never reached applyBoundaries (garbage or
   * unreachable endpoint, 05 §6.5): grows the same in-memory back-off (§6.3).
   */
  noteBoundaryDeferral(reason: string): void

  // world (§2.6). upsert honors the optional §6.6-style baseHash token (body hash);
  // without one it stays last-write-wins, and a conflict is returned, never thrown.
  listWorldEntries(): Promise<WorldEntry[]>
  getWorldEntry(entryId: string): Promise<WorldEntry>
  upsertWorldEntry(input: world.WorldEntryUpsert): Promise<WorldEntryWriteResult>
  deleteWorldEntry(entryId: string): Promise<void>
  matchWorldEntries(text: string): Promise<WorldEntry[]>
  putWorldImage(
    entryId: string,
    png: Uint8Array,
    meta: IllustrationMeta,
  ): Promise<{ imagePath: string }>
  /**
   * Clear the entry's image pointer and remove the PNG + sidecar (03 §3.5 DELETE):
   * NotFound for an unknown entry, idempotent no-op when there is no image, one
   * `world.updated` when something actually changed.
   */
  deleteWorldImage(entryId: string): Promise<void>
  /**
   * Absolute PNG path + version (content hash from the index files table) for streaming
   * the world image (03 §3.9). null when the entry has no image (or the referenced file
   * vanished). Throws WorldEntryNotFoundError for an unknown entry.
   */
  worldImagePath(entryId: string): { absPath: string; version: string } | null
  listIllustrationMetas(): Promise<
    Array<{ kind: 'section' | 'world'; id: string; meta: IllustrationMeta }>
  >

  // runs (§2.7, §10.7). Deviation from the §11 one-arg spelling: the sink needs the
  // run's start instant to pick the runs/<YYYY-MM>/ shard before any event arrives.
  recordRun(runId: string, startedAtIso: string): Promise<RunSink>
  readRun(runId: string): Promise<RunEvent[]>
  queryRunsByArtifact(kind: RunArtifact['kind'], artifactId: string): RunByArtifact[]

  /** The works-list/WorkDetail aggregates straight off the index (03 §3.1). */
  workCounts(): WorkCounts

  // maintenance & events (§7.3, §8, §11). reconcile is timer-safe: it runs behind the
  // per-work mutex, and unchanged files take the (size, mtime) no-read fast path, so a
  // 30 s cadence on an idle work costs one stat sweep and writes nothing (§8).
  reconcile(): Promise<ReconcileReport>
  rebuildIndex(): Promise<void>
  search(query: string): FtsHit[]
  onChange(listener: StorageChangeListener): Unsubscribe
  close(): Promise<void>
}

export interface StorageService {
  /**
   * Scans every `<dataDir>/works/<slug>/work.json`; broken works surface as warnings
   * (§11). Healthy entries carry the work id (meta.id) plus cheap counts read from the
   * work's existing index via a read-only open — no work lock, no reconcile; counts are
   * null when the index is absent, stale-versioned, or unreadable (works-list screen).
   */
  listWorks(): Promise<WorkListing[]>
  createWork(title: string): Promise<CreatedWork>
  /** Move the whole work dir to `<dataDir>/.trash/` — never a hard delete (§5.2). */
  trashWork(slug: string): Promise<TrashedWork>
  openWork(slug: string, opts?: OpenWorkOptions): Promise<WorkHandle>
}

export function createStorage(dataDir: string): StorageService {
  return {
    listWorks: async () => {
      const works = await listWorks(dataDir)
      return works.map((w) =>
        w.ok ? { ...w, counts: readWorkCounts(indexPath(workDirOf(dataDir, w.slug))) } : w,
      )
    },
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
  let workMeta = await readWorkMeta(dir) // throws for an unknown or broken work

  let readOnly = false
  let closed = false
  let editingSnippetId: string | null = null
  let lastReconcileAt: string | null = null
  const events = new StorageEvents()
  const mutex = new Mutex()
  const reservations = new OrderKeyReservations()
  const backoff = new DeferralBackoff()
  const onNotice = opts.onNotice ?? ((message: string) => console.warn(message))
  let graceTimer: NodeJS.Timeout | null = null
  const clearGraceTimer = (): void => {
    if (graceTimer !== null) {
      clearTimeout(graceTimer)
      graceTimer = null
    }
  }

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
  // live writer owns): sweep tmp orphans (§9.1), REPLAY the pending-ops journal (§9.2 —
  // before the index opens or rebuilds, so both see the post-replay tree), finalize
  // crashed runs (§10.7), then open-or-rebuild the index (§7.3).
  const idxPath = indexPath(dir)
  const openOrRebuildIndex = async (): Promise<IndexDb> => {
    if (!readOnly) {
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
  let replayed: ReplayResult | null = null
  try {
    if (!readOnly) {
      await sweepTmpFiles(dir, true)
      replayed = await replayPendingOp(dir, workMeta.settings.consolidation.undoGraceMs)
    }
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

  // -- consolidation machinery (§6.2–§6.4) -----------------------------------------

  const deepestKind = (): string =>
    workMeta.levelScheme[workMeta.levelScheme.length - 1] ?? 'chapter'
  /** A kind outside the level scheme (agent error) falls back to the deepest level. */
  const normalizeKind = (kind: string): string =>
    workMeta.levelScheme.includes(kind) ? kind : deepestKind()

  const recordDeferral = (reason: string): void => {
    const { noticeDue } = backoff.recordDeferral(workMeta.settings.consolidation.debounceMs)
    if (noticeDue) {
      // §6.3: a LOG-ONLY notice, deliberately not a WorkEvent — the client renders
      // nothing in MVP.
      onNotice(
        `work '${slug}': consolidation deferred ${backoff.consecutiveDeferrals}x (${reason}) — ` +
          'long frontier; consider splitting manually (spec 02 §6.3)',
      )
    }
  }

  /** (Re)arm the §6.4 grace-expiry timer for an applied op; purges on the deadline. */
  const scheduleGraceExpiry = (op: PendingOp): void => {
    clearGraceTimer()
    const deadline = op.expiresAt === null ? Date.now() : Date.parse(op.expiresAt)
    const timer = setTimeout(
      () => {
        graceTimer = null
        void mutate(async () => {
          const current = await readPendingOp(dir)
          if (current !== null && current.opId === op.opId && current.phase === 'applied') {
            await purgeAppliedOp(dir, current)
            events.emit({ type: 'consolidation.finalized', opId: current.opId })
          }
        }).catch(() => {
          // closed or lost the lock mid-expiry: the next opener resumes/purges (§9.2)
        })
      },
      Math.max(0, deadline - Date.now()),
    )
    timer.unref?.()
    graceTimer = timer
  }

  /** Index update for an applied op: consumed snippets out, new sections in (reusing
   *  the ingest loaders — a full rebuild reproduces this state, §7.3/§8). */
  const indexAppliedOp = async (applied: PendingOp): Promise<void> => {
    for (const section of applied.sections) {
      for (const snip of section.snippets) removeEntityRows(db, 'snippet', snip.snippetId)
    }
    for (const section of applied.sections) {
      await upsertSectionFromDisk(db, dir, path.join(sectionsDir(dir), section.dirName))
    }
  }

  /** Plan + journal + §6.4 apply for validated boundaries. Caller holds the mutex. */
  const applyConsolidation = async (
    files: SnippetFile[],
    boundaries: PlannedBoundary[],
    boundaryRunId: string | null,
  ): Promise<ConsolidationApplied> => {
    // pending-ops.json holds exactly one op (§5.2): applying while a previous op is
    // still inside its grace window finalizes (purges) that op first. A previous op
    // still at 'planned' (a live-process apply crashed mid-way and its rollback failed
    // too) must be ROLLED FORWARD first — purging a planned journal would delete the
    // staged originals and let the same frontier prose consolidate twice (§9.2).
    const previous = await readPendingOp(dir)
    if (previous !== null) {
      clearGraceTimer()
      let finished = previous
      if (previous.phase === 'planned') {
        finished = await applyPlannedOp(dir, previous, workMeta.settings.consolidation.undoGraceMs)
        await indexAppliedOp(finished)
        events.emit({ type: 'sections.restructured' })
      }
      await purgeAppliedOp(dir, finished)
      events.emit({ type: 'consolidation.finalized', opId: finished.opId })
    }
    const planned = await planConsolidation(dir, files, boundaries, { boundaryRunId })
    await writePendingOp(dir, planned)
    // A thrown apply rolls back immediately (reverse replay); only if the rollback
    // fails too does the planned journal survive for openWork's §9.2 replay.
    const applied = await applyPlannedOpWithRollback(
      dir,
      planned,
      workMeta.settings.consolidation.undoGraceMs,
    )
    await indexAppliedOp(applied)
    backoff.reset()
    scheduleGraceExpiry(applied)
    const sectionIds = applied.sections.map((s) => s.sectionId)
    const undoDeadline = applied.expiresAt ?? new Date().toISOString()
    events.emit({ type: 'sections.restructured' })
    events.emit({
      type: 'consolidation.applied',
      opId: applied.opId,
      sectionIds,
      undoToken: applied.opId,
      undoDeadline,
    })
    return { opId: applied.opId, sectionIds, undoDeadline }
  }

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

  /** Join a parsed snippet file with its index row into the text-carrying read shape.
   *  The file is the truth for meta/text; revisionCount comes from the index row, with
   *  a log-line-count fallback when the row is missing (index is only a cache, §7.3). */
  const snippetWithText = async (
    file: SnippetFile,
    row: SnippetRow | null,
  ): Promise<SnippetWithText> => ({
    id: file.meta.id,
    orderKey: file.meta.orderKey,
    authorship: file.meta.authorship,
    originRunId: file.meta.originRunId,
    rev: file.meta.rev,
    revisionCount:
      row?.revisionCount ?? Math.max((await snippets.getRevisions(dir, file.meta.id)).length, 1),
    wordCount: file.wordCount,
    updatedAt: file.meta.updatedAt,
    filePath: toWorkRelative(dir, file.filePath),
    text: file.text,
  })

  const handle: WorkHandle = {
    slug,
    workDir: dir,
    get work() {
      return workMeta
    },
    get readOnly() {
      return readOnly
    },
    get lastReconcileAt() {
      return lastReconcileAt
    },

    updateWork: (patch) =>
      mutate(async () => {
        const next = WorkMetaSchema.parse({
          ...workMeta,
          ...(patch.title === undefined ? {} : { title: patch.title }),
          ...(patch.settings === undefined ? {} : { settings: patch.settings }),
        })
        await writeWorkMeta(dir, next)
        workMeta = next
        // Index meta + files-row refresh, so the next reconcile does not re-report our
        // own write as an external change (§8 walk set includes work.json).
        const fileRow = await fileRowFor(dir, workMetaPath(dir))
        db.transaction(() => {
          db.setMeta('workId', next.id)
          db.setMeta('levelScheme', JSON.stringify(next.levelScheme))
          if (fileRow) db.upsertFile(fileRow)
        })
        if (patch.settings !== undefined) {
          // illustrationStaleWordDeltaPct feeds §6.5 staleness — re-derive every section.
          for (const row of db.listSectionRows()) {
            await recomputeSectionStaleness(db, dir, row.id)
          }
        }
        events.emit({ type: 'work.changed' })
        return next
      }),

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
    staleSections: (scope) => db.staleSections(scope),
    getSection: (id) => db.getSection(id),
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
    getSummaries: (id) => sections.getSummaries(dir, id, sectionDirHint(id)),
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
    sectionIllustrationPath: (id) => {
      const row = db.getSection(id)
      if (row === null) throw new sections.SectionNotFoundError(id)
      // illustration_hash is only set when a PNG exists — absent and suppressed
      // (tombstoned, PNG deleted) both read as null (03 §3.9: 404 either way).
      if (row.illustrationHash === null) return null
      return {
        absPath: path.join(dir, ...row.dirPath.split('/'), 'illustration.png'),
        version: row.illustrationHash,
      }
    },

    // -- frontier ----------------------------------------------------------------
    listSnippets: () => db.listSnippetRows(),
    listSnippetsWithText: async () => {
      // Files are the truth for text and order (§1); index rows contribute the cached
      // revisionCount and are matched by id.
      const rows = new Map(db.listSnippetRows().map((r) => [r.id, r]))
      const files = await snippets.listSnippetFiles(dir)
      return Promise.all(files.map((f) => snippetWithText(f, rows.get(f.meta.id) ?? null)))
    },
    getSnippet: async (id) => {
      const row = db.getSnippet(id)
      const file = await snippets.readSnippet(dir, id, row?.filePath)
      return snippetWithText(file, row)
    },
    deleteSnippet: (id) =>
      mutate(async () => {
        await snippets.deleteSnippet(dir, id, { filePathHint: snippetPathHint(id) })
        removeEntityRows(db, 'snippet', id) // also drops the .md + revision-log file rows
        events.emit({ type: 'snippet.removed', snippetId: id })
      }),
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

    // -- consolidation (§6.2–§6.4) ---------------------------------------------------
    maybeConsolidate: (guards) =>
      mutate(async (): Promise<ConsolidationEvaluation> => {
        const settings = workMeta.settings.consolidation
        // The threshold gate answers from INDEX rows (§7.2) — the debounced evaluation
        // fires on every quiet frontier, and an under-threshold pass must cost zero
        // snippet file reads. Full files are only read once the gate is passed.
        const rows = db.listSnippetRows()
        const thresholds = effectiveThresholds(settings, backoff.thresholdMultiplier)
        const totalWords = rows.reduce((n, r) => n + r.wordCount, 0)
        const over =
          rows.length > thresholds.maxFrontierSnippets || totalWords > thresholds.maxFrontierWords
        if (!over && guards.force !== true) return { status: 'idle' }
        const files = await snippets.listSnippetFiles(dir)
        const prefix = computeEligiblePrefix(files, settings, {
          taskTargetIds: guards.taskTargetIds,
          editingSnippetId,
        })
        if (prefix.length === 0) return { status: 'idle' }
        // §6.3 rule 1: explicit scene-break markers split unconditionally, no agent —
        // never gated by the deferral back-off below.
        const breakIds = heuristicBoundaryIds(prefix)
        if (breakIds.length > 0) {
          const kind = deepestKind()
          const applied = await applyConsolidation(
            files,
            breakIds.map((afterSnippetId) => ({ afterSnippetId, kind, title: null })),
            null, // pure-heuristic break: boundaryRunId is null in provenance (§10.5)
          )
          return { status: 'applied', ...applied }
        }
        // §6.3 temporal deferral back-off: after a deferral, no new boundary run until
        // its not-before deadline passes AND the eligible prefix has grown (re-running
        // the agent over the identical prefix is a pure spend loop). Force bypasses.
        if (guards.force !== true && backoff.blocksBoundaryRun(prefix.length)) {
          return { status: 'idle' }
        }
        backoff.noteEligiblePrefix(prefix.length)
        return { status: 'needs-boundaries', eligibleSnippetIds: prefix.map((f) => f.meta.id) }
      }),
    applyBoundaries: (proposal, o) =>
      mutate(async (): Promise<ApplyBoundariesResult> => {
        const files = await snippets.listSnippetFiles(dir)
        // §6.3 validation against the CURRENT prefix: the window may have moved while
        // the boundary agent was thinking; out-of-prefix boundaries are dropped.
        const prefix = computeEligiblePrefix(files, workMeta.settings.consolidation, {
          taskTargetIds: o.taskTargetIds ?? [],
          editingSnippetId,
        })
        const prefixIds = new Set(prefix.map((f) => f.meta.id))
        const kept: PlannedBoundary[] = proposal.boundaries
          .filter((b) => prefixIds.has(b.afterSnippetId))
          .map((b) => ({
            afterSnippetId: b.afterSnippetId,
            kind: normalizeKind(b.kind),
            title: b.title,
          }))
        if (kept.length === 0) {
          backoff.noteEligiblePrefix(prefix.length)
          recordDeferral(
            proposal.boundaries.length === 0
              ? 'the boundary agent proposed no boundaries'
              : 'every proposed boundary fell outside the eligible prefix',
          )
          return { ok: false, deferred: true, droppedBoundaries: proposal.boundaries.length }
        }
        const applied = await applyConsolidation(files, kept, o.boundaryRunId)
        return { ok: true, ...applied }
      }),
    undoConsolidation: (opId) =>
      mutate(async () => {
        const op = await readPendingOp(dir)
        if (op === null || op.opId !== opId || op.phase !== 'applied') {
          throw new ConsolidationUndoExpiredError(opId)
        }
        clearGraceTimer()
        // The harness has already cancelled enrich/illustrate tasks targeting these
        // sections (interface contract above) — safe to delete the directories.
        await undoAppliedOp(dir, op)
        const sectionIds = op.sections.map((s) => s.sectionId)
        for (const section of op.sections) removeEntityRows(db, 'section', section.sectionId)
        for (const section of op.sections) {
          for (const snip of section.snippets) {
            await upsertSnippetFromDisk(db, dir, path.join(frontierSnippetsDir(dir), snip.fileName))
          }
        }
        events.emit({ type: 'consolidation.undone', opId, sectionIds })
        events.emit({ type: 'sections.restructured' })
      }),
    pendingConsolidation: async () => {
      const op = await readPendingOp(dir)
      if (op === null || op.phase !== 'applied') return null
      return {
        opId: op.opId,
        sectionIds: op.sections.map((s) => s.sectionId),
        undoDeadline: op.expiresAt,
      }
    },
    noteBoundaryDeferral: (reason) => {
      recordDeferral(reason)
    },

    // -- world -----------------------------------------------------------------------
    listWorldEntries: () => world.listWorldEntries(dir),
    getWorldEntry: (id) => world.getWorldEntry(dir, id),
    upsertWorldEntry: (input) =>
      mutate(async () => {
        const res = await world.upsertWorldEntry(dir, input)
        if (res.ok) {
          await upsertWorldEntryFromDisk(db, dir, res.entry.filePath)
          events.emit({ type: 'world.updated', entryId: res.entry.meta.id })
        }
        return res
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
    deleteWorldImage: (id) =>
      mutate(async () => {
        const { removed } = await world.deleteWorldImage(dir, id) // NotFound for unknown ids
        if (!removed) return // idempotent: nothing to reindex, no event
        removeFileRow(db, dir, worldImageRelPath(id))
        removeFileRow(db, dir, worldImageSidecarRelPath(id))
        const entry = await world.getWorldEntry(dir, id)
        await upsertWorldEntryFromDisk(db, dir, entry.filePath)
        events.emit({ type: 'world.updated', entryId: id })
      }),
    worldImagePath: (entryId) => {
      const row = db.getWorldEntry(entryId)
      if (row === null) throw new world.WorldEntryNotFoundError(entryId)
      if (row.imagePath === null) return null
      // §5.4 spells `image` entry-relative ('../images/…'); §10.6 work-relative. Accept
      // both — same policy as index ingestion — and answer from the files table, whose
      // row only exists for the resolution that was actually on disk (and carries the
      // xxh64 the route serves as the immutable version).
      const entryAbs = path.join(dir, ...row.filePath.split('/'))
      const candidates = [
        path.resolve(path.dirname(entryAbs), row.imagePath),
        path.resolve(dir, row.imagePath),
      ]
      for (const candidate of candidates) {
        const rel = toWorkRelative(dir, candidate)
        if (rel.startsWith('..')) continue // escaped the work dir: never streamable
        const file = db.getFile(rel)
        if (file) return { absPath: candidate, version: file.xxh64 }
      }
      return null
    },
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

    workCounts: () => db.workCounts(),

    // -- maintenance & events ---------------------------------------------------------
    reconcile: () =>
      mutate(async () => {
        const report = await reconcile({ workDir: dir, db, emit: (e) => events.emit(e) })
        lastReconcileAt = new Date().toISOString()
        return report
      }),
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
        clearGraceTimer()
        if (lock?.isValid) {
          // §9.4: an APPLIED op's undo grace window does not survive a close — its
          // staging is purged and the journal deleted. A 'planned' journal (a crashed
          // apply awaiting §9.2 replay) is PRESERVED, staged files and all: purging it
          // would delete the originals and let the next open consolidate frontier
          // prose twice; the next open rolls it forward instead.
          const op = await readPendingOp(dir).catch(() => null)
          if (op !== null && op.phase === 'applied') {
            await purgeAppliedOp(dir, op)
            events.emit({ type: 'consolidation.finalized', opId: op.opId })
          }
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
    // §9.2: an op replayed to — or found at — 'applied' resumes its grace timer here
    // (a rolled-forward op gets a fresh full window; 'purged'/'undo-completed' need
    // nothing further).
    if (
      replayed !== null &&
      (replayed.outcome === 'grace-resumed' || replayed.outcome === 'rolled-forward')
    ) {
      scheduleGraceExpiry(replayed.op)
    }
  }

  return handle
}
