import type { Task, WorkMeta } from '@cowrite/shared'
import { WorkMeta as WorkMetaSchema } from '@cowrite/shared'
import { ulid } from 'ulid'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StorageChange, StorageChangeListener } from '../storage/events.js'
import type { SectionRow } from '../storage/index/db.js'
import type {
  ApplyBoundariesResult,
  ConsolidationEvaluation,
  PendingConsolidation,
} from '../storage/service.js'
import type { BackgroundOutcome } from './backgroundTasks.js'
import { type SchedulerHost, type SchedulerStorage, WorkScheduler } from './scheduler.js'
import { buildTask } from './tasks.js'

/**
 * Unit tests for the Stage-4 scheduler (docs/05 §6.2; 02 §6.2–§6.4) against fakes and
 * fake timers: the 30 s consolidation debounce, presence + interactive-idle gating of
 * the staleness sweep (with the sweep cap and the Stage-5 illustration skip), the
 * boundary→apply pipeline with deferral reporting, the undo ordering contract, forced
 * evaluation, and the unconfigured-lane back-off.
 */

const DEBOUNCE_MS = 30_000

function makeWorkMeta(): WorkMeta {
  return WorkMetaSchema.parse({
    schemaVersion: 1,
    id: ulid(),
    title: 'Scheduler Unit',
    createdAt: '2026-07-01T00:00:00.000Z',
  })
}

function sectionRow(overrides: Partial<SectionRow>): SectionRow {
  return {
    id: ulid(),
    parentId: null,
    kind: 'chapter',
    orderKey: 'a0',
    title: null,
    titleSource: 'agent',
    dirPath: 'sections/x',
    wordCount: 100,
    contentHash: 'xxh64:0000000000000000',
    frozenAt: '2026-07-01T00:00:00Z',
    shortSummaryStale: false,
    longSummaryStale: false,
    illustrationStale: false,
    illustrationHash: null,
    illustrationWidth: null,
    illustrationHeight: null,
    shortSummary: null,
    longSummary: null,
    ...overrides,
  }
}

class FakeStorage implements SchedulerStorage {
  work = makeWorkMeta()
  sections: SectionRow[] = []
  evaluation: ConsolidationEvaluation = { status: 'idle' }
  applyResult: ApplyBoundariesResult = {
    ok: true,
    opId: 'op-1',
    sectionIds: ['01JG00000000000000000000S1'],
    undoDeadline: '2026-07-01T00:05:00Z',
  }
  pending: PendingConsolidation | null = null

  /** Shared, interleaved call log (host calls land in the same array). */
  constructor(readonly calls: string[]) {}
  readonly maybeConsolidate = vi.fn(async (guards: { taskTargetIds: string[] }) => {
    this.calls.push(`maybeConsolidate:${guards.taskTargetIds.join(',')}`)
    return this.evaluation
  })
  readonly applyBoundaries = vi.fn(async () => {
    this.calls.push('applyBoundaries')
    return this.applyResult
  })
  readonly undoConsolidation = vi.fn(async () => {
    this.calls.push('undoConsolidation')
  })
  readonly pendingConsolidation = vi.fn(async () => this.pending)
  readonly noteBoundaryDeferral = vi.fn((reason: string) => {
    this.calls.push(`deferral:${reason}`)
  })

  private readonly listeners = new Set<StorageChangeListener>()
  /** Mirrors IndexDb.staleSections semantics (the SQL is unit-tested in db.test.ts). */
  staleSections(scope: 'summary' | 'any' = 'any'): SectionRow[] {
    if (scope === 'summary') {
      return this.sections.filter(
        (r) => r.contentHash !== null && (r.shortSummaryStale || r.longSummaryStale),
      )
    }
    return this.sections.filter(
      (r) => r.shortSummaryStale || r.longSummaryStale || r.illustrationStale,
    )
  }
  onChange(listener: StorageChangeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  emit(change: StorageChange): void {
    for (const listener of this.listeners) listener(change)
  }
}

interface HostState {
  subscribers: boolean
  idleMs: number | null
  ready: boolean
  targetIds: string[]
  boundaryOutcome: BackgroundOutcome
  enrichDeduped: Set<string>
  /** Per-section scripted enrich outcome (defaults to ok) — the cooldown tests. */
  enrichOutcomes: Map<string, BackgroundOutcome>
}

function makeHost(state: HostState, calls: string[]) {
  const boundaryTask: Task = buildTask(
    ulid(),
    ulid(),
    { kind: 'propose-boundaries', eligibleSnippetIds: ['01JG00000000000000000000A1'] },
    '2026-07-01T00:00:00.000Z',
  )
  const host: SchedulerHost = {
    hasSubscribers: () => state.subscribers,
    interactiveIdleMs: () => state.idleMs,
    liveTargetIds: () => state.targetIds,
    backgroundReady: () => state.ready,
    enqueueEnrich: vi.fn((sectionId: string) => {
      calls.push(`enrich:${sectionId}`)
      const outcome =
        state.enrichOutcomes.get(sectionId) ??
        ({ status: 'ok', errorCode: null, proposal: null } as BackgroundOutcome)
      return { deduped: state.enrichDeduped.has(sectionId), outcome: Promise.resolve(outcome) }
    }),
    enqueueBoundaries: vi.fn((ids: string[]) => {
      calls.push(`boundaries:${ids.join(',')}`)
      return { task: boundaryTask, outcome: Promise.resolve(state.boundaryOutcome) }
    }),
    cancelByTargetAndSettle: vi.fn(async (ids: readonly string[]) => {
      calls.push(`cancel:${ids.join(',')}`)
    }),
  }
  return { host, boundaryTask }
}

let storage: FakeStorage
let state: HostState
let calls: string[]
let scheduler: WorkScheduler

function makeScheduler(options: { sweepTickMs?: number } = {}): {
  scheduler: WorkScheduler
  boundaryTask: Task
} {
  const made = makeHost(state, calls)
  const built = new WorkScheduler(storage, { onLocal: () => () => {} }, made.host, {
    sweepTickMs: options.sweepTickMs ?? 1000,
    sweepIdleMs: 60_000,
    sweepCap: 4,
    warn: (message) => calls.push(`warn:${message}`),
  })
  built.start()
  return { scheduler: built, boundaryTask: made.boundaryTask }
}

beforeEach(() => {
  vi.useFakeTimers()
  calls = []
  storage = new FakeStorage(calls)
  state = {
    subscribers: true,
    idleMs: 120_000,
    ready: true,
    targetIds: [],
    boundaryOutcome: { status: 'ok', errorCode: null, proposal: null },
    enrichDeduped: new Set(),
    enrichOutcomes: new Map(),
  }
})

afterEach(() => {
  scheduler.dispose()
  vi.useRealTimers()
})

describe('the consolidation debounce (02 §6.2: 30 s after the last frontier write)', () => {
  it('coalesces a burst of frontier writes into ONE evaluation with the live guard ids', async () => {
    ;({ scheduler } = makeScheduler({ sweepTickMs: 600_000 }))
    state.targetIds = ['snip-a', 'snip-b']
    storage.emit({ type: 'snippet.created', snippetId: 's1' })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 5_000)
    storage.emit({ type: 'snippet.updated', snippetId: 's1' }) // re-arms
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 1)
    expect(storage.maybeConsolidate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(storage.maybeConsolidate).toHaveBeenCalledTimes(1)
    expect(storage.calls).toContain('maybeConsolidate:snip-a,snip-b')
  })

  it('non-frontier changes never arm the debounce', async () => {
    ;({ scheduler } = makeScheduler({ sweepTickMs: 600_000 }))
    storage.emit({ type: 'section.changed', sectionId: 'sec-1' })
    storage.emit({ type: 'situation.changed' })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2)
    expect(storage.maybeConsolidate).not.toHaveBeenCalled()
  })

  it('still EVALUATES with the low lane unconfigured; only needs-boundaries defers', async () => {
    // BUG regression: the ready-gate used to sit BEFORE maybeConsolidate, so an
    // unconfigured low lane silently disabled the unconditional scene-break splits
    // too (02 §6.3 rule 1 needs no model). The evaluation must always run.
    ;({ scheduler } = makeScheduler({ sweepTickMs: 600_000 }))
    state.ready = false
    storage.evaluation = {
      status: 'needs-boundaries',
      eligibleSnippetIds: ['01JG00000000000000000000A1'],
    }
    storage.emit({ type: 'snippet.created', snippetId: 's1' })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 1)
    expect(storage.maybeConsolidate).toHaveBeenCalledTimes(1)
    expect(calls.some((c) => c.startsWith('boundaries:'))).toBe(false) // deferred quietly
    expect(calls.filter((c) => c.startsWith('warn:')).length).toBe(1) // once, not spinning
  })

  it('scene-break splits apply even when the low lane is unconfigured (§6.3 rule 1)', async () => {
    ;({ scheduler } = makeScheduler({ sweepTickMs: 600_000 }))
    state.ready = false
    storage.evaluation = {
      status: 'applied',
      opId: 'op-heur',
      sectionIds: ['sec-heur'],
      undoDeadline: '2026-07-01T00:05:00Z',
    }
    storage.emit({ type: 'snippet.created', snippetId: 's1' })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 1)
    expect(storage.maybeConsolidate).toHaveBeenCalledTimes(1)
    expect(calls.some((c) => c.startsWith('warn:'))).toBe(false) // nothing to warn about
  })
})

describe('the boundary → apply pipeline (02 §6.3–§6.4)', () => {
  async function fireDebounced(): Promise<void> {
    storage.emit({ type: 'snippet.created', snippetId: 's1' })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 1)
    await scheduler.pendingCycle()
  }

  it('needs-boundaries enqueues the internal task and applies its valid proposal', async () => {
    const made = makeScheduler({ sweepTickMs: 600_000 })
    scheduler = made.scheduler
    storage.evaluation = {
      status: 'needs-boundaries',
      eligibleSnippetIds: ['01JG00000000000000000000A1', '01JG00000000000000000000A2'],
    }
    const proposal = {
      boundaries: [{ afterSnippetId: '01JG00000000000000000000A1', kind: 'chapter', title: 'One' }],
    }
    state.boundaryOutcome = { status: 'ok', errorCode: null, proposal }

    await fireDebounced()
    expect(calls).toContain('boundaries:01JG00000000000000000000A1,01JG00000000000000000000A2')
    expect(storage.applyBoundaries).toHaveBeenCalledWith(proposal, {
      boundaryRunId: made.boundaryTask.id,
      taskTargetIds: [],
    })
    expect(storage.noteBoundaryDeferral).not.toHaveBeenCalled()
  })

  it('a failed boundary run (garbage ⇒ output_invalid) records a deferral, never applies', async () => {
    ;({ scheduler } = makeScheduler({ sweepTickMs: 600_000 }))
    storage.evaluation = {
      status: 'needs-boundaries',
      eligibleSnippetIds: ['01JG00000000000000000000A1'],
    }
    state.boundaryOutcome = { status: 'error', errorCode: 'output_invalid', proposal: null }

    await fireDebounced()
    expect(storage.applyBoundaries).not.toHaveBeenCalled()
    expect(storage.noteBoundaryDeferral).toHaveBeenCalledTimes(1)
    expect(String(storage.noteBoundaryDeferral.mock.calls[0]?.[0])).toContain('output_invalid')
  })

  it('a cancelled boundary run (work closing) is NOT a deferral', async () => {
    ;({ scheduler } = makeScheduler({ sweepTickMs: 600_000 }))
    storage.evaluation = {
      status: 'needs-boundaries',
      eligibleSnippetIds: ['01JG00000000000000000000A1'],
    }
    state.boundaryOutcome = { status: 'cancelled', errorCode: null, proposal: null }
    await fireDebounced()
    expect(storage.noteBoundaryDeferral).not.toHaveBeenCalled()
    expect(storage.applyBoundaries).not.toHaveBeenCalled()
  })

  it('consolidation.applied changes enqueue enrich-section for each new section', () => {
    ;({ scheduler } = makeScheduler({ sweepTickMs: 600_000 }))
    storage.emit({
      type: 'consolidation.applied',
      opId: 'op-9',
      sectionIds: ['sec-1', 'sec-2'],
      undoToken: 'op-9',
      undoDeadline: '2026-07-01T00:05:00Z',
    })
    expect(calls).toContain('enrich:sec-1')
    expect(calls).toContain('enrich:sec-2')
  })
})

describe('consolidateNow (03 §3.8 "Consolidate now")', () => {
  it('forces evaluation immediately — no debounce — and returns the boundary task', async () => {
    const made = makeScheduler({ sweepTickMs: 600_000 })
    scheduler = made.scheduler
    storage.evaluation = {
      status: 'needs-boundaries',
      eligibleSnippetIds: ['01JG00000000000000000000A1'],
    }
    const result = await scheduler.consolidateNow()
    expect(result).toEqual({ kind: 'task', task: made.boundaryTask })
    expect(storage.maybeConsolidate).toHaveBeenCalledTimes(1)
    expect(storage.maybeConsolidate.mock.calls[0]?.[0]).toMatchObject({ force: true })
    await scheduler.pendingCycle()
  })

  it('reports an already-applied heuristic split with its undo token', async () => {
    ;({ scheduler } = makeScheduler({ sweepTickMs: 600_000 }))
    storage.evaluation = {
      status: 'applied',
      opId: 'op-7',
      sectionIds: ['sec-7'],
      undoDeadline: '2026-07-01T00:05:00Z',
    }
    const result = await scheduler.consolidateNow()
    expect(result).toEqual({
      kind: 'applied',
      sectionIds: ['sec-7'],
      undoToken: 'op-7',
      undoDeadline: '2026-07-01T00:05:00Z',
    })
  })

  it('reports nothing-eligible as a result kind, not a 409 (03 §3.8)', async () => {
    ;({ scheduler } = makeScheduler({ sweepTickMs: 600_000 }))
    storage.evaluation = { status: 'idle' }
    await expect(scheduler.consolidateNow()).resolves.toEqual({ kind: 'nothing-eligible' })
  })
})

describe('undo (02 §6.4 ordering contract)', () => {
  it('cancels-by-target and settles BEFORE storage touches the directories', async () => {
    ;({ scheduler } = makeScheduler({ sweepTickMs: 600_000 }))
    storage.pending = {
      opId: 'op-1',
      sectionIds: ['sec-1', 'sec-2'],
      undoDeadline: '2026-07-01T00:05:00Z',
    }
    await scheduler.undo('op-1')
    expect(calls.indexOf('cancel:sec-1,sec-2')).toBeGreaterThanOrEqual(0)
    expect(calls.indexOf('cancel:sec-1,sec-2')).toBeLessThan(calls.indexOf('undoConsolidation'))
  })

  it('passes an unknown token straight to storage (its typed 409), cancelling nothing', async () => {
    ;({ scheduler } = makeScheduler({ sweepTickMs: 600_000 }))
    storage.pending = null
    storage.undoConsolidation.mockRejectedValueOnce(new Error('expired'))
    await expect(scheduler.undo('nope')).rejects.toThrow('expired')
    expect(calls.some((c) => c.startsWith('cancel:'))).toBe(false)
  })

  // BUG regression (undo-vs-sweep race): a sweep tick landing between cancel-by-target
  // and undoConsolidation used to enqueue a FRESH enrich for the very sections being
  // un-frozen — a wasted model call racing a directory deletion.
  it('suppresses new enrich enqueues for the affected sections while the undo runs', async () => {
    ;({ scheduler } = makeScheduler())
    storage.sections = [sectionRow({ id: 'sec-1', shortSummaryStale: true })]
    storage.pending = {
      opId: 'op-1',
      sectionIds: ['sec-1'],
      undoDeadline: '2026-07-01T00:05:00Z',
    }
    // Hold the undo open across a sweep tick: cancelByTargetAndSettle blocks until we
    // release it, and the fake-timer advance runs the tick inside that window.
    let releaseCancel!: () => void
    const cancelGate = new Promise<void>((resolve) => {
      releaseCancel = resolve
    })
    const made = makeHost(state, calls)
    made.host.cancelByTargetAndSettle = vi.fn(async (ids: readonly string[]) => {
      calls.push(`cancel:${ids.join(',')}`)
      await cancelGate
    })
    scheduler.dispose()
    scheduler = new WorkScheduler(storage, { onLocal: () => () => {} }, made.host, {
      sweepTickMs: 1000,
      sweepIdleMs: 60_000,
      sweepCap: 4,
      warn: (message) => calls.push(`warn:${message}`),
    })
    scheduler.start()

    const undoPromise = scheduler.undo('op-1')
    await vi.advanceTimersByTimeAsync(3_000) // several sweep ticks inside the window
    expect(calls.filter((c) => c === 'enrich:sec-1')).toEqual([])

    releaseCancel()
    await undoPromise
    // suppression lifts with the undo: the next tick may enqueue again
    await vi.advanceTimersByTimeAsync(1_000)
    expect(calls.filter((c) => c === 'enrich:sec-1')).toHaveLength(1)
  })
})

describe('spend-loop guards (05 §6.2/§6.5)', () => {
  it('a failed enrich arms an exponential per-section cooldown, reset on content change', async () => {
    ;({ scheduler } = makeScheduler())
    storage.sections = [sectionRow({ id: 'sec-f', shortSummaryStale: true })]
    state.enrichOutcomes.set('sec-f', { status: 'error', errorCode: 'internal', proposal: null })
    const enriches = () => calls.filter((c) => c === 'enrich:sec-f').length

    await vi.advanceTimersByTimeAsync(1_000) // t=1s: attempt 1 fails → cooldown 1 window
    expect(enriches()).toBe(1)
    await vi.advanceTimersByTimeAsync(1_000) // t=2s: window elapsed → attempt 2 → 2 windows
    expect(enriches()).toBe(2)
    await vi.advanceTimersByTimeAsync(1_000) // t=3s: inside the 2-window cooldown
    expect(enriches()).toBe(2)
    await vi.advanceTimersByTimeAsync(1_000) // t=4s: attempt 3 → 4 windows (to t=8s)
    expect(enriches()).toBe(3)
    await vi.advanceTimersByTimeAsync(1_000) // t=5s: blocked
    expect(enriches()).toBe(3)

    // a content change resets the cooldown (the failures were about the OLD prose):
    // the very next tick retries, well before the 4-window deadline at t=8s
    state.enrichOutcomes.delete('sec-f') // now succeeds
    storage.emit({ type: 'section.changed', sectionId: 'sec-f' })
    await vi.advanceTimersByTimeAsync(1_000) // t=6s
    expect(enriches()).toBe(4)
  })

  it("routes consolidation.applied's enrich batch through the sweep budget", () => {
    ;({ scheduler } = makeScheduler())
    storage.emit({
      type: 'consolidation.applied',
      opId: 'op-batch',
      sectionIds: ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'],
      undoToken: 'op-batch',
      undoDeadline: '2026-07-01T00:05:00Z',
    })
    // cap 4: the batch may not exceed the sweep window's budget; the remainder is
    // drained by later sweeps (missing summaries count as stale, 02 §6.5)
    expect(calls.filter((c) => c.startsWith('enrich:'))).toEqual([
      'enrich:b1',
      'enrich:b2',
      'enrich:b3',
      'enrich:b4',
    ])
  })
})

describe('the staleness sweep (05 §6.2)', () => {
  const stale = (id: string, over: Partial<SectionRow> = {}) =>
    sectionRow({ id, shortSummaryStale: true, ...over })

  it('is gated on ≥1 SSE subscriber AND 60 s of interactive idleness', async () => {
    ;({ scheduler } = makeScheduler())
    storage.sections = [stale('sec-1')]
    state.subscribers = false
    await vi.advanceTimersByTimeAsync(3_000)
    expect(calls.filter((c) => c.startsWith('enrich:'))).toEqual([])

    state.subscribers = true
    state.idleMs = 10_000 // a writing task finished recently
    await vi.advanceTimersByTimeAsync(3_000)
    expect(calls.filter((c) => c.startsWith('enrich:'))).toEqual([])

    state.idleMs = null // interactive task RUNNING
    await vi.advanceTimersByTimeAsync(3_000)
    expect(calls.filter((c) => c.startsWith('enrich:'))).toEqual([])

    state.idleMs = 61_000
    await vi.advanceTimersByTimeAsync(1_000)
    expect(calls.filter((c) => c.startsWith('enrich:'))).toEqual(['enrich:sec-1'])
  })

  it('caps enqueues per sweep window and skips illustration-only staleness (Stage 5)', async () => {
    ;({ scheduler } = makeScheduler())
    storage.sections = [
      stale('sec-1'),
      sectionRow({ id: 'sec-ill', illustrationStale: true }), // Stage-5 skip
      sectionRow({ id: 'sec-interior', contentHash: null, shortSummaryStale: true }),
      stale('sec-2', { longSummaryStale: true }),
      stale('sec-3'),
      stale('sec-4'),
      stale('sec-5'),
    ]
    await vi.advanceTimersByTimeAsync(1_000)
    // Cap 4; the illustration-stale and interior rows never enqueue.
    expect(calls.filter((c) => c.startsWith('enrich:'))).toEqual([
      'enrich:sec-1',
      'enrich:sec-2',
      'enrich:sec-3',
      'enrich:sec-4',
    ])
    // The next window picks up the remainder: the four live tasks dedupe (consuming no
    // budget), so sec-5 fits.
    state.enrichDeduped = new Set(['sec-1', 'sec-2', 'sec-3', 'sec-4'])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(calls.filter((c) => c.startsWith('enrich:'))).toContain('enrich:sec-5')
  })

  it('deduped enqueues do not consume the sweep budget', async () => {
    ;({ scheduler } = makeScheduler())
    storage.sections = [
      stale('sec-1'),
      stale('sec-2'),
      stale('sec-3'),
      stale('sec-4'),
      stale('sec-5'),
    ]
    state.enrichDeduped = new Set(['sec-1', 'sec-2', 'sec-3', 'sec-4'])
    await vi.advanceTimersByTimeAsync(1_000)
    // Four dedupes cost nothing; the fifth (fresh) section still fits the window.
    expect(calls.filter((c) => c.startsWith('enrich:'))).toHaveLength(5)
  })

  it('backs off quietly (one warning, zero submits) when the low lane is unconfigured', async () => {
    ;({ scheduler } = makeScheduler())
    storage.sections = [stale('sec-1')]
    state.ready = false
    await vi.advanceTimersByTimeAsync(5_000) // five ticks
    expect(calls.filter((c) => c.startsWith('enrich:'))).toEqual([])
    expect(calls.filter((c) => c.startsWith('warn:')).length).toBe(1)
  })
})
