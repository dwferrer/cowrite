import type { Task } from '@cowrite/shared'
import { QUEUE_LANE_CAPACITY } from '@cowrite/shared'
import { AppError } from '../http/errors.js'

/**
 * Lane scheduling (docs/05-agents.md §6.1).
 *
 * - `interactive`: capacity 1 per work, REJECTS while occupied (`409 busy` with
 *   `{runningTaskId}`) — writing tasks are never queued. Owned by `WorkTaskState`.
 * - `background`: capacity 2 per work, FIFO with `(kind, targetId)` dedupe and a
 *   jump-the-queue flag (`propose-boundaries`). STRUCTURE for Stage 4 — the generic
 *   `QueueLane` below is fully functional, but no Stage-3 kind produces into it.
 * - `illustration`: one app-wide `QueueLane(1)` slot the per-work schedulers submit into
 *   (Stage 5 fills the pipeline); user-initiated jumps ahead of scheduler-initiated.
 *
 * Queue state is in-process and in-memory by design — on restart, queued tasks are gone
 * (§6.1; recovery reads runs, 03 §8.4).
 */

export const TERMINAL_STATUSES: ReadonlySet<Task['status']> = new Set([
  'done',
  'error',
  'cancelled',
])

export interface TaskEntry {
  readonly task: Task
  readonly abort: AbortController
  /** Live target ids for `cancelByTarget` and the §5.6 consolidation guard. */
  readonly targetIds: readonly string[]
  /** Settles (never rejects) when the runner finishes; queued-only entries settle on removal. */
  done: Promise<void>
  /**
   * Background entries only: settle the entry as cancelled after its lane job was
   * removed from the queue (queued tasks cancel by removal, 05 §6.3) — the runner
   * never starts, so someone must move the task to terminal and publish the event.
   */
  cancelQueued?: () => void
}

const TERMINAL_KEEP = 50

/** Per-work task registry + the interactive lane's occupy/reject policy (05 §6.1). */
export class WorkTaskState {
  private readonly entries = new Map<string, TaskEntry>()
  private terminalIds: string[] = []
  private interactiveId: string | null = null
  /** ms timestamp of the instant the interactive lane last became empty (05 §6.2). */
  private idleSince: number | null = Date.now()
  /** The per-work background lane (Stage-4 producers: enrich-section, propose-boundaries). */
  readonly background = new QueueLane(QUEUE_LANE_CAPACITY.background)

  /** §6.1: a second interactive submit while one runs → 409 busy, never queued. */
  assertInteractiveFree(): void {
    if (this.interactiveId !== null) {
      throw new AppError('busy', 'an interactive task is already running for this work', {
        runningTaskId: this.interactiveId,
      })
    }
  }

  registerInteractive(entry: TaskEntry): void {
    this.assertInteractiveFree()
    this.entries.set(entry.task.id, entry)
    this.interactiveId = entry.task.id
    this.idleSince = null
  }

  /** Register a background-lane entry (no occupancy bookkeeping — the lane queues). */
  registerBackground(entry: TaskEntry): void {
    this.entries.set(entry.task.id, entry)
  }

  /**
   * How long the interactive lane has been empty, in ms — the sweep gate's clock
   * (05 §6.2: "interactive lane empty 60 s"); null while an interactive task runs.
   */
  interactiveIdleMs(now = Date.now()): number | null {
    return this.idleSince === null ? null : Math.max(0, now - this.idleSince)
  }

  /** Move a task to a terminal status; frees the interactive slot, trims history to 50. */
  finish(
    taskId: string,
    status: Task['status'],
    error: Task['error'],
    endedAt: string,
    outcome: {
      /** Cleaned partial prose from an unfinished run (05 §6.5) — display + re-offer. */
      partialText?: string | null
      /** Set while the run's keep-partial/conflict proposal awaits apply/discard. */
      unresolvedProposal?: Task['unresolvedProposal']
    } = {},
  ): Task | null {
    const entry = this.entries.get(taskId)
    if (entry === undefined) return null
    entry.task.status = status
    entry.task.error = error
    entry.task.endedAt = endedAt
    entry.task.partialText = outcome.partialText ?? null
    entry.task.unresolvedProposal = outcome.unresolvedProposal ?? null
    if (this.interactiveId === taskId) {
      this.interactiveId = null
      this.idleSince = Date.now()
    }
    this.terminalIds.push(taskId)
    while (this.terminalIds.length > TERMINAL_KEEP) {
      const evict = this.terminalIds.shift()
      if (evict !== undefined) this.entries.delete(evict)
    }
    return entry.task
  }

  get(taskId: string): TaskEntry | undefined {
    return this.entries.get(taskId)
  }

  /** Queued + running + last 50 terminal, in registration order (03 §3.7). */
  list(): Task[] {
    return [...this.entries.values()].map((e) => e.task)
  }

  /** All entries whose task has not reached a terminal status. */
  live(): TaskEntry[] {
    return [...this.entries.values()].filter((e) => !TERMINAL_STATUSES.has(e.task.status))
  }

  /** Live target ids across queued/running tasks (fed to `maybeConsolidate`, 05 §5.6). */
  liveTargetIds(): string[] {
    return [...new Set(this.live().flatMap((e) => [...e.targetIds]))]
  }
}

// ---------------------------------------------------------------------------
// Generic FIFO lane with capacity, dedupe, and jump-ahead (background/illustration).
// ---------------------------------------------------------------------------

export interface LaneJob {
  id: string
  /** `(kind, targetId)` dedupe key; enqueueing a duplicate is a no-op (05 §6.1). */
  dedupeKey?: string
  /** Jump ahead of non-jumping queued jobs (propose-boundaries; user-initiated images). */
  jumpQueue?: boolean
  start: () => Promise<void>
}

export type EnqueueResult =
  | { status: 'started' | 'queued' }
  /** A live job already carries this dedupe key — the lane is the ONE dedupe
   *  mechanism, so it reports whose, letting callers return the existing task. */
  | { status: 'deduped'; existingId: string }

export class QueueLane {
  private readonly running = new Map<string, Promise<void>>()
  private queued: LaneJob[] = []

  constructor(readonly capacity: number) {}

  /** Live (queued or running) job id per dedupe key, and the reverse for release. */
  private readonly idByKey = new Map<string, string>()
  private readonly keyById = new Map<string, string>()

  enqueue(job: LaneJob): EnqueueResult {
    if (job.dedupeKey !== undefined) {
      const existingId = this.idByKey.get(job.dedupeKey)
      if (existingId !== undefined) return { status: 'deduped', existingId }
      this.idByKey.set(job.dedupeKey, job.id)
      this.keyById.set(job.id, job.dedupeKey)
    }
    if (this.running.size < this.capacity) {
      this.launch(job)
      return { status: 'started' }
    }
    if (job.jumpQueue === true) {
      const at = this.queued.findIndex((q) => q.jumpQueue !== true)
      if (at === -1) this.queued.push(job)
      else this.queued.splice(at, 0, job)
    } else {
      this.queued.push(job)
    }
    return { status: 'queued' }
  }

  /** Remove a queued job (cancel-by-removal); running jobs cancel via their own signal. */
  removeQueued(id: string): boolean {
    const at = this.queued.findIndex((q) => q.id === id)
    if (at === -1) return false
    this.queued.splice(at, 1)
    this.releaseKey(id)
    return true
  }

  queuedIds(): string[] {
    return this.queued.map((q) => q.id)
  }

  get runningCount(): number {
    return this.running.size
  }

  /** Settles when everything running AND queued at call time has drained. */
  async idle(): Promise<void> {
    while (this.running.size > 0 || this.queued.length > 0) {
      await Promise.allSettled([...this.running.values()])
      // pump() launches queued jobs synchronously as runs settle; loop until drained
      if (this.running.size === 0 && this.queued.length > 0) this.pump()
    }
  }

  private releaseKey(id: string): void {
    const key = this.keyById.get(id)
    if (key !== undefined) {
      this.keyById.delete(id)
      this.idByKey.delete(key)
    }
  }

  private launch(job: LaneJob): void {
    // BUG guard: `job.start()` throwing SYNCHRONOUSLY used to escape `enqueue` with the
    // dedupe key registered forever (no promise ⇒ no `.finally` ⇒ no release). Wrap the
    // launch so a sync throw takes the same settle path as an async rejection.
    const run = Promise.resolve()
      .then(() => job.start())
      .catch(() => {}) // job failures are the producer's to report; the lane just schedules
      .finally(() => {
        this.running.delete(job.id)
        this.releaseKey(job.id)
        this.pump()
      })
    this.running.set(job.id, run)
  }

  private pump(): void {
    while (this.running.size < this.capacity) {
      const next = this.queued.shift()
      if (next === undefined) return
      this.launch(next)
    }
  }
}
