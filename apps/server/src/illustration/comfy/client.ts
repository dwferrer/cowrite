/**
 * The `ComfyClient` (docs/08-illustration.md §2.3): submit an already-injected API-format
 * workflow to ComfyUI, track it to completion, and return the PNG bytes.
 *
 * Design points enforced here:
 * - **`/history` is the source of truth; the websocket is only progress.** A dropped or silent
 *   socket degrades to `/history` polling every 2 s and never fails a job (§2.3, §10). The WS is
 *   shared, lazy, and auto-reconnecting; `client_id` is one UUID minted per process.
 * - **Three deadlines** — queue (job may sit behind the user's own ComfyUI jobs), exec (armed on
 *   `execution_start`), and a hard ceiling from the caller's `deadlineMs` (min of timeouts and the
 *   run's remaining budget). Whichever fires first interrupts (`POST /interrupt` when executing,
 *   else dequeues via `POST /queue {delete}`) and throws `ComfyTimeoutError`.
 * - **Submission network errors retry twice (1 s → 4 s).** A `400` is a `WorkflowInvalidError`
 *   (never retried). An `execution_error` surfaces as a typed `ComfyExecError` and is NOT retried
 *   here — the pipeline layer decides (§10), because a bad graph fails forever while a VRAM OOM is
 *   transient.
 * - **Abort** (`req.signal`) interrupts/dequeues then throws `ComfyAborted`.
 */
import { randomUUID } from 'node:crypto'
import { resolveOutputImages } from './inject.js'

// ---------------------------------------------------------------------------
// Public interface (§2.3 — implemented EXACTLY)
// ---------------------------------------------------------------------------

export interface ComfyProgress {
  phase: 'queued' | 'generating'
  /** `progress.value / max × 100` while a sampler runs; null before the first tick / on fallback. */
  pct: number | null
}

export interface ComfyResult {
  /** Bytes from `/view` (cap 32 MB). */
  png: Buffer
  filename: string
  durationMs: number
  promptId: string
}

export interface ComfyClient {
  /** `GET /system_stats`, 3 s timeout, 60 s cache. */
  health(): Promise<{ ok: boolean; detail?: string }>
  generate(req: {
    /** Already-injected API-format graph JSON. */
    workflow: Record<string, unknown>
    outputNodeId: string
    /** Hard ceiling for this call (min of timeouts and remaining budget). */
    deadlineMs: number
    /** Per-workflow internal exec deadline (`ResolvedWorkflow.execTimeoutMs`) — a slow hq graph
     *  must not be killed by the global `timeouts.execTimeoutMs`. Defaults to that global (§3). */
    execTimeoutMs?: number
    signal: AbortSignal
    onProgress: (p: ComfyProgress) => void
  }): Promise<ComfyResult>
}

// ---------------------------------------------------------------------------
// Typed errors (§2.3, §10). The pipeline maps these to `task.failed` details.
// ---------------------------------------------------------------------------

/** `POST /prompt` → 400: the graph failed ComfyUI validation. Never retried (§10). */
export class WorkflowInvalidError extends Error {
  readonly nodeErrors: Record<string, unknown>
  constructor(nodeErrors: Record<string, unknown>) {
    super('ComfyUI rejected the workflow (400): invalid graph')
    this.name = 'WorkflowInvalidError'
    this.nodeErrors = nodeErrors
  }
}

/** An `execution_error` from ComfyUI. NOT retried by the client — the pipeline decides (§10). */
export class ComfyExecError extends Error {
  readonly nodeId: string | null
  readonly nodeType: string | null
  constructor(nodeId: string | null, nodeType: string | null, message: string) {
    super(message)
    this.name = 'ComfyExecError'
    this.nodeId = nodeId
    this.nodeType = nodeType
  }
}

/** A queue / exec / hard deadline elapsed; the job was interrupted or dequeued first. */
export class ComfyTimeoutError extends Error {
  readonly kind: 'queue' | 'exec' | 'hard'
  constructor(kind: 'queue' | 'exec' | 'hard') {
    super(`ComfyUI ${kind} deadline exceeded`)
    this.name = 'ComfyTimeoutError'
    this.kind = kind
  }
}

/** The caller aborted, or ComfyUI reported `execution_interrupted`. */
export class ComfyAborted extends Error {
  constructor() {
    super('ComfyUI job aborted')
    this.name = 'ComfyAborted'
  }
}

/** A non-400 submit failure that survived the retry pair, or an unreachable `/view`. */
export class ComfyRequestError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ComfyRequestError'
  }
}

// ---------------------------------------------------------------------------
// Injectable seams + options
// ---------------------------------------------------------------------------

/** The minimal WebSocket surface the client uses — Node 22's global `WebSocket` satisfies it,
 *  and a test double can too. Typed here because `@types/node` does not (yet) declare the
 *  global. */
export interface MinimalWebSocket {
  readonly readyState: number
  close(): void
  addEventListener(type: 'message', listener: (ev: { data: unknown }) => void): void
  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void
}
export type WebSocketFactory = (url: string) => MinimalWebSocket

/** `WebSocket.OPEN` — the numeric ready state; hard-coded so we never touch the global's statics. */
const WS_OPEN = 1

export interface ComfyClientTimeouts {
  healthTimeoutMs: number
  connectTimeoutMs: number
  queueTimeoutMs: number
  execTimeoutMs: number
  wsFallbackMs: number
}

export interface ComfyClientOptions {
  baseUrl: string
  timeouts: ComfyClientTimeouts
  /** One UUID per process (§2.1). Defaults to a fresh module-lifetime UUID. */
  clientId?: string
  fetchImpl?: typeof fetch
  /** Defaults to the global `WebSocket` (Node 22, undici). */
  webSocketFactory?: WebSocketFactory
  now?: () => number
  logger?: { warn: (message: string) => void }
  /** `/view` byte cap (§2.3). Default 32 MB. */
  maxImageBytes?: number
  /** WS-idle poll cadence — the "2 s tick" of §2.3. Injectable so tests run fast. */
  pollIntervalMs?: number
  /** Injectable for fast tests. */
  sleepImpl?: (ms: number) => Promise<void>
}

/** One UUID per process (§2.1): a stable `client_id` is only needed to receive the WS stream. */
const PROCESS_CLIENT_ID = randomUUID()

const MAX_IMAGE_BYTES = 32 * 1024 * 1024
const TICK_MS = 2_000
const HEALTH_CACHE_MS = 60_000
/** Submit retry backoffs (§2.3: "retried twice, 1 s → 4 s"). */
const SUBMIT_BACKOFFS_MS = [1_000, 4_000]

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function defaultWebSocketFactory(url: string): MinimalWebSocket {
  const Ctor = (globalThis as { WebSocket?: new (url: string) => MinimalWebSocket }).WebSocket
  if (Ctor === undefined) {
    throw new ComfyRequestError('global WebSocket is unavailable (Node ≥ 21 required)')
  }
  return new Ctor(url)
}

// ---------------------------------------------------------------------------
// WS message shapes (the §2.1 subset we care about)
// ---------------------------------------------------------------------------

interface WsMessage {
  type: string
  data: Record<string, unknown>
}

const PROGRESS_TYPES = new Set([
  'execution_start',
  'execution_cached',
  'executing',
  'progress',
  'executed',
  'execution_error',
  'execution_interrupted',
])

function parseWsMessage(raw: unknown): WsMessage | null {
  if (typeof raw !== 'string') return null // binary preview frames are ignored (§2.1)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const { type, data } = parsed as { type?: unknown; data?: unknown }
  if (typeof type !== 'string') return null
  return {
    type,
    data: data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : {},
  }
}

// ---------------------------------------------------------------------------
// Shared, lazy, auto-reconnecting WS hub
// ---------------------------------------------------------------------------

/**
 * One socket per client, shared across `generate` calls (the illustration lane is capacity 1, but
 * a shared socket is still the right shape). Correlation is by `prompt_id` in the message, so the
 * hub just fans every parsed message out to the active listeners; each `generate` filters.
 */
class WsHub {
  private ws: MinimalWebSocket | null = null
  private readonly listeners = new Set<(msg: WsMessage) => void>()

  constructor(
    private readonly url: string,
    private readonly factory: WebSocketFactory,
  ) {}

  /** Open the socket if it is not currently OPEN (lazy connect + auto-reconnect, §2.3). */
  ensureConnected(): void {
    if (this.ws !== null && this.ws.readyState === WS_OPEN) return
    if (this.ws !== null) return // CONNECTING — let it settle
    let ws: MinimalWebSocket
    try {
      ws = this.factory(this.url)
    } catch {
      return // creation failed → stay down; the tick loop falls back to /history polling
    }
    this.ws = ws
    ws.addEventListener('message', (ev) => {
      const msg = parseWsMessage(ev.data)
      if (msg === null) return
      for (const l of this.listeners) l(msg)
    })
    const drop = (): void => {
      if (this.ws === ws) this.ws = null
    }
    ws.addEventListener('close', drop)
    ws.addEventListener('error', drop)
  }

  isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WS_OPEN
  }

  addListener(fn: (msg: WsMessage) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  close(): void {
    if (this.ws !== null) {
      try {
        this.ws.close()
      } catch {
        // ignore
      }
      this.ws = null
    }
    this.listeners.clear()
  }
}

// ---------------------------------------------------------------------------
// A small async buffer: await the next event, a tick, or an abort.
// ---------------------------------------------------------------------------

type WaitOutcome = 'event' | 'tick' | 'abort'

class EventBuffer {
  private readonly queue: WsMessage[] = []
  private waiter: (() => void) | null = null

  push(msg: WsMessage): void {
    this.queue.push(msg)
    const w = this.waiter
    this.waiter = null
    w?.()
  }

  shift(): WsMessage | undefined {
    return this.queue.shift()
  }

  /** Resolve as soon as an event is buffered, else after `timeoutMs`, else on abort. */
  next(timeoutMs: number, signal: AbortSignal): Promise<WaitOutcome> {
    if (this.queue.length > 0) return Promise.resolve('event')
    if (signal.aborted) return Promise.resolve('abort')
    return new Promise<WaitOutcome>((resolve) => {
      const timer = setTimeout(() => finish('tick'), timeoutMs)
      const onAbort = (): void => finish('abort')
      const finish = (outcome: WaitOutcome): void => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        this.waiter = null
        resolve(outcome)
      }
      this.waiter = () => finish('event')
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export class ComfyHttpClient implements ComfyClient {
  private readonly baseUrl: string
  private readonly timeouts: ComfyClientTimeouts
  private readonly clientId: string
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly logger: { warn: (message: string) => void }
  private readonly maxImageBytes: number
  private readonly pollIntervalMs: number
  private readonly sleepImpl: (ms: number) => Promise<void>
  private readonly hub: WsHub
  private healthCache: { at: number; result: { ok: boolean; detail?: string } } | null = null

  constructor(options: ComfyClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.timeouts = options.timeouts
    this.clientId = options.clientId ?? PROCESS_CLIENT_ID
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? Date.now
    this.logger = options.logger ?? { warn: (m) => console.warn(`[comfy] ${m}`) }
    this.maxImageBytes = options.maxImageBytes ?? MAX_IMAGE_BYTES
    this.pollIntervalMs = options.pollIntervalMs ?? TICK_MS
    this.sleepImpl = options.sleepImpl ?? defaultSleep
    const wsUrl = `${this.baseUrl.replace(/^http/, 'ws')}/ws?clientId=${encodeURIComponent(this.clientId)}`
    this.hub = new WsHub(wsUrl, options.webSocketFactory ?? defaultWebSocketFactory)
  }

  /** Release the shared socket (app shutdown / config reload). */
  close(): void {
    this.hub.close()
  }

  // -- health ---------------------------------------------------------------

  async health(): Promise<{ ok: boolean; detail?: string }> {
    const cached = this.healthCache
    if (cached !== null && this.now() - cached.at < HEALTH_CACHE_MS) return cached.result
    let result: { ok: boolean; detail?: string }
    try {
      const res = await this.fetchWithTimeout(
        '/system_stats',
        { method: 'GET' },
        this.timeouts.healthTimeoutMs,
      )
      result = res.ok ? { ok: true } : { ok: false, detail: `HTTP ${res.status}` }
    } catch (err) {
      result = { ok: false, detail: errorDetail(err) }
    }
    this.healthCache = { at: this.now(), result }
    return result
  }

  // -- generate -------------------------------------------------------------

  async generate(req: {
    workflow: Record<string, unknown>
    outputNodeId: string
    deadlineMs: number
    execTimeoutMs?: number
    signal: AbortSignal
    onProgress: (p: ComfyProgress) => void
  }): Promise<ComfyResult> {
    const startMs = this.now()
    this.hub.ensureConnected()

    const promptId = await this.submit(req.workflow, req.signal)

    // Per-workflow exec deadline (§3): a slow hq graph uses its own `execTimeoutMs`, not the
    // global one, so it isn't killed early once it starts running.
    const execTimeout = req.execTimeoutMs ?? this.timeouts.execTimeoutMs
    const deadlineQueue = this.now() + this.timeouts.queueTimeoutMs
    let deadlineExec: number | null = null
    const deadlineHard = startMs + req.deadlineMs

    const buffer = new EventBuffer()
    let jobLastEventAt = this.now()
    // `executing` chooses interrupt-vs-dequeue on cancel and switches the queue→exec deadline.
    // It flips true on a WS `execution_start` OR, when the WS never confirms (cold/dropped
    // socket), on a submit+grace assumption below (§4) — a genuinely-running job must never be
    // stranded on the short queue deadline with a no-op `/queue{delete}`.
    let executing = false
    let wsConfirmedExecuting = false

    /** Arm the exec deadline + mark (possibly-)executing exactly once. */
    const armExec = (): void => {
      if (deadlineExec === null) deadlineExec = this.now() + execTimeout
      executing = true
    }

    const removeListener = this.hub.addListener((msg) => {
      if (!this.correlates(msg, promptId)) return
      jobLastEventAt = this.now()
      buffer.push(msg)
    })

    try {
      for (;;) {
        // 1. Drain everything buffered for this prompt.
        for (let ev = buffer.shift(); ev !== undefined; ev = buffer.shift()) {
          switch (ev.type) {
            case 'execution_start':
              wsConfirmedExecuting = true
              armExec()
              req.onProgress({ phase: 'generating', pct: null })
              break
            case 'progress':
              req.onProgress({ phase: 'generating', pct: progressPct(ev.data) })
              break
            case 'executed':
              return await this.fetchResult(promptId, req.outputNodeId, startMs, req.signal)
            case 'executing':
              if (ev.data.node === null) {
                return await this.fetchResult(promptId, req.outputNodeId, startMs, req.signal)
              }
              break
            case 'execution_error':
              throw execErrorFrom(ev.data)
            case 'execution_interrupted':
              throw new ComfyAborted()
            default: // execution_cached etc. — not terminal on its own; /history is truth
              break
          }
        }

        // 2. Caller abort takes precedence over deadlines.
        if (req.signal.aborted) {
          await this.cancel(promptId, executing, wsConfirmedExecuting)
          throw new ComfyAborted()
        }

        // 3. Deadlines.
        const now = this.now()
        if (now >= deadlineHard) {
          await this.cancel(promptId, executing, wsConfirmedExecuting)
          throw new ComfyTimeoutError('hard')
        }
        if (deadlineExec !== null && now >= deadlineExec) {
          await this.cancel(promptId, executing, wsConfirmedExecuting)
          throw new ComfyTimeoutError('exec')
        }
        if (deadlineExec === null && now >= deadlineQueue) {
          await this.cancel(promptId, executing, wsConfirmedExecuting)
          throw new ComfyTimeoutError('queue')
        }

        // 4. Wait for the next event, a 2 s tick, or abort — bounded by the nearest deadline.
        const nextDeadline = Math.min(deadlineHard, deadlineExec ?? deadlineQueue)
        const waitMs = Math.max(0, Math.min(this.pollIntervalMs, nextDeadline - now))
        const outcome = await buffer.next(waitMs, req.signal)
        if (outcome === 'abort') {
          await this.cancel(promptId, executing, wsConfirmedExecuting)
          throw new ComfyAborted()
        }
        if (outcome === 'event') continue

        // 5. Tick: if the WS has gone silent or down, poll /history (the source of truth).
        const silent = this.now() - jobLastEventAt > this.timeouts.wsFallbackMs
        if (silent || !this.hub.isOpen()) {
          this.hub.ensureConnected() // best-effort reconnect for future progress
          const poll = await this.pollHistory(promptId, req.signal)
          if (poll === 'completed')
            return await this.fetchResult(promptId, req.outputNodeId, startMs, req.signal)
          if (poll !== 'pending') throw poll // ComfyExecError | ComfyAborted
          // Cold/dropped WS (§4): the socket never confirmed `execution_start`, yet the job is
          // still pending after a submit grace. Assume it may be executing so the exec deadline
          // (not the short queue deadline) governs and a cancel interrupts instead of no-op
          // dequeuing — otherwise a genuinely-running job starves the single ComfyUI slot.
          if (deadlineExec === null && this.now() - startMs >= this.timeouts.wsFallbackMs) {
            armExec()
          }
        }
      }
    } finally {
      removeListener()
    }
  }

  /** A WS message belongs to this job when its `prompt_id` matches, or is absent on a
   *  progress/terminal type (older ComfyUI builds omit it; the lane runs one job at a time). */
  private correlates(msg: WsMessage, promptId: string): boolean {
    const pid = msg.data.prompt_id
    if (typeof pid === 'string') return pid === promptId
    return pid === undefined && PROGRESS_TYPES.has(msg.type)
  }

  // -- submit (with the retry pair) -----------------------------------------

  private async submit(workflow: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    const body = JSON.stringify({ prompt: workflow, client_id: this.clientId })
    let lastErr: unknown
    for (let attempt = 0; attempt <= SUBMIT_BACKOFFS_MS.length; attempt++) {
      if (attempt > 0) {
        await this.abortableSleep(SUBMIT_BACKOFFS_MS[attempt - 1] ?? 0, signal)
      }
      if (signal.aborted) throw new ComfyAborted()
      try {
        const res = await this.fetchWithTimeout(
          '/prompt',
          { method: 'POST', headers: { 'content-type': 'application/json' }, body },
          this.timeouts.connectTimeoutMs,
          signal,
        )
        if (res.status === 400) {
          throw new WorkflowInvalidError(await readNodeErrors(res)) // never retried
        }
        if (!res.ok) {
          throw new ComfyRequestError(`POST /prompt → HTTP ${res.status}`)
        }
        const json = (await res.json()) as { prompt_id?: unknown }
        if (typeof json.prompt_id !== 'string' || json.prompt_id === '') {
          throw new ComfyRequestError('POST /prompt returned no prompt_id')
        }
        return json.prompt_id
      } catch (err) {
        if (err instanceof WorkflowInvalidError || err instanceof ComfyAborted) throw err
        lastErr = err
      }
    }
    throw new ComfyRequestError(`POST /prompt failed after retries: ${errorDetail(lastErr)}`, {
      cause: lastErr,
    })
  }

  // -- /history polling + result fetch --------------------------------------

  /** One `/history/:id` read → `'completed' | 'pending' | ComfyExecError | ComfyAborted`. */
  private async pollHistory(
    promptId: string,
    signal?: AbortSignal,
  ): Promise<'completed' | 'pending' | ComfyExecError | ComfyAborted> {
    let record: HistoryRecord | null
    try {
      record = await this.getHistoryRecord(promptId, signal)
    } catch (err) {
      if (err instanceof ComfyAborted) throw err // a cancel is observed promptly (§5)
      return 'pending' // a transient /history hiccup is not fatal; the next tick retries
    }
    if (record === null) return 'pending'
    const status = record.status
    if (status?.completed === true && status.status_str !== 'error') return 'completed'
    if (status?.status_str === 'error') return historyErrorFrom(status.messages)
    return 'pending'
  }

  private async fetchResult(
    promptId: string,
    outputNodeId: string,
    startMs: number,
    signal?: AbortSignal,
  ): Promise<ComfyResult> {
    // /history is truth: read the record (with a short bounded retry for the WS-terminal race,
    // where `executed` can land a beat before the record is queryable). A transient /history
    // error inside this loop must NOT fail the whole attempt — swallow it like pollHistory does
    // and let the next iteration retry (§5); only a cancel propagates.
    const readRecord = async (): Promise<HistoryRecord | null> => {
      try {
        return await this.getHistoryRecord(promptId, signal)
      } catch (err) {
        if (err instanceof ComfyAborted) throw err
        return null
      }
    }
    let record = await readRecord()
    for (let i = 0; i < 5 && (record === null || record.outputs === undefined); i++) {
      await this.sleepImpl(100)
      record = await readRecord()
    }
    if (record === null) {
      throw new ComfyRequestError(`/history/${promptId} returned no record`)
    }
    if (record.status?.status_str === 'error') {
      throw historyErrorFrom(record.status.messages)
    }
    const outputs = (record.outputs ?? {}) as Record<string, { images?: unknown[] } | undefined>
    const resolved = resolveOutputImages(outputNodeId, outputs)
    if (resolved === null) {
      throw new ComfyRequestError(`/history/${promptId} produced no image outputs`)
    }
    if (resolved.warn !== undefined) this.logger.warn(resolved.warn)
    const images = outputs[resolved.nodeId]?.images ?? []
    if (images.length > 1) {
      this.logger.warn(`output node ${resolved.nodeId} produced ${images.length} images; using [0]`)
    }
    const image = images[0] as
      | { filename?: unknown; subfolder?: unknown; type?: unknown }
      | undefined
    if (image === undefined || typeof image.filename !== 'string') {
      throw new ComfyRequestError(`/history/${promptId} image entry has no filename`)
    }
    const png = await this.fetchView(
      image.filename,
      typeof image.subfolder === 'string' ? image.subfolder : '',
      typeof image.type === 'string' ? image.type : 'output',
      signal,
    )
    return { png, filename: image.filename, durationMs: this.now() - startMs, promptId }
  }

  /** The inner `/history/:id` record for `promptId`, or null when the map is empty (still
   *  running). `signal` is threaded so a cancel is observed promptly (§5). */
  private async getHistoryRecord(
    promptId: string,
    signal?: AbortSignal,
  ): Promise<HistoryRecord | null> {
    const res = await this.fetchWithTimeout(
      `/history/${encodeURIComponent(promptId)}`,
      { method: 'GET' },
      this.timeouts.connectTimeoutMs,
      signal,
    )
    if (!res.ok) throw new ComfyRequestError(`GET /history → HTTP ${res.status}`)
    const json = (await res.json()) as Record<string, HistoryRecord> | null
    if (json === null || typeof json !== 'object') return null
    return json[promptId] ?? null
  }

  private async fetchView(
    filename: string,
    subfolder: string,
    type: string,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    const params = new URLSearchParams({ filename, subfolder, type })
    const res = await this.fetchWithTimeout(
      `/view?${params.toString()}`,
      { method: 'GET' },
      this.timeouts.connectTimeoutMs,
      signal,
    )
    if (!res.ok) throw new ComfyRequestError(`GET /view → HTTP ${res.status}`)
    return this.readCapped(res)
  }

  /** Read a response body, enforcing the 32 MB cap (§2.3) without buffering past it. */
  private async readCapped(res: Response): Promise<Buffer> {
    const declared = res.headers.get('content-length')
    if (declared !== null && Number(declared) > this.maxImageBytes) {
      throw new ComfyRequestError(
        `/view image is ${declared} bytes, over the ${this.maxImageBytes}-byte cap`,
      )
    }
    if (res.body === null) return Buffer.from(await res.arrayBuffer())
    const reader = res.body.getReader()
    const chunks: Buffer[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > this.maxImageBytes) {
        await reader.cancel().catch(() => undefined)
        throw new ComfyRequestError(`/view image exceeds the ${this.maxImageBytes}-byte cap`)
      }
      chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks)
  }

  // -- cancellation ---------------------------------------------------------

  private async interrupt(): Promise<void> {
    await this.fetchWithTimeout(
      '/interrupt',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      this.timeouts.connectTimeoutMs,
    )
  }

  private async dequeue(promptId: string): Promise<void> {
    await this.fetchWithTimeout(
      '/queue',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ delete: [promptId] }),
      },
      this.timeouts.connectTimeoutMs,
    )
  }

  /**
   * End the job. When it is confirmed executing (WS `execution_start`) → `POST /interrupt`. When
   * still queued → `POST /queue {delete}`. When it is *assumed* executing but the WS never
   * confirmed it (cold/dropped socket, §4), we cannot tell running from queued, so try BOTH —
   * `/interrupt` for the running case (a `/queue{delete}` is a no-op on a running job and would
   * starve the slot) and `/queue{delete}` for the still-queued case. Best-effort — a failed
   * cancel never masks the throw.
   */
  private async cancel(
    promptId: string,
    executing: boolean,
    wsConfirmedExecuting: boolean,
  ): Promise<void> {
    try {
      if (executing && wsConfirmedExecuting) {
        await this.interrupt()
      } else if (executing) {
        // Assumed-executing without WS confirmation: cover both possibilities.
        await this.interrupt()
        await this.dequeue(promptId)
      } else {
        await this.dequeue(promptId)
      }
    } catch {
      // best-effort; the deadline/abort throw carries the real outcome
    }
  }

  // -- fetch plumbing -------------------------------------------------------

  private async fetchWithTimeout(
    pathname: string,
    init: RequestInit,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Response> {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(new Error(`timeout after ${timeoutMs} ms`)), timeoutMs)
    const onAbort = (): void => ac.abort(signal?.reason)
    if (signal !== undefined) {
      if (signal.aborted) {
        clearTimeout(timer)
        throw new ComfyAborted()
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
    try {
      return await this.fetchImpl(`${this.baseUrl}${pathname}`, { ...init, signal: ac.signal })
    } finally {
      clearTimeout(timer)
      if (signal !== undefined) signal.removeEventListener('abort', onAbort)
    }
  }

  private abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
    if (ms <= 0) return Promise.resolve()
    if (signal.aborted) return Promise.reject(new ComfyAborted())
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      const onAbort = (): void => {
        clearTimeout(timer)
        reject(new ComfyAborted())
      }
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }
}

// ---------------------------------------------------------------------------
// History shapes + helpers
// ---------------------------------------------------------------------------

interface HistoryStatus {
  status_str?: string
  completed?: boolean
  messages?: unknown[]
}
interface HistoryRecord {
  status?: HistoryStatus
  outputs?: Record<string, unknown>
}

function progressPct(data: Record<string, unknown>): number | null {
  const value = data.value
  const max = data.max
  if (typeof value !== 'number' || typeof max !== 'number' || max <= 0) return null
  return Math.max(0, Math.min(100, (value / max) * 100))
}

function execErrorFrom(data: Record<string, unknown>): ComfyExecError {
  const nodeId = typeof data.node_id === 'string' ? data.node_id : null
  const nodeType = typeof data.node_type === 'string' ? data.node_type : null
  const message =
    typeof data.exception_message === 'string' ? data.exception_message : 'ComfyUI execution error'
  return new ComfyExecError(nodeId, nodeType, message)
}

/** Map a `/history` error status's `messages` into a typed error (§2.3 tick-poll path). */
function historyErrorFrom(messages: unknown[] | undefined): ComfyExecError | ComfyAborted {
  const list = Array.isArray(messages) ? messages : []
  for (const entry of list) {
    if (!Array.isArray(entry)) continue
    const [kind, payload] = entry as [unknown, unknown]
    if (kind === 'execution_interrupted') return new ComfyAborted()
    if (kind === 'execution_error') {
      return execErrorFrom(
        payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : {},
      )
    }
  }
  return new ComfyExecError(null, null, 'ComfyUI reported an execution error')
}

async function readNodeErrors(res: Response): Promise<Record<string, unknown>> {
  try {
    const json = (await res.json()) as { node_errors?: unknown }
    if (json.node_errors !== null && typeof json.node_errors === 'object') {
      return json.node_errors as Record<string, unknown>
    }
  } catch {
    // ignore — an empty node_errors map is a valid representation of "invalid, no detail"
  }
  return {}
}

function errorDetail(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
