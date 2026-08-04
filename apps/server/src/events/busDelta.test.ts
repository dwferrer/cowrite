import type { WorkEvent } from '@cowrite/shared'
import { describe, expect, it } from 'vitest'
import { WorkEventBus } from './bus.js'
import { createSseFrameSink } from './sseFrames.js'

/**
 * Stage-3 accumulator behavior (docs/03-api.md §8.2/§8.3): `task.delta` coalescing to the
 * flush window, per-target accumulation feeding synthetic `task.snapshot`s, and the
 * reset/end semantics the runner drives.
 */

function collect(
  bus: WorkEventBus,
  lastEventId?: string,
): { events: WorkEvent[]; detach: () => void } {
  const events: WorkEvent[] = []
  const detach = bus.attach(
    createSseFrameSink((event) => events.push(event)),
    lastEventId,
  )
  return { events, detach }
}

const deltasOf = (events: WorkEvent[]) =>
  events.filter((e): e is Extract<WorkEvent, { type: 'task.delta' }> => e.type === 'task.delta')

const TASK = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

describe('task.delta coalescing (≤ 30/s)', () => {
  it('publishes the leading delta, buffers the window, flushes the tail', () => {
    const bus = new WorkEventBus({ deltaFlushMs: 60_000 }) // window never fires by itself
    const { events } = collect(bus)
    bus.publishTaskDelta(TASK, 'frontier', 'one ')
    bus.publishTaskDelta(TASK, 'frontier', 'two ')
    bus.publishTaskDelta(TASK, 'frontier', 'three')
    expect(deltasOf(events).map((d) => d.text)).toEqual(['one '])

    bus.flushTaskDeltas(TASK)
    expect(deltasOf(events).map((d) => d.text)).toEqual(['one ', 'two three'])
    bus.end()
  })

  it('a reconnect mid-stream gets ONE snapshot with the full accumulated text', () => {
    const bus = new WorkEventBus({ deltaFlushMs: 60_000 })
    const live = collect(bus)
    bus.publishTaskDelta(TASK, 'frontier', 'alpha ')
    bus.publishTaskDelta(TASK, 'frontier', 'beta ')

    const reconnect = collect(bus) // fresh connection, no Last-Event-ID
    const snapshots = reconnect.events.filter(
      (e): e is Extract<WorkEvent, { type: 'task.snapshot' }> => e.type === 'task.snapshot',
    )
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]).toMatchObject({ taskId: TASK, target: 'frontier', text: 'alpha beta ' })
    // The buffered tail was flushed to the OLD subscriber before snapshotting, so the
    // new one never sees text its snapshot already contains.
    expect(deltasOf(reconnect.events)).toHaveLength(0)
    expect(
      deltasOf(live.events)
        .map((d) => d.text)
        .join(''),
    ).toBe('alpha beta ')

    bus.publishTaskDelta(TASK, 'frontier', 'gamma')
    expect(deltasOf(reconnect.events).map((d) => d.text)).toEqual(['gamma'])
    bus.end()
  })

  it('resetTaskStream drops pending + accumulated text without publishing (retry path)', () => {
    const bus = new WorkEventBus({ deltaFlushMs: 60_000 })
    const { events } = collect(bus)
    bus.publishTaskDelta(TASK, 'frontier', 'doomed ')
    bus.publishTaskDelta(TASK, 'frontier', 'attempt')
    bus.resetTaskStream(TASK)
    expect(bus.snapshotEvents()).toEqual([])
    bus.publishTaskDelta(TASK, 'frontier', 'fresh')
    expect(deltasOf(events).map((d) => d.text)).toEqual(['doomed ', 'fresh'])
    expect(bus.snapshotEvents()).toEqual([
      { type: 'task.snapshot', taskId: TASK, target: 'frontier', text: 'fresh' },
    ])
    bus.end()
  })

  it('endTaskStream flushes the tail then clears the accumulator (terminal path)', () => {
    const bus = new WorkEventBus({ deltaFlushMs: 60_000 })
    const { events } = collect(bus)
    bus.publishTaskDelta(TASK, 'frontier', 'head ')
    bus.publishTaskDelta(TASK, 'frontier', 'tail')
    bus.endTaskStream(TASK)
    expect(deltasOf(events).map((d) => d.text)).toEqual(['head ', 'tail'])
    expect(bus.snapshotEvents()).toEqual([])
    bus.end()
  })

  it('coalesces on the real timer too: a burst becomes few events, text preserved', async () => {
    const bus = new WorkEventBus({ deltaFlushMs: 25 })
    const { events } = collect(bus)
    for (let i = 0; i < 50; i++) bus.publishTaskDelta(TASK, 'frontier', `${i} `)
    await new Promise((resolve) => setTimeout(resolve, 80))
    const deltas = deltasOf(events)
    expect(deltas.length).toBeLessThan(10) // 50 pushes collapsed into leading + tail flushes
    expect(deltas.map((d) => d.text).join('')).toBe(
      Array.from({ length: 50 }, (_, i) => `${i} `).join(''),
    )
    bus.end()
  })
})

describe('attach-time task-state frames (03 §8.3 hydration fencing)', () => {
  const STATE_TASK: WorkEvent = {
    type: 'task.state',
    task: {
      id: TASK,
      workId: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
      spec: { kind: 'continue' },
      lane: 'interactive',
      status: 'running',
      queuedAt: '2026-08-02T00:00:00.000Z',
      startedAt: '2026-08-02T00:00:00.000Z',
      endedAt: null,
      error: null,
      partialText: null,
      unresolvedProposal: null,
    },
    lane: 'interactive',
    target: { kind: 'frontier' },
  }

  it('a sync provider writes the state frame on EVERY attach, BEFORE the snapshots', () => {
    const bus = new WorkEventBus({ deltaFlushMs: 60_000 })
    bus.setAttachStateProvider(() => [STATE_TASK])
    bus.publishTaskDelta(TASK, 'frontier', 'accumulated prose')

    const { events } = collect(bus)
    const types = events.map((e) => e.type)
    const stateAt = types.indexOf('task.state')
    const snapshotAt = types.indexOf('task.snapshot')
    expect(stateAt).toBeGreaterThan(-1)
    expect(snapshotAt).toBeGreaterThan(-1)
    expect(stateAt).toBeLessThan(snapshotAt) // the slot exists before its text lands

    const second = collect(bus)
    expect(second.events.some((e) => e.type === 'task.state')).toBe(true) // every attach
    bus.end()
  })

  it('an async provider (lazy post-restart reconstruction) writes when it settles', async () => {
    const bus = new WorkEventBus({ deltaFlushMs: 60_000 })
    bus.setAttachStateProvider(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      return [STATE_TASK]
    })
    const { events } = collect(bus)
    expect(events.some((e) => e.type === 'task.state')).toBe(false) // not yet
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(events.some((e) => e.type === 'task.state')).toBe(true)
    bus.end()
  })

  it('a detached sink never receives late async frames', async () => {
    const bus = new WorkEventBus({ deltaFlushMs: 60_000 })
    bus.setAttachStateProvider(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      return [STATE_TASK]
    })
    const { events, detach } = collect(bus)
    detach()
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(events.some((e) => e.type === 'task.state')).toBe(false)
    bus.end()
  })
})
