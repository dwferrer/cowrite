import { describe, expect, it } from 'vitest'
import { QueueLane, WorkTaskState } from './queue.js'

/**
 * Lane structure (docs/05 §6.1): capacity, FIFO, dedupe, jump-ahead — the seams Stage 4
 * (background producers) and Stage 5 (illustration pipeline) plug into.
 */

interface Job {
  resolve: () => void
  promise: Promise<void>
}

function job(): Job {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { resolve, promise }
}

describe('QueueLane', () => {
  it('runs up to capacity, queues FIFO, and pumps as jobs settle', async () => {
    const lane = new QueueLane(2)
    const order: string[] = []
    const jobs = [job(), job(), job()]
    const start = (id: number) => async () => {
      order.push(`start-${id}`)
      await (jobs[id] as Job).promise
    }
    expect(lane.enqueue({ id: 'a', start: start(0) })).toBe('started')
    expect(lane.enqueue({ id: 'b', start: start(1) })).toBe('started')
    expect(lane.enqueue({ id: 'c', start: start(2) })).toBe('queued')
    expect(lane.runningCount).toBe(2)
    expect(lane.queuedIds()).toEqual(['c'])

    jobs[0]?.resolve()
    await new Promise((r) => setImmediate(r))
    expect(order).toEqual(['start-0', 'start-1', 'start-2'])
    jobs[1]?.resolve()
    jobs[2]?.resolve()
    await lane.idle()
    expect(lane.runningCount).toBe(0)
  })

  it('dedupes by (kind, targetId) key across queued AND running jobs (05 §6.1)', async () => {
    const lane = new QueueLane(1)
    const first = job()
    expect(lane.enqueue({ id: 'a', dedupeKey: 'enrich:s1', start: () => first.promise })).toBe(
      'started',
    )
    expect(lane.enqueue({ id: 'b', dedupeKey: 'enrich:s1', start: async () => {} })).toBe('deduped')
    expect(lane.enqueue({ id: 'c', dedupeKey: 'enrich:s2', start: async () => {} })).toBe('queued')
    expect(lane.enqueue({ id: 'd', dedupeKey: 'enrich:s2', start: async () => {} })).toBe('deduped')
    first.resolve()
    await lane.idle()
    // The key is released once the job settles: a fresh enqueue is accepted again.
    expect(lane.enqueue({ id: 'e', dedupeKey: 'enrich:s1', start: async () => {} })).toBe('started')
    await lane.idle()
  })

  it('jump-the-queue jobs go ahead of non-jumping queued jobs', async () => {
    const lane = new QueueLane(1)
    const gate = job()
    const order: string[] = []
    lane.enqueue({ id: 'running', start: () => gate.promise })
    lane.enqueue({
      id: 'slow',
      start: async () => {
        order.push('slow')
      },
    })
    lane.enqueue({
      id: 'boundary',
      jumpQueue: true,
      start: async () => {
        order.push('boundary')
      },
    })
    expect(lane.queuedIds()).toEqual(['boundary', 'slow'])
    gate.resolve()
    await lane.idle()
    expect(order).toEqual(['boundary', 'slow'])
  })

  it('a SYNCHRONOUS throw from job.start() still releases the dedupe key (leak regression)', async () => {
    const lane = new QueueLane(1)
    const boom = (): Promise<void> => {
      throw new Error('sync explosion before any promise exists')
    }
    expect(lane.enqueue({ id: 'a', dedupeKey: 'enrich:s1', start: boom })).toBe('started')
    await lane.idle()
    // Without the launch wrapper the key stayed registered forever: this re-enqueue
    // would answer 'deduped' and the target could never be enriched again.
    expect(lane.enqueue({ id: 'b', dedupeKey: 'enrich:s1', start: async () => {} })).toBe('started')
    await lane.idle()
  })

  it('removes queued jobs (cancel-by-removal) and releases their dedupe key', () => {
    const lane = new QueueLane(1)
    const gate = job()
    lane.enqueue({ id: 'running', start: () => gate.promise })
    lane.enqueue({ id: 'q', dedupeKey: 'k', start: async () => {} })
    expect(lane.removeQueued('q')).toBe(true)
    expect(lane.removeQueued('q')).toBe(false)
    expect(lane.enqueue({ id: 'q2', dedupeKey: 'k', start: async () => {} })).toBe('queued')
    gate.resolve()
  })
})

describe('WorkTaskState interactive policy', () => {
  it('rejects a second interactive registration with busy {runningTaskId}', () => {
    const state = new WorkTaskState()
    const task = {
      id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      workId: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
      spec: { kind: 'continue' as const },
      lane: 'interactive' as const,
      status: 'running' as const,
      queuedAt: new Date().toISOString(),
      startedAt: null,
      endedAt: null,
      error: null,
      partialText: null,
      unresolvedProposal: null,
    }
    state.registerInteractive({
      task,
      abort: new AbortController(),
      targetIds: [],
      done: Promise.resolve(),
    })
    expect(() => state.assertInteractiveFree()).toThrowError(/interactive task is already running/)
    state.finish(task.id, 'done', null, new Date().toISOString())
    expect(() => state.assertInteractiveFree()).not.toThrow()
  })
})
