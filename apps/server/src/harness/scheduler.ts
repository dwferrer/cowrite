import type { BoundaryProposal, Task } from '@cowrite/shared'
import { AppError } from '../http/errors.js'
import type { StorageChange } from '../storage/events.js'
import type { WorkHandle } from '../storage/service.js'
import type { BackgroundOutcome } from './backgroundTasks.js'

/**
 * The per-work background scheduler (docs/05-agents.md §6.2; docs/02-data-model.md
 * §6.2–§6.4): the consolidation driver and the enrichment sweep. Storage stays a passive
 * library — this module wires the timers.
 *
 * Consolidation driver: frontier writes (storage `onChange`) arm a debounce
 * (`settings.consolidation.debounceMs`, default 30 s); on fire it calls
 * `maybeConsolidate` with the live task-target ids. `needs-boundaries` enqueues the
 * internal `propose-boundaries` task (background lane, jumps the queue); on completion
 * the parsed proposal goes to `applyBoundaries` (storage validates against the CURRENT
 * prefix and journals the apply). A failed/garbage boundary run is reported via
 * `noteBoundaryDeferral` — storage grows its capped in-memory back-off (02 §6.3) and
 * the frontier simply keeps accreting until the next debounced write re-evaluates.
 * "Consolidate now" (03 §3.8) forces an immediate evaluation.
 *
 * Enrichment: `consolidation.applied` storage changes (agent apply and heuristic split
 * — one path for both) enqueue `enrich-section` for each new section. A journal
 * roll-forward at open CANNOT take this path: replay runs inside openWork before any
 * onChange listener exists, so recovered sections are repaired by the sweep instead —
 * missing summaries count as stale (02 §6.5), no queue state persists across restarts.
 * The staleness sweep runs on a tick while the work has ≥ 1 SSE
 * subscriber and the interactive lane has been idle ≥ 60 s, capped at 4 enqueues per
 * sweep window; the engine's `enrichment_wanted` channel draws on the same budget.
 * Illustration (Stage 5, docs/08 §5): each enrich-section completion triggers an
 * illustrate-section for that section when its image is stale/missing, and the sweep
 * re-illustrates sections whose `illustrationStale` flag is set (word-delta / missing on a
 * frozen leaf; tombstones and user uploads are skipped by the index). Both draw on the
 * same sweep budget and are gated behind `illustrationReady` (comfyui + low lane).
 *
 * An unconfigured low lane surfaces cleanly: gates check `backgroundReady` BEFORE
 * creating tasks, so the scheduler backs off quietly (one log line) instead of
 * spinning out failing submissions; the manual /consolidate route still throws the
 * user-facing `409 config_missing`.
 */

/** The storage slice the scheduler drives (structurally: the real WorkHandle). */
export type SchedulerStorage = Pick<
  WorkHandle,
  | 'work'
  | 'staleSections'
  | 'onChange'
  | 'maybeConsolidate'
  | 'applyBoundaries'
  | 'undoConsolidation'
  | 'pendingConsolidation'
  | 'noteBoundaryDeferral'
>

/** What the harness (service.ts) provides the scheduler per work. */
export interface SchedulerHost {
  /** ≥ 1 SSE subscriber — the "app open" proxy (03 §4.1); no focus signal exists. */
  hasSubscribers(): boolean
  /** ms the interactive lane has been empty; null while a writing task runs. */
  interactiveIdleMs(): number | null
  /** Live queued/running task target ids (05 §5.6 consolidation guard). */
  liveTargetIds(): string[]
  /** Would a background submit of this kind succeed? (lane configured, spend ok) */
  backgroundReady(kind: 'enrich-section' | 'propose-boundaries'): boolean
  /** Enqueue an enrich on the background lane; `(kind, targetId)`-deduped. The outcome
   *  (when fresh, not deduped) feeds the per-section failure cooldown. */
  enqueueEnrich(sectionId: string): { deduped: boolean; outcome?: Promise<BackgroundOutcome> }
  /** Enqueue the internal boundary task (jumps the queue); resolves at task end. */
  enqueueBoundaries(eligibleSnippetIds: string[]): {
    task: Task
    outcome: Promise<BackgroundOutcome>
  }
  /** Cancel queued/running tasks touching these ids and wait for them to settle. */
  cancelByTargetAndSettle(targetIds: readonly string[]): Promise<void>
  /** Would an illustrate-section submit succeed? (comfyui + low lane configured, spend ok).
   *  Absent ⇒ illustration is unwired and the sweep skips it entirely (Stage-4 hosts). */
  illustrationReady?(): boolean
  /** Enqueue an illustrate-section on the app-wide illustration lane; `(kind, id)`-deduped
   *  (05 §6.1). Returns the run outcome (when not deduped) so the scheduler can back off a
   *  section whose workflow/box keeps failing — a broken graph must not re-submit every sweep
   *  forever (§11). Absent ⇒ illustration is unwired. */
  enqueueIllustrate?(sectionId: string): { outcome?: Promise<IllustrationSweepOutcome> } | undefined
}

/** The terminal status of a scheduler-initiated illustrate run, fed to the failure cooldown. */
export interface IllustrationSweepOutcome {
  status: 'ok' | 'error' | 'cancelled'
}

export interface SchedulerOptions {
  /** Sweep evaluation cadence (and the sweep-cap budget window). */
  sweepTickMs?: number
  /** Interactive-lane idle threshold before a sweep may enqueue (05 §6.2: 60 s). */
  sweepIdleMs?: number
  /** Max enrich enqueues per sweep window (05 §6.2: 4 — bounds surprise spend). */
  sweepCap?: number
  now?: () => number
  warn?: (message: string) => void
}

const SWEEP_TICK_MS = 15_000
const SWEEP_IDLE_MS = 60_000
const SWEEP_CAP = 4
/** Ceiling on the per-section enrich failure cooldown (~1 h). */
const ENRICH_FAILURE_BACKOFF_CAP_MS = 3_600_000

export class WorkScheduler {
  private readonly storage: SchedulerStorage
  private readonly host: SchedulerHost
  private readonly onLocal: (listener: (event: { type: string }) => void) => () => void
  private readonly sweepTickMs: number
  private readonly sweepIdleMs: number
  private readonly sweepCap: number
  private readonly now: () => number
  private readonly warn: (message: string) => void

  private disposed = false
  private started = false
  private unsubscribes: Array<() => void> = []
  private debounceTimer: NodeJS.Timeout | null = null
  private sweepTimer: NodeJS.Timeout | null = null

  /** One consolidation cycle at a time; holds from evaluation to boundary-task settle. */
  private driving = false
  private boundaryTask: Task | null = null
  /** Settles when the in-flight cycle (incl. apply) finishes — test/close hook. */
  private cyclePromise: Promise<void> | null = null

  /** Sweep budget, refilled once per `sweepTickMs` window (shared with enrichment_wanted). */
  private sweepBudget: number
  private budgetWindowStart: number
  private warnedNotReady = false

  /** Sections whose enrich enqueues are suppressed while an undo is in flight — the
   *  undo-vs-sweep race guard (02 §6.4): cancel-by-target must not race a fresh
   *  enqueue for the very sections being un-frozen. */
  private readonly undoSuppressed = new Set<string>()
  /** Per-section enrich failure cooldown: consecutive failures → exponential
   *  not-before (base = one sweep window, cap ~1 h); reset on content change. */
  private readonly enrichFailures = new Map<string, { failures: number; notBeforeMs: number }>()
  /** Per-section illustrate failure cooldown (§11): same exponential backoff as enrichment, so a
   *  broken workflow / flaky ComfyUI box doesn't re-submit a real generate() every sweep. */
  private readonly illustrationFailures = new Map<
    string,
    { failures: number; notBeforeMs: number }
  >()

  constructor(
    storage: SchedulerStorage,
    channels: { onLocal: (listener: (event: { type: string }) => void) => () => void },
    host: SchedulerHost,
    options: SchedulerOptions = {},
  ) {
    this.storage = storage
    this.host = host
    this.onLocal = channels.onLocal
    this.sweepTickMs = options.sweepTickMs ?? SWEEP_TICK_MS
    this.sweepIdleMs = options.sweepIdleMs ?? SWEEP_IDLE_MS
    this.sweepCap = options.sweepCap ?? SWEEP_CAP
    this.now = options.now ?? Date.now
    this.warn = options.warn ?? ((message) => console.warn(`[cowrite] ${message}`))
    this.sweepBudget = this.sweepCap
    this.budgetWindowStart = this.now()
  }

  start(): void {
    if (this.started || this.disposed) return
    this.started = true
    this.unsubscribes.push(this.storage.onChange((change) => this.onStorageChange(change)))
    this.unsubscribes.push(
      this.onLocal((event) => {
        const sectionId = (event as { sectionId?: unknown }).sectionId
        if (event.type === 'enrichment_wanted' && typeof sectionId === 'string') {
          this.onEnrichmentWanted(sectionId)
        }
        // §5 default flow: a section freezes → enrich-section → on success, illustrate-section.
        if (event.type === 'enrichment.completed' && typeof sectionId === 'string') {
          this.onEnrichmentCompleted(sectionId)
        }
      }),
    )
    this.sweepTimer = setInterval(() => this.sweepTick(), this.sweepTickMs)
    this.sweepTimer.unref?.()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const unsubscribe of this.unsubscribes) unsubscribe()
    this.unsubscribes = []
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer)
    this.debounceTimer = null
    if (this.sweepTimer !== null) clearInterval(this.sweepTimer)
    this.sweepTimer = null
  }

  /** The in-flight consolidation cycle, if any (tests await it; never rejects). */
  pendingCycle(): Promise<void> | null {
    return this.cyclePromise
  }

  // -- consolidation driver (02 §6.2–§6.4) --------------------------------------------

  private onStorageChange(change: StorageChange): void {
    if (this.disposed) return
    switch (change.type) {
      case 'snippet.created':
      case 'snippet.updated':
      case 'snippet.removed':
        this.armDebounce()
        return
      case 'section.changed':
        // Content changed: the failure cooldowns are about the OLD prose — reset them so
        // the sweep may retry the fresh text immediately (§11).
        this.enrichFailures.delete(change.sectionId)
        this.illustrationFailures.delete(change.sectionId)
        return
      case 'consolidation.applied':
        // One enqueue path for agent applies and heuristic splits (05 §6.2
        // "consolidation applied ⇒ enrich each new section"). Journal replay at open
        // never reaches this listener (it runs before the scheduler exists) — those
        // sections, like any lost enqueue, self-heal via the sweep because missing
        // summaries count as stale (02 §6.5).
        this.enqueueEnrichBatch(change.sectionIds)
        return
      default:
        return
    }
  }

  private armDebounce(): void {
    const debounceMs = this.storage.work.settings.consolidation.debounceMs
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      this.drive(false).catch((err) => {
        this.warn(`consolidation evaluation failed: ${err instanceof Error ? err.message : err}`)
      })
    }, debounceMs)
    this.debounceTimer.unref?.()
  }

  /** POST /works/:w/consolidate — forced evaluation, 202 payload for the route.
   *  Nothing eligible is a 202 union variant, not a 409 (03 §3.8); 409 stays for a
   *  genuinely busy or closing work. */
  async consolidateNow(): Promise<
    | { kind: 'task'; task: Task }
    | { kind: 'applied'; sectionIds: string[]; undoToken: string; undoDeadline: string }
    | { kind: 'nothing-eligible' }
  > {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    const result = await this.drive(true)
    // drive(true) only returns null when nothing was eligible.
    return result ?? { kind: 'nothing-eligible' }
  }

  /**
   * One evaluation → (maybe) one boundary task → apply. Returns what happened for the
   * forced path; the debounced path ignores the return value. Only one cycle runs at a
   * time — a second trigger while the boundary agent thinks is a no-op (the next
   * frontier write re-arms the debounce; a forced call returns the in-flight task).
   */
  private async drive(
    force: boolean,
  ): Promise<
    | { kind: 'task'; task: Task }
    | { kind: 'applied'; sectionIds: string[]; undoToken: string; undoDeadline: string }
    | null
  > {
    if (this.disposed) {
      if (force) throw new AppError('conflict', 'this work is closing')
      return null
    }
    if (this.driving) {
      if (force && this.boundaryTask !== null) return { kind: 'task', task: this.boundaryTask }
      if (force) throw new AppError('conflict', 'a consolidation is already being applied')
      return null
    }

    this.driving = true
    let holdForCycle = false
    try {
      // Scene-break splits are unconditional (02 §6.3 rule 1) and need no model lane,
      // so the evaluation ALWAYS runs — only the needs-boundaries path below requires
      // the low lane, and defers quietly when it is unavailable.
      const evaluation = await this.storage.maybeConsolidate({
        taskTargetIds: this.host.liveTargetIds(),
        force,
      })
      if (evaluation.status === 'applied') {
        // §6.3 rule 1: a scene-break split applied inside the evaluation; the
        // consolidation.applied change has already queued the enrich tasks.
        return {
          kind: 'applied',
          sectionIds: evaluation.sectionIds,
          undoToken: evaluation.opId,
          undoDeadline: evaluation.undoDeadline,
        }
      }
      if (evaluation.status !== 'needs-boundaries' || evaluation.eligibleSnippetIds.length === 0) {
        return null
      }
      if (!force && !this.host.backgroundReady('propose-boundaries')) {
        this.warnNotReadyOnce('consolidation')
        return null
      }

      // The boundary agent runs as a normal recorded, cancellable background task.
      const { task, outcome } = this.host.enqueueBoundaries(evaluation.eligibleSnippetIds)
      this.boundaryTask = task
      holdForCycle = true // `driving` stays true until the cycle settles
      this.cyclePromise = outcome
        .then((res) => this.finishCycle(res, task.id))
        .catch((err) => {
          this.warn(`consolidation apply failed: ${err instanceof Error ? err.message : err}`)
        })
        .finally(() => {
          this.driving = false
          this.boundaryTask = null
          this.cyclePromise = null
        })
      return { kind: 'task', task }
    } finally {
      if (!holdForCycle) this.driving = false
    }
  }

  /** The boundary task settled: validate + apply, or record the deferral (02 §6.3). */
  private async finishCycle(res: BackgroundOutcome, boundaryRunId: string): Promise<void> {
    if (this.disposed || res.status === 'cancelled') return // work closing: no deferral
    if (res.status !== 'ok' || res.proposal === null) {
      // Garbage JSON / failed endpoint: storage grows its capped back-off and owns the
      // "long frontier" §6.3 notice; the run file already says why.
      this.storage.noteBoundaryDeferral(
        `the boundary agent run ${boundaryRunId} ${res.status === 'ok' ? 'returned no proposal' : `failed (${res.errorCode ?? 'unknown'})`}`,
      )
      return
    }
    const proposal: BoundaryProposal = res.proposal
    const applied = await this.storage.applyBoundaries(proposal, {
      boundaryRunId,
      taskTargetIds: this.host.liveTargetIds(),
    })
    if (!applied.ok) {
      // Every boundary was dropped against the CURRENT prefix — storage already
      // recorded the deferral; nothing more to do here.
      this.warn(
        `consolidation deferred: ${applied.droppedBoundaries} boundary(ies) fell outside the eligible prefix`,
      )
      return
    }
    // consolidation.applied flows through storage onChange → enrich enqueues + SSE.
  }

  // -- undo (02 §6.4; 03 §3.8) ---------------------------------------------------------

  /**
   * Undo within the grace window. ORDER IS LOAD-BEARING: queued/running enrich (and,
   * Stage 5, illustrate) tasks targeting the un-frozen sections are cancelled and
   * settled BEFORE storage touches the directories, so an enrichment run never writes
   * into a directory being deleted. Unknown/expired tokens surface as the storage
   * layer's typed 409 (`ConsolidationUndoExpiredError`).
   */
  async undo(undoToken: string): Promise<void> {
    const pending = await this.storage.pendingConsolidation()
    if (pending !== null && pending.opId === undoToken) {
      // Undo-vs-sweep race guard: from cancel-by-target until the undo completes, no
      // NEW enrich may be enqueued for the affected sections — a sweep tick (or an
      // enrichment_wanted signal) landing in that window would waste a model call on
      // sections about to be un-frozen (and race the directory deletion).
      for (const id of pending.sectionIds) this.undoSuppressed.add(id)
      try {
        await this.host.cancelByTargetAndSettle(pending.sectionIds)
        await this.storage.undoConsolidation(undoToken)
      } finally {
        for (const id of pending.sectionIds) this.undoSuppressed.delete(id)
      }
      return
    }
    // Wrong/expired token (or a raced grace expiry): storage throws its 409 here.
    await this.storage.undoConsolidation(undoToken)
  }

  // -- enrichment sweep (05 §6.2) ------------------------------------------------------

  private refillBudget(): void {
    const now = this.now()
    if (now - this.budgetWindowStart >= this.sweepTickMs) {
      this.sweepBudget = this.sweepCap
      this.budgetWindowStart = now
    }
  }

  private sweepTick(): void {
    if (this.disposed) return
    this.refillBudget()
    if (!this.host.hasSubscribers()) return // presence gate: SSE is "app open" (03 §4.1)
    const idle = this.host.interactiveIdleMs()
    if (idle === null || idle < this.sweepIdleMs) return
    if (!this.host.backgroundReady('enrich-section')) {
      // Back off quietly instead of spinning failing submissions (05 §11: background
      // errors are quiet; the staleness badge persists until the lane is configured).
      this.warnNotReadyOnce('enrichment sweep')
      return
    }
    // The 'summary' staleness scope is THE §6.5 spelling — leaf sections with
    // stale/missing summaries.
    for (const row of this.storage.staleSections('summary')) {
      if (this.sweepBudget <= 0) break
      if (this.tryEnqueueEnrich(row.id)) this.sweepBudget--
    }
    // Stage 5 (§5 staleness): re-illustrate sections whose image moved > the word-delta
    // threshold or went missing on a frozen leaf. The index's `illustrationStale` flag
    // already skips tombstones and user uploads (02 §staleness); the illustration enqueues
    // draw on the SAME sweep budget as enrichment (one spend bound).
    if (this.host.illustrationReady?.() === true) {
      for (const row of this.storage.staleSections('any')) {
        if (this.sweepBudget <= 0) break
        if (!row.illustrationStale) continue
        if (this.tryEnqueueIllustrate(row.id)) this.sweepBudget--
      }
    }
  }

  /** §5 default flow: after an enrich-section commits, illustrate the section if its image
   *  is now stale/missing (a freshly frozen leaf with no image). Draws on the sweep budget. */
  private onEnrichmentCompleted(sectionId: string): void {
    if (this.disposed) return
    if (this.host.illustrationReady?.() !== true) return
    this.refillBudget()
    if (this.sweepBudget <= 0) return
    const stale = this.storage
      .staleSections('any')
      .some((r) => r.id === sectionId && r.illustrationStale)
    if (!stale) return
    if (this.tryEnqueueIllustrate(sectionId)) this.sweepBudget--
  }

  private tryEnqueueIllustrate(sectionId: string): boolean {
    if (this.undoSuppressed.has(sectionId)) return false // undo in flight for this section
    // §11: back off a section whose illustrate keeps failing — don't re-submit every sweep.
    const cooldown = this.illustrationFailures.get(sectionId)
    if (cooldown !== undefined && this.now() < cooldown.notBeforeMs) return false
    try {
      const res = this.host.enqueueIllustrate?.(sectionId)
      const outcome = res?.outcome
      if (outcome !== undefined) {
        void outcome.then((o) => {
          if (this.disposed) return
          if (o.status === 'error') this.recordIllustrateFailure(sectionId)
          else if (o.status === 'ok') this.illustrationFailures.delete(sectionId)
        })
      }
      return true
    } catch (err) {
      // config_missing / spend_stop raced the ready check, or the section vanished — quiet;
      // the staleness badge persists and a later sweep retries (05 §11 background quiet).
      this.warn(
        `illustrate enqueue for ${sectionId} failed: ${err instanceof Error ? err.message : err}`,
      )
      this.recordIllustrateFailure(sectionId)
      return false
    }
  }

  /** Exponential per-section cooldown after a failed illustrate: base = one sweep window,
   *  doubling per consecutive failure, capped at ~1 h; reset on content change / ok (§11). */
  private recordIllustrateFailure(sectionId: string): void {
    const failures = (this.illustrationFailures.get(sectionId)?.failures ?? 0) + 1
    const backoffMs = Math.min(
      this.sweepTickMs * 2 ** (failures - 1),
      ENRICH_FAILURE_BACKOFF_CAP_MS,
    )
    this.illustrationFailures.set(sectionId, { failures, notBeforeMs: this.now() + backoffMs })
  }

  /** 06's `enrichment_wanted` channel: same budget, no idle gate (a task IS running). */
  private onEnrichmentWanted(sectionId: string): void {
    if (this.disposed) return
    this.refillBudget()
    if (this.sweepBudget <= 0) return
    if (!this.host.backgroundReady('enrich-section')) return
    if (this.tryEnqueueEnrich(sectionId)) this.sweepBudget--
  }

  private enqueueEnrichBatch(sectionIds: readonly string[]): void {
    if (!this.host.backgroundReady('enrich-section')) {
      this.warnNotReadyOnce('post-consolidation enrichment')
      return
    }
    // The post-consolidation batch draws on the SAME sweep budget as everything else
    // (05 §6.2 — one spend bound): enqueue up to the remaining window; the rest is
    // drained by later sweeps because missing summaries count as stale (02 §6.5).
    this.refillBudget()
    for (const sectionId of sectionIds) {
      if (this.sweepBudget <= 0) break
      if (this.tryEnqueueEnrich(sectionId)) this.sweepBudget--
    }
  }

  private tryEnqueueEnrich(sectionId: string): boolean {
    if (this.undoSuppressed.has(sectionId)) return false // undo in flight for this section
    const cooldown = this.enrichFailures.get(sectionId)
    if (cooldown !== undefined && this.now() < cooldown.notBeforeMs) return false
    try {
      const res = this.host.enqueueEnrich(sectionId)
      if (!res.deduped && res.outcome !== undefined) {
        void res.outcome.then((outcome) => {
          if (this.disposed) return
          if (outcome.status === 'error') this.recordEnrichFailure(sectionId)
          else if (outcome.status === 'ok') this.enrichFailures.delete(sectionId)
        })
      }
      return !res.deduped
    } catch (err) {
      // config_missing / spend_stop raced the ready check, or the section vanished —
      // quiet either way; staleness persists and a later sweep retries (05 §6.5).
      this.warn(
        `enrich enqueue for ${sectionId} failed: ${err instanceof Error ? err.message : err}`,
      )
      this.recordEnrichFailure(sectionId)
      return false
    }
  }

  /** Exponential per-section cooldown after a failed enrich: base = one sweep window,
   *  doubling per consecutive failure, capped at ~1 h; reset on content change/ok. */
  private recordEnrichFailure(sectionId: string): void {
    const failures = (this.enrichFailures.get(sectionId)?.failures ?? 0) + 1
    const backoffMs = Math.min(
      this.sweepTickMs * 2 ** (failures - 1),
      ENRICH_FAILURE_BACKOFF_CAP_MS,
    )
    this.enrichFailures.set(sectionId, { failures, notBeforeMs: this.now() + backoffMs })
  }

  private warnNotReadyOnce(what: string): void {
    if (this.warnedNotReady) return
    this.warnedNotReady = true
    this.warn(
      `${what} is paused: the low model lane is not configured (or the spend stop tripped) — see settings`,
    )
  }
}
