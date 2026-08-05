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
 * Stage-5 scheduler triggers (docs/08 §5): the enrich-section → illustrate-section default
 * flow and the illustration staleness sweep. Both go through the app-wide illustration lane
 * (`host.enqueueIllustrate`), draw on the shared sweep budget, and are gated behind
 * `illustrationReady` (comfyui + low lane). Tombstones / user uploads never reach here —
 * the index's `illustrationStale` flag already excludes them (02 §staleness).
 */

function makeWorkMeta(): WorkMeta {
  return WorkMetaSchema.parse({
    schemaVersion: 1,
    id: ulid(),
    title: 'Illustration Scheduler',
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
  applyResult: ApplyBoundariesResult = { ok: true, opId: 'op-1', sectionIds: [], undoDeadline: '' }
  pending: PendingConsolidation | null = null

  readonly maybeConsolidate = vi.fn(async () => this.evaluation)
  readonly applyBoundaries = vi.fn(async () => this.applyResult)
  readonly undoConsolidation = vi.fn(async () => {})
  readonly pendingConsolidation = vi.fn(async () => this.pending)
  readonly noteBoundaryDeferral = vi.fn(() => {})

  private readonly listeners = new Set<StorageChangeListener>()
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

interface HostOpts {
  illustrationReady?: boolean
  onEnqueueIllustrate?: (id: string) => void
  /** Per-call illustrate outcome (§11 cooldown tests); default undefined (fire-and-forget). */
  illustrateOutcome?: () =>
    | { outcome?: Promise<{ status: 'ok' | 'error' | 'cancelled' }> }
    | undefined
}

function makeHost(illustrated: string[], opts: HostOpts): SchedulerHost {
  const boundaryTask: Task = buildTask(
    ulid(),
    ulid(),
    { kind: 'propose-boundaries', eligibleSnippetIds: [] },
    '2026-07-01T00:00:00.000Z',
  )
  return {
    hasSubscribers: () => true,
    interactiveIdleMs: () => 120_000,
    liveTargetIds: () => [],
    backgroundReady: () => true,
    enqueueEnrich: () => ({
      deduped: false,
      outcome: Promise.resolve({
        status: 'ok',
        errorCode: null,
        proposal: null,
      } as BackgroundOutcome),
    }),
    enqueueBoundaries: () => ({
      task: boundaryTask,
      outcome: Promise.resolve({ status: 'ok', errorCode: null, proposal: null }),
    }),
    cancelByTargetAndSettle: async () => {},
    illustrationReady: () => opts.illustrationReady ?? true,
    enqueueIllustrate: (sectionId) => {
      illustrated.push(sectionId)
      opts.onEnqueueIllustrate?.(sectionId)
      return opts.illustrateOutcome?.()
    },
  }
}

let storage: FakeStorage
let illustrated: string[]
let localListeners: Array<(event: { type: string }) => void>
let scheduler: WorkScheduler

function makeScheduler(opts: HostOpts = {}): WorkScheduler {
  const host = makeHost(illustrated, opts)
  const built = new WorkScheduler(
    storage,
    {
      onLocal: (listener) => {
        localListeners.push(listener)
        return () => {}
      },
    },
    host,
    { sweepTickMs: 1000, sweepIdleMs: 60_000, sweepCap: 4, warn: () => {} },
  )
  built.start()
  return built
}

function fireLocal(event: { type: string; sectionId?: string }): void {
  for (const l of localListeners) l(event)
}

beforeEach(() => {
  vi.useFakeTimers()
  storage = new FakeStorage()
  illustrated = []
  localListeners = []
})

afterEach(() => {
  scheduler.dispose()
  vi.useRealTimers()
})

describe('the staleness sweep (§5 staleness)', () => {
  it('enqueues illustrate for illustration-stale sections, skipping summary-only ones', async () => {
    const staleImg = sectionRow({ illustrationStale: true })
    const staleSummary = sectionRow({ shortSummaryStale: true })
    storage.sections = [staleImg, staleSummary]
    scheduler = makeScheduler()
    await vi.advanceTimersByTimeAsync(1000)
    expect(illustrated).toEqual([staleImg.id])
  })

  it('skips the illustration sweep entirely when comfyui is not ready', async () => {
    storage.sections = [sectionRow({ illustrationStale: true })]
    scheduler = makeScheduler({ illustrationReady: false })
    await vi.advanceTimersByTimeAsync(1000)
    expect(illustrated).toEqual([])
  })

  it('backs off a section whose illustrate keeps failing, instead of re-submitting every sweep (§11)', async () => {
    const section = sectionRow({ illustrationStale: true })
    storage.sections = [section]
    scheduler = makeScheduler({
      illustrateOutcome: () => ({ outcome: Promise.resolve({ status: 'error' as const }) }),
    })
    // 8 sweep windows: without the exponential cooldown this would enqueue 8 real generate()
    // submissions; with it the failing section is throttled hard.
    for (let i = 0; i < 8; i++) {
      await vi.advanceTimersByTimeAsync(1000)
      await Promise.resolve()
    }
    expect(illustrated.length).toBeGreaterThanOrEqual(1)
    expect(illustrated.length).toBeLessThan(5)
  })

  it('resets the illustrate cooldown when the section content changes (§11)', async () => {
    const section = sectionRow({ illustrationStale: true })
    storage.sections = [section]
    scheduler = makeScheduler({
      illustrateOutcome: () => ({ outcome: Promise.resolve({ status: 'error' as const }) }),
    })
    await vi.advanceTimersByTimeAsync(1000) // fail 1 → cooldown notBefore ~2000
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(1000) // fail 2 → cooldown notBefore ~4000
    await Promise.resolve()
    const before = illustrated.length
    storage.emit({ type: 'section.changed', sectionId: section.id }) // fresh prose clears cooldown
    await vi.advanceTimersByTimeAsync(1000) // t≈3000: within the OLD 4000 cooldown
    await Promise.resolve()
    expect(illustrated.length).toBeGreaterThan(before) // retried despite the old backoff
  })

  it('shares the sweep budget with enrichment (never exceeds the cap)', async () => {
    // 5 illustration-stale sections, cap 4 → at most 4 enqueues this window.
    storage.sections = Array.from({ length: 5 }, () => sectionRow({ illustrationStale: true }))
    scheduler = makeScheduler()
    await vi.advanceTimersByTimeAsync(1000)
    expect(illustrated.length).toBe(4)
  })
})

describe('the enrich → illustrate default flow (§5)', () => {
  it('enqueues illustrate for a section once its enrich completes and its image is stale', () => {
    const section = sectionRow({ illustrationStale: true })
    storage.sections = [section]
    scheduler = makeScheduler()
    fireLocal({ type: 'enrichment.completed', sectionId: section.id })
    expect(illustrated).toEqual([section.id])
  })

  it('does NOT illustrate a freshly-enriched section whose image is already current', () => {
    const section = sectionRow({
      illustrationStale: false,
      illustrationHash: 'xxh64:00000000000000ff',
    })
    storage.sections = [section]
    scheduler = makeScheduler()
    fireLocal({ type: 'enrichment.completed', sectionId: section.id })
    expect(illustrated).toEqual([])
  })
})
