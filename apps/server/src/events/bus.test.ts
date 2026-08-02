import { WorkEvent } from '@cowrite/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type EventSink, WorkEventBus } from './bus.js'

/** SSE mechanics per docs/03-api.md §8.3: ordering, replay, resync, heartbeat, stream id. */

interface CapturingSink extends EventSink {
  chunks: string[]
  endedCount: number
}

function makeSink(): CapturingSink {
  const sink: CapturingSink = {
    chunks: [],
    endedCount: 0,
    write(chunk) {
      sink.chunks.push(chunk)
    },
    end() {
      sink.endedCount += 1
    },
  }
  return sink
}

function frames(
  sink: CapturingSink,
): Array<{ id: string | null; event: string | null; data: unknown }> {
  return sink.chunks
    .join('')
    .split('\n\n')
    .filter((block) => block !== '' && !block.startsWith(':'))
    .map((block) => {
      const lines = block.split('\n')
      const get = (prefix: string): string | null => {
        const line = lines.find((l) => l.startsWith(prefix))
        return line === undefined ? null : line.slice(prefix.length)
      }
      const data = get('data: ')
      return {
        id: get('id: '),
        event: get('event: '),
        data: data === null ? null : JSON.parse(data),
      }
    })
}

const situationEvent = (n: number): WorkEvent => ({
  type: 'situation.changed',
  text: `v${n}`,
  hash: 'xxh64:0123456789abcdef',
  updatedAt: '2026-08-01T00:00:00Z',
})

describe('WorkEventBus', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts every connection with hello and publishes in order with monotonic seq ids', () => {
    const bus = new WorkEventBus()
    const sink = makeSink()
    bus.attach(sink)

    bus.publish(situationEvent(1))
    bus.publish(situationEvent(2))
    bus.publish(situationEvent(3))

    const parsed = frames(sink)
    expect(parsed.map((f) => f.event)).toEqual([
      'hello',
      'situation.changed',
      'situation.changed',
      'situation.changed',
    ])
    expect(parsed[0]?.id).toBe(`${bus.streamId}:0`)
    expect(parsed.slice(1).map((f) => f.id)).toEqual([
      `${bus.streamId}:1`,
      `${bus.streamId}:2`,
      `${bus.streamId}:3`,
    ])
    // every wire payload validates against the canonical union
    for (const frame of parsed) WorkEvent.parse(frame.data)
    bus.end()
  })

  it('replays the gap byte-exactly for an in-ring Last-Event-ID', () => {
    const bus = new WorkEventBus()
    const live = makeSink()
    bus.attach(live)
    for (let n = 1; n <= 5; n++) bus.publish(situationEvent(n))

    const reconnect = makeSink()
    bus.attach(reconnect, `${bus.streamId}:3`)

    // hello frame first, then frames 4 and 5 exactly as the live subscriber saw them
    const helloEnd = reconnect.chunks[0]?.indexOf('\n\n')
    expect(reconnect.chunks[0]?.slice(0, helloEnd ?? 0)).toContain('event: hello')
    expect(reconnect.chunks.slice(1)).toEqual(live.chunks.slice(4))
    const parsed = frames(reconnect)
    expect(parsed.map((f) => f.id)).toEqual([
      `${bus.streamId}:5`,
      `${bus.streamId}:4`,
      `${bus.streamId}:5`,
    ])
    bus.end()
  })

  it('emits resync when the requested seq fell out of the ring', () => {
    const bus = new WorkEventBus({ ringMax: 3 })
    for (let n = 1; n <= 10; n++) bus.publish(situationEvent(n))

    const sink = makeSink()
    bus.attach(sink, `${bus.streamId}:2`)
    const parsed = frames(sink)
    expect(parsed.map((f) => f.event)).toEqual(['hello', 'resync'])
    bus.end()
  })

  it('emits resync when events aged past the ring retention window', () => {
    const bus = new WorkEventBus({ ringMs: 600_000 })
    bus.publish(situationEvent(1))
    vi.advanceTimersByTime(601_000)
    bus.publish(situationEvent(2)) // eviction happens on publish

    const sink = makeSink()
    bus.attach(sink, `${bus.streamId}:0`)
    expect(frames(sink).map((f) => f.event)).toEqual(['hello', 'resync'])
    bus.end()
  })

  it('emits resync on a streamId mismatch (server restarted or work re-opened)', () => {
    const bus = new WorkEventBus()
    bus.publish(situationEvent(1))
    const sink = makeSink()
    bus.attach(sink, '01BX5ZZKBKACTAV9WEVGEMMVS0:1')
    expect(frames(sink).map((f) => f.event)).toEqual(['hello', 'resync'])
    bus.end()
  })

  it('replays nothing when the client is already current', () => {
    const bus = new WorkEventBus()
    bus.publish(situationEvent(1))
    const sink = makeSink()
    bus.attach(sink, `${bus.streamId}:1`)
    expect(frames(sink).map((f) => f.event)).toEqual(['hello'])
    bus.end()
  })

  it('sends the :hb comment heartbeat every 15 s', () => {
    const bus = new WorkEventBus()
    const sink = makeSink()
    bus.attach(sink)
    vi.advanceTimersByTime(15_000)
    vi.advanceTimersByTime(15_000)
    expect(sink.chunks.filter((c) => c === ':hb\n\n')).toHaveLength(2)
    bus.end()
    vi.advanceTimersByTime(60_000)
    expect(sink.chunks.filter((c) => c === ':hb\n\n')).toHaveLength(2)
  })

  it('ends with a final comment frame and stops publishing', () => {
    const bus = new WorkEventBus()
    const sink = makeSink()
    bus.attach(sink)
    bus.end()
    expect(sink.chunks.at(-1)).toBe(':closed\n\n')
    expect(sink.endedCount).toBe(1)
    bus.publish(situationEvent(9))
    expect(sink.chunks.at(-1)).toBe(':closed\n\n')
  })

  it('detach stops delivery for that sink only; double-detach is a no-op', () => {
    const bus = new WorkEventBus()
    const a = makeSink()
    const b = makeSink()
    const detachA = bus.attach(a)
    bus.attach(b)
    bus.publish(situationEvent(1))
    detachA()
    detachA() // double-detach is a no-op
    bus.publish(situationEvent(2))
    expect(frames(a).map((f) => f.event)).toEqual(['hello', 'situation.changed'])
    expect(frames(b).map((f) => f.event)).toEqual([
      'hello',
      'situation.changed',
      'situation.changed',
    ])
    bus.end()
  })

  it('evicts oldest frames past the bytes budget; a reconnect beyond it gets resync', () => {
    // Each situation frame is well over 60 bytes, so a ~4-frame budget bites before the
    // count cap or the retention window do.
    const oneFrame = new WorkEventBus()
    const probe = makeSink()
    oneFrame.attach(probe)
    oneFrame.publish(situationEvent(1))
    const frameBytes = Buffer.byteLength(probe.chunks[1] ?? '')
    oneFrame.end()

    const bus = new WorkEventBus({ ringMaxBytes: frameBytes * 4 })
    for (let n = 1; n <= 10; n++) bus.publish(situationEvent(n))

    // an in-budget cursor replays exactly…
    const recent = makeSink()
    bus.attach(recent, `${bus.streamId}:8`)
    expect(frames(recent).map((f) => f.event)).toEqual([
      'hello',
      'situation.changed',
      'situation.changed',
    ])

    // …but a cursor whose gap was evicted to stay under budget resyncs
    const evicted = makeSink()
    bus.attach(evicted, `${bus.streamId}:2`)
    expect(frames(evicted).map((f) => f.event)).toEqual(['hello', 'resync'])
    bus.end()
  })

  it('evicts on attach too: an aged ring resyncs even when nothing published since', () => {
    const bus = new WorkEventBus({ ringMs: 600_000 })
    bus.publish(situationEvent(1))
    vi.advanceTimersByTime(601_000) // no further publish — attach must evict by itself

    const sink = makeSink()
    bus.attach(sink, `${bus.streamId}:0`)
    expect(frames(sink).map((f) => f.event)).toEqual(['hello', 'resync'])
    bus.end()
  })

  it('the §8.3 negotiation skeleton carries no task.snapshot frames until Stage 3', () => {
    const bus = new WorkEventBus({ ringMax: 2 })
    for (let n = 1; n <= 5; n++) bus.publish(situationEvent(n))
    expect(bus.snapshotEvents()).toEqual([]) // accumulators are a structure stub

    const fresh = makeSink()
    bus.attach(fresh)
    expect(frames(fresh).map((f) => f.event)).toEqual(['hello'])

    const stale = makeSink()
    bus.attach(stale, `${bus.streamId}:1`)
    expect(frames(stale).map((f) => f.event)).toEqual(['hello', 'resync'])
    bus.end()
  })

  it('keeps the in-process channel off the wire', () => {
    const bus = new WorkEventBus()
    const sink = makeSink()
    bus.attach(sink)
    const seen: string[] = []
    bus.onLocal((event) => seen.push(event.type))
    bus.publishLocal({ type: 'work.changed' })
    expect(seen).toEqual(['work.changed'])
    expect(frames(sink).map((f) => f.event)).toEqual(['hello'])
    bus.end()
  })
})
