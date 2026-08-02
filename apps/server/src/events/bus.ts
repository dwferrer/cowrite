import type { WorkEvent } from '@cowrite/shared'
import { ulid } from 'ulid'

/**
 * Per-work SSE event bus (docs/03-api.md §8): one bus per open work, minted with a fresh
 * `streamId` ULID per open per process and a monotonically increasing `seq`. The SSE `id:`
 * field is `"<streamId>:<seq>"`. Replay comes from an in-memory ring buffer bounded three
 * ways — last 4,096 events, 10 minutes, and a total-bytes budget (~4 MB) — whichever bites
 * first; when the gap fell out of the ring — or the streamId does not match — the client
 * gets a `resync` event instead, plus the synthetic snapshot sequence (§8.3). A `:hb`
 * comment heartbeat goes out every 15 s.
 *
 * The bus also carries the §8.5 in-process-only channels (events that never hit the wire:
 * storage's `work.changed`/`run.recorded`, the engine's `enrichment_wanted`, …) and the
 * per-target text accumulator STRUCTURE for Stage 3 task streaming (empty by construction
 * until the harness lands and fills it — `snapshotEvents()` renders it into synthetic
 * `task.snapshot` events during §8.3 negotiation).
 */

export interface EventSink {
  write(chunk: string): void
  end(): void
}

/** §8.5 in-process channel payloads — never serialized onto the wire. */
export type InProcessEvent = { type: string } & Record<string, unknown>
export type InProcessListener = (event: InProcessEvent) => void
export type Unsubscribe = () => void

export interface WorkEventBusOptions {
  /** `:hb` comment cadence; docs/03 §8.2 fixes 15 s. */
  heartbeatMs?: number
  /** Ring capacity in events (docs/03 §8.3: 4,096). */
  ringMax?: number
  /** Ring retention in ms (docs/03 §8.3: 10 minutes). */
  ringMs?: number
  /** Ring budget in frame bytes (default ~4 MB) — bounds memory under bulk bursts. */
  ringMaxBytes?: number
  /** Clock injection for tests. */
  now?: () => number
}

interface RingEntry {
  seq: number
  at: number
  frame: string
  bytes: number
}

const HEARTBEAT_MS = 15_000
const RING_MAX = 4096
const RING_MS = 600_000
const RING_MAX_BYTES = 4 * 1024 * 1024

/** One wire frame: `id:` cursor (when given), dot-case `event:`, one-line JSON `data:`. */
function formatFrame(id: string | null, event: WorkEvent): string {
  const idLine = id === null ? '' : `id: ${id}\n`
  return `${idLine}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}

export class WorkEventBus {
  readonly streamId: string = ulid()

  private seq = 0
  private ended = false
  private readonly ring: RingEntry[] = []
  private ringBytes = 0
  private readonly sinks = new Set<EventSink>()
  private readonly localListeners = new Set<InProcessListener>()
  /**
   * taskId → target → accumulated stage-2 text. STRUCTURE STUB until Stage 3: nothing
   * mutates it yet, so `snapshotEvents()` is empty by construction — but the §8.3
   * negotiation skeleton (resync + snapshot ordering) is already wired through it.
   */
  private readonly accumulators = new Map<string, Map<string, string>>()
  private readonly heartbeatMs: number
  private readonly ringMax: number
  private readonly ringMs: number
  private readonly ringMaxBytes: number
  private readonly now: () => number
  private heartbeat: NodeJS.Timeout | null = null

  constructor(options: WorkEventBusOptions = {}) {
    this.heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS
    this.ringMax = options.ringMax ?? RING_MAX
    this.ringMs = options.ringMs ?? RING_MS
    this.ringMaxBytes = options.ringMaxBytes ?? RING_MAX_BYTES
    this.now = options.now ?? Date.now
    this.heartbeat = setInterval(() => {
      this.broadcast(':hb\n\n')
    }, this.heartbeatMs)
    this.heartbeat.unref?.()
  }

  private cursor(): string {
    return `${this.streamId}:${this.seq}`
  }

  /** Publish a wire event: assign the next seq, ring-buffer it, fan out to subscribers. */
  publish(event: WorkEvent): string {
    if (this.ended) return this.cursor()
    this.seq += 1
    const id = this.cursor()
    const frame = formatFrame(id, event)
    const bytes = Buffer.byteLength(frame)
    this.ring.push({ seq: this.seq, at: this.now(), frame, bytes })
    this.ringBytes += bytes
    this.evict()
    this.broadcast(frame)
    return id
  }

  /** §8.5: in-process-only signals (work.changed, run.recorded, enrichment_wanted, …). */
  publishLocal(event: InProcessEvent): void {
    for (const listener of [...this.localListeners]) {
      try {
        listener(event)
      } catch {
        // a broken subscriber must not break the publisher
      }
    }
  }

  onLocal(listener: InProcessListener): Unsubscribe {
    this.localListeners.add(listener)
    return () => {
      this.localListeners.delete(listener)
    }
  }

  /**
   * The synthetic snapshot sequence for a connection that cannot be replayed exactly
   * (§8.3). Stage 3 populates the accumulators from task streaming; until then this is
   * empty by construction.
   */
  snapshotEvents(): WorkEvent[] {
    const events: WorkEvent[] = []
    for (const [taskId, targets] of this.accumulators) {
      for (const [target, text] of targets) {
        events.push({ type: 'task.snapshot', taskId, target, text })
      }
    }
    return events
  }

  /**
   * Attach one SSE subscriber. Writes the `hello` frame, then the §8.3 negotiation
   * (exact replay when `lastEventId` is in-ring and the streamId matches; otherwise
   * `resync` + the synthetic snapshot sequence), then live events. Returns detach.
   */
  attach(sink: EventSink, lastEventId?: string): Unsubscribe {
    if (this.ended) {
      sink.end()
      return () => {}
    }
    // Age/budget eviction also runs here so replay never serves frames a publish-time
    // eviction would already have dropped (an idle bus otherwise never evicts by time).
    this.evict()
    const write = (chunk: string): boolean => {
      try {
        sink.write(chunk)
        return true
      } catch {
        return false
      }
    }

    write(formatFrame(this.cursor(), { type: 'hello', streamId: this.streamId, seq: this.seq }))

    const resume = lastEventId === undefined ? null : this.parseCursor(lastEventId)
    if (resume === null) {
      if (lastEventId !== undefined) {
        // Unparseable cursor or foreign streamId (restart / re-open): full REST resync.
        write(formatFrame(this.cursor(), { type: 'resync' }))
      }
      // Fresh connect (or post-resync floor): synthetic snapshots for mid-stream text.
      for (const event of this.snapshotEvents()) {
        write(formatFrame(this.cursor(), event))
      }
    } else if (resume < this.seq) {
      const oldest = this.ring[0]
      if (oldest !== undefined && oldest.seq <= resume + 1) {
        for (const entry of this.ring) {
          if (entry.seq > resume) write(entry.frame)
        }
      } else {
        // The gap fell out of the ring: invalidate-and-refetch, plus snapshots.
        write(formatFrame(this.cursor(), { type: 'resync' }))
        for (const event of this.snapshotEvents()) {
          write(formatFrame(this.cursor(), event))
        }
      }
    }
    // resume >= seq ⇒ the client is current (or ahead of a same-stream cursor): live only.

    this.sinks.add(sink)
    return () => {
      this.sinks.delete(sink)
    }
  }

  /** Final comment frame, then end every subscriber stream — no further events publish. */
  end(): void {
    if (this.ended) return
    this.ended = true
    if (this.heartbeat !== null) clearInterval(this.heartbeat)
    this.heartbeat = null
    for (const sink of [...this.sinks]) {
      try {
        sink.write(':closed\n\n')
        sink.end()
      } catch {
        // the sink is already gone; nothing to clean beyond dropping it
      }
    }
    this.sinks.clear()
    this.localListeners.clear()
    this.accumulators.clear()
  }

  /** `"<streamId>:<seq>"` → seq when the streamId is ours; null otherwise. */
  private parseCursor(lastEventId: string): number | null {
    const sep = lastEventId.lastIndexOf(':')
    if (sep <= 0) return null
    if (lastEventId.slice(0, sep) !== this.streamId) return null
    const seq = Number.parseInt(lastEventId.slice(sep + 1), 10)
    return Number.isInteger(seq) && seq >= 0 ? seq : null
  }

  private dropOldest(): void {
    const head = this.ring.shift()
    if (head !== undefined) this.ringBytes -= head.bytes
  }

  /** Enforce all three ring bounds — count cap, bytes budget, retention window. */
  private evict(): void {
    while (this.ring.length > this.ringMax) this.dropOldest()
    while (this.ring.length > 0 && this.ringBytes > this.ringMaxBytes) this.dropOldest()
    const cutoff = this.now() - this.ringMs
    while (this.ring.length > 0) {
      const head = this.ring[0]
      if (head === undefined || head.at > cutoff) break
      this.dropOldest()
    }
  }

  private broadcast(chunk: string): void {
    for (const sink of [...this.sinks]) {
      try {
        sink.write(chunk)
      } catch {
        this.sinks.delete(sink)
      }
    }
  }
}
