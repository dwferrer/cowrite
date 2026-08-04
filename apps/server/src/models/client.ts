import type { ErrorCode, HarnessKnobs, Lane, ModelEndpoint } from '@cowrite/shared'
import { estimateUsage, type NormalizedUsage, normalizeUsage, promptChars } from './usage.js'

/**
 * OpenAI-compatible chat client (docs/05-agents.md §3.2, §6.4): a thin `fetch` + SSE
 * parser with the reliability policy we want to own — no SDK dependency.
 *
 * - Streaming is the default: `stream_options: {include_usage: true}` is requested; the
 *   parser is robust to partial SSE lines across chunk boundaries, accumulates
 *   `tool_calls` deltas by index, and treats `[DONE]` / a `finish_reason` as completion.
 * - Timeout ladder (05 §6.4): connect / first-token / idle-gap / total, implemented as
 *   rolling timers that abort the in-flight fetch with a typed reason.
 * - Retries with full-jitter backoff on 429/5xx/408/network failures — never on 4xx
 *   validation, never after user-visible deltas were delivered (mid-stream death is
 *   surfaced as a retryable error for the runner's replay policy, 05 §6.5).
 * - Errors are `ModelClientError`s carrying a shared task-failure `ErrorCode`
 *   (`auth` | `endpoint_unreachable` | `rate_limited` | `timeout` | `output_invalid` |
 *   `validation`), `retryable`, and any partial composition text.
 */

// ---------------------------------------------------------------------------
// Message / request / result shapes
// ---------------------------------------------------------------------------

export interface TextPart {
  type: 'text'
  text: string
}

/** Only the low lane may carry these (05 §3.1); the high client rejects them (lanes.ts). */
export interface ImageUrlPart {
  type: 'image_url'
  imageUrl: { url: string }
}

export type ContentPart = TextPart | ImageUrlPart

export interface ToolCall {
  id: string
  name: string
  /** Raw JSON string as accumulated from the stream; parsing is the caller's contract. */
  argumentsJson: string
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ContentPart[]
  /** Prior tool calls being replayed on an assistant turn (05 §4.1). */
  toolCalls?: ToolCall[]
  /** Required on `tool` turns — which call this result answers. */
  toolCallId?: string
}

/** OpenAI function-tool definition — passed through verbatim (05 §4.1 rule 1). */
export interface ToolDef {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters: Record<string, unknown>
  }
}

export interface ChatRequest {
  messages: ChatMessage[]
  tools?: ToolDef[]
  /** Decoding-side only; never changes rendered prompt bytes (05 §4.1). */
  toolChoice?: 'auto' | 'none'
  /** Defaults to the endpoint's configured temperature. */
  temperature?: number
  /** Per-call override; defaults to the endpoint's configured maxOutputTokens. */
  maxOutputTokens?: number
  /** Default true; false uses the non-streaming JSON fallback. */
  stream?: boolean
}

export interface ToolCallDelta {
  index: number
  id?: string
  name?: string
  argumentsDelta?: string
}

export interface TimeoutLadder {
  connectMs: number
  firstTokenMs: number
  idleGapMs: number
  totalMs: number
}

export interface ChatOpts {
  onDelta?: (textDelta: string) => void
  onToolCallDelta?: (delta: ToolCallDelta) => void
  /**
   * Fires before each client-internal pre-delivery retry (429/5xx/408/network — never
   * after deltas were delivered), so the caller can surface `task.retrying` and count
   * the upcoming call against ITS attempt budget. The runner owns attempt numbering
   * (05 §6.5) — one monotonic sequence across pre- and post-delivery replays — so the
   * callback carries only the error, never a competing attempt number.
   */
  onRetry?: (error: ModelClientError) => void
  /**
   * TOTAL calls this `chat()` may make (including the first). The runner passes its
   * REMAINING per-logical-turn budget here so client-internal pre-delivery retries and
   * the runner's post-delivery replays draw from ONE budget — never
   * `maxAttempts × maxAttempts` billable calls. Defaults to `knobs.retry.maxAttempts`.
   */
  attemptBudget?: number
  signal?: AbortSignal
  /** Per-call overrides over the HarnessKnobs-derived ladder. */
  timeouts?: Partial<TimeoutLadder>
}

export interface ChatResult {
  text: string
  toolCalls: ToolCall[]
  usage: NormalizedUsage
  finishReason: string | null
}

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

/** The subset of the shared closed ErrorCode taxonomy a model call can produce. */
export type ModelFailureCode = Extract<
  ErrorCode,
  'auth' | 'endpoint_unreachable' | 'rate_limited' | 'timeout' | 'output_invalid' | 'validation'
>

export type TimeoutKind = 'connect' | 'first-token' | 'idle-gap' | 'total'

export class ModelClientError extends Error {
  readonly code: ModelFailureCode
  readonly retryable: boolean
  readonly status: number | null
  readonly timeoutKind: TimeoutKind | null
  /** Parsed Retry-After (429) in ms; the retry loop honors it (capped) over backoff. */
  readonly retryAfterMs: number | null
  /** Text streamed before the failure — feeds keep-partial-as-draft (05 §6.5). */
  readonly partialText: string
  /**
   * Usage the failed attempt still incurred (05 §9 usage honesty): the provider-reported
   * figure when the stream died after a usage chunk, else a chars/4 estimate flagged
   * `estimated: true` when any content was delivered; null when nothing was billed
   * (pre-delivery 429/5xx/connect failures). The runner accumulates this into
   * `usageTotal` so retried attempts are never free.
   */
  readonly usage: NormalizedUsage | null

  constructor(
    code: ModelFailureCode,
    message: string,
    opts: {
      retryable: boolean
      status?: number
      timeoutKind?: TimeoutKind
      retryAfterMs?: number
      partialText?: string
      usage?: NormalizedUsage | null
      cause?: unknown
    },
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause })
    this.name = 'ModelClientError'
    this.code = code
    this.retryable = opts.retryable
    this.status = opts.status ?? null
    this.timeoutKind = opts.timeoutKind ?? null
    this.retryAfterMs = opts.retryAfterMs ?? null
    this.partialText = opts.partialText ?? ''
    this.usage = opts.usage ?? null
  }
}

/** Abort reason used by the ladder timers so the catch can tell which timeout tripped. */
class TimeoutTripped {
  constructor(readonly kind: TimeoutKind) {}
}

/** Cap on an honored `Retry-After` header (05 §6.4) — beyond this, backoff semantics win. */
export const RETRY_AFTER_CAP_MS = 30_000

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error('aborted')
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface OpenAiCompatClientOptions {
  lane: Lane
  endpoint: ModelEndpoint
  knobs: HarnessKnobs
  /** Defaults to `lane === 'low'` — the hard invariant of 05 §3.1. */
  allowImageParts?: boolean
  fetchImpl?: typeof fetch
  /** Injectable for fast tests. */
  sleepImpl?: (ms: number) => Promise<void>
  random?: () => number
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export class OpenAiCompatClient {
  readonly lane: Lane
  readonly endpoint: ModelEndpoint
  readonly allowImageParts: boolean
  private readonly knobs: HarnessKnobs
  private readonly fetchImpl: typeof fetch
  private readonly sleepImpl: (ms: number) => Promise<void>
  private readonly random: () => number

  constructor(options: OpenAiCompatClientOptions) {
    this.lane = options.lane
    this.endpoint = options.endpoint
    this.knobs = options.knobs
    this.allowImageParts = options.allowImageParts ?? options.lane === 'low'
    this.fetchImpl = options.fetchImpl ?? fetch
    this.sleepImpl = options.sleepImpl ?? defaultSleep
    this.random = options.random ?? Math.random
  }

  /** The resolved ladder for this lane (totalMs is per-lane, 05 §6.4). */
  ladder(overrides?: Partial<TimeoutLadder>): TimeoutLadder {
    return {
      connectMs: overrides?.connectMs ?? this.knobs.connectTimeoutMs,
      firstTokenMs: overrides?.firstTokenMs ?? this.knobs.firstTokenTimeoutMs,
      idleGapMs: overrides?.idleGapMs ?? this.knobs.idleTokenTimeoutMs,
      totalMs: overrides?.totalMs ?? this.knobs.totalTimeoutMs[this.lane],
    }
  }

  async chat(request: ChatRequest, opts: ChatOpts = {}): Promise<ChatResult> {
    this.assertNoForbiddenImageParts(request.messages)
    const body = this.wireBody(request)
    const ladder = this.ladder(opts.timeouts)
    // ONE attempt budget, owned by the caller (05 §6.5): the runner passes its remaining
    // per-logical-turn budget, so internal pre-delivery retries and the runner's
    // post-delivery replays never multiply into attempts² billable calls.
    const maxAttempts = Math.max(1, opts.attemptBudget ?? this.knobs.retry.maxAttempts)
    const startedAtMs = Date.now()

    let attempt = 0
    for (;;) {
      attempt++
      const delivered = { value: false }
      try {
        return await this.attemptOnce(request, body, opts, ladder, delivered)
      } catch (err) {
        if (opts.signal?.aborted) throw err // user cancellation is never wrapped or retried
        if (!(err instanceof ModelClientError)) throw err
        // Never re-run a call whose deltas the caller already saw — the runner owns
        // mid-stream replay policy (pending overlay reset + task.retrying, 05 §6.5).
        if (!err.retryable || delivered.value || attempt >= maxAttempts) throw err
        opts.onRetry?.(err)
        // Honored Retry-After is capped at min(header, 30 s, remaining total budget) so a
        // hostile/buggy `Retry-After: 3600` can never park the lane (05 §6.4); the sleep
        // races the caller's signal so cancel settles immediately.
        const remainingTotalMs = Math.max(0, startedAtMs + ladder.totalMs - Date.now())
        const waitMs =
          err.retryAfterMs === null
            ? Math.min(this.backoffMs(attempt), remainingTotalMs)
            : Math.min(err.retryAfterMs, RETRY_AFTER_CAP_MS, remainingTotalMs)
        await this.abortableSleep(waitMs, opts.signal)
      }
    }
  }

  /** Race a retry sleep against the caller's abort signal — cancel must free the lane
   *  immediately, never after a Retry-After window (05 §6.3). */
  private abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) return Promise.resolve()
    if (signal === undefined) return this.sleepImpl(ms)
    if (signal.aborted) return Promise.reject(abortReason(signal))
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        signal.removeEventListener('abort', onAbort)
        reject(abortReason(signal))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.sleepImpl(ms).then(
        () => {
          signal.removeEventListener('abort', onAbort)
          resolve()
        },
        (err: unknown) => {
          signal.removeEventListener('abort', onAbort)
          reject(err)
        },
      )
    })
  }

  // -- request building -----------------------------------------------------

  private assertNoForbiddenImageParts(messages: ChatMessage[]): void {
    if (this.allowImageParts) return
    for (const message of messages) {
      if (typeof message.content === 'string') continue
      if (message.content.some((part) => part.type === 'image_url')) {
        throw new ModelClientError(
          'validation',
          `the ${this.lane} lane never receives image content parts (05 §3.1)`,
          { retryable: false },
        )
      }
    }
  }

  private wireBody(request: ChatRequest): Record<string, unknown> {
    const stream = request.stream ?? true
    const body: Record<string, unknown> = {
      model: this.endpoint.model,
      messages: request.messages.map(wireMessage),
      temperature: request.temperature ?? this.endpoint.temperature,
      max_tokens: request.maxOutputTokens ?? this.endpoint.maxOutputTokens,
      stream,
    }
    if (stream) body.stream_options = { include_usage: true }
    if (request.tools !== undefined) body.tools = request.tools
    if (request.toolChoice !== undefined) body.tool_choice = request.toolChoice
    this.applyReasoning(body)
    if (this.endpoint.provider !== null) body.provider = this.endpoint.provider
    return body
  }

  /**
   * Emit reasoning controls in the shape the target understands. `effort` alone rides the
   * OpenAI-standard `reasoning_effort` (which OpenRouter also accepts). A `maxTokens` cap or
   * `exclude` — OpenRouter-only features — moves everything into the `reasoning` object.
   * OpenRouter rejects `reasoning.effort` and `reasoning.max_tokens` together, so the
   * explicit cap wins when both are configured (it's the harder loop guarantee). Nothing is
   * emitted when unconfigured, so plain OpenAI servers are untouched.
   */
  private applyReasoning(body: Record<string, unknown>): void {
    const r = this.endpoint.reasoning
    if (r === null) return
    if (r.maxTokens !== null || r.exclude) {
      const reasoning: Record<string, unknown> = {}
      if (r.maxTokens !== null) reasoning.max_tokens = r.maxTokens
      else if (r.effort !== null) reasoning.effort = r.effort // only when there's no cap
      if (r.exclude) reasoning.exclude = true
      body.reasoning = reasoning
    } else if (r.effort !== null) {
      body.reasoning_effort = r.effort
    }
  }

  private backoffMs(attempt: number): number {
    const { backoffMs, backoffMaxMs } = this.knobs.retry
    const ceiling = Math.min(backoffMs * 2 ** (attempt - 1), backoffMaxMs)
    return Math.round(this.random() * ceiling) // full jitter (05 §6.4)
  }

  // -- one attempt ----------------------------------------------------------

  private async attemptOnce(
    request: ChatRequest,
    body: Record<string, unknown>,
    opts: ChatOpts,
    ladder: TimeoutLadder,
    delivered: { value: boolean },
  ): Promise<ChatResult> {
    const ac = new AbortController()
    const timers = new LadderTimers(ac, ladder)
    const onCallerAbort = () => ac.abort(opts.signal?.reason)
    if (opts.signal?.aborted) throw opts.signal.reason ?? new Error('aborted before call')
    opts.signal?.addEventListener('abort', onCallerAbort, { once: true })

    const accumulator = new StreamAccumulator(request, opts, delivered)
    try {
      timers.start()
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (this.endpoint.apiKey !== '') headers.authorization = `Bearer ${this.endpoint.apiKey}`
      const res = await this.fetchImpl(`${trimBase(this.endpoint.baseUrl)}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ac.signal,
      })
      timers.connected()
      if (!res.ok) throw await httpFailure(res)
      if (request.stream ?? true) {
        await this.consumeStream(res, timers, accumulator)
      } else {
        accumulator.absorbNonStream(await res.json())
      }
      return accumulator.finish()
    } catch (err) {
      throw this.mapThrown(err, ac, opts.signal, accumulator)
    } finally {
      timers.clear()
      opts.signal?.removeEventListener('abort', onCallerAbort)
    }
  }

  private async consumeStream(
    res: Response,
    timers: LadderTimers,
    accumulator: StreamAccumulator,
  ): Promise<void> {
    if (res.body === null) {
      throw new ModelClientError('endpoint_unreachable', 'response had no body to stream', {
        retryable: true,
      })
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      timers.sawStreamActivity()
      buffer += decoder.decode(value, { stream: true })
      buffer = accumulator.absorbSseBuffer(buffer)
      if (accumulator.sawDone) break
    }
    buffer += decoder.decode()
    accumulator.absorbSseBuffer(buffer)
    if (!accumulator.complete) {
      throw new ModelClientError(
        'endpoint_unreachable',
        'stream ended before [DONE] or a finish_reason (mid-stream death)',
        { retryable: true, partialText: accumulator.text },
      )
    }
  }

  private mapThrown(
    err: unknown,
    ac: AbortController,
    callerSignal: AbortSignal | undefined,
    accumulator: StreamAccumulator,
  ): unknown {
    const partialText = accumulator.text
    const usage = accumulator.failureUsage()
    if (err instanceof ModelClientError) {
      // Attach any partial text / billed usage collected before the failure surfaced.
      if (
        (err.partialText === '' && partialText !== '') ||
        (err.usage === null && usage !== null)
      ) {
        return new ModelClientError(err.code, err.message, {
          retryable: err.retryable,
          status: err.status ?? undefined,
          timeoutKind: err.timeoutKind ?? undefined,
          retryAfterMs: err.retryAfterMs ?? undefined,
          partialText: err.partialText === '' ? partialText : err.partialText,
          usage: err.usage ?? usage,
          cause: err.cause,
        })
      }
      return err
    }
    if (callerSignal?.aborted) return err // user cancellation propagates untouched
    const reason: unknown = ac.signal.aborted ? ac.signal.reason : undefined
    const tripped = reason instanceof TimeoutTripped ? reason : null
    if (tripped !== null) {
      return new ModelClientError('timeout', `${tripped.kind} timeout exceeded`, {
        // Total timeout is non-retryable; the rest of the ladder is (05 §6.4).
        retryable: tripped.kind !== 'total',
        timeoutKind: tripped.kind,
        partialText,
        usage,
      })
    }
    const message = err instanceof Error ? causeChain(err) : String(err)
    return new ModelClientError('endpoint_unreachable', `network failure: ${message}`, {
      retryable: true,
      partialText,
      usage,
      cause: err,
    })
  }
}

// ---------------------------------------------------------------------------
// Timeout ladder (rolling timers over one AbortController)
// ---------------------------------------------------------------------------

class LadderTimers {
  private connect: NodeJS.Timeout | null = null
  private firstToken: NodeJS.Timeout | null = null
  private idle: NodeJS.Timeout | null = null
  private total: NodeJS.Timeout | null = null
  private sawFirst = false

  constructor(
    private readonly ac: AbortController,
    private readonly ladder: TimeoutLadder,
  ) {}

  private trip(kind: TimeoutKind): void {
    this.ac.abort(new TimeoutTripped(kind))
  }

  start(): void {
    this.total = setTimeout(() => this.trip('total'), this.ladder.totalMs)
    this.connect = setTimeout(() => this.trip('connect'), this.ladder.connectMs)
    this.firstToken = setTimeout(() => this.trip('first-token'), this.ladder.firstTokenMs)
  }

  /** Response headers arrived — TCP/TLS + request write completed. */
  connected(): void {
    if (this.connect !== null) clearTimeout(this.connect)
    this.connect = null
  }

  /** Any stream chunk arrived: clears first-token, resets the idle-gap timer. */
  sawStreamActivity(): void {
    if (!this.sawFirst) {
      this.sawFirst = true
      if (this.firstToken !== null) clearTimeout(this.firstToken)
      this.firstToken = null
    }
    if (this.idle !== null) clearTimeout(this.idle)
    this.idle = setTimeout(() => this.trip('idle-gap'), this.ladder.idleGapMs)
  }

  clear(): void {
    for (const t of [this.connect, this.firstToken, this.idle, this.total]) {
      if (t !== null) clearTimeout(t)
    }
    this.connect = this.firstToken = this.idle = this.total = null
  }
}

// ---------------------------------------------------------------------------
// SSE / response accumulation
// ---------------------------------------------------------------------------

interface ToolCallSlot {
  id: string
  name: string
  argumentsJson: string
}

class StreamAccumulator {
  text = ''
  sawDone = false
  private finishReason: string | null = null
  private usage: NormalizedUsage | null = null
  private readonly slots = new Map<number, ToolCallSlot>()

  constructor(
    private readonly request: ChatRequest,
    private readonly opts: ChatOpts,
    private readonly delivered: { value: boolean },
  ) {}

  get complete(): boolean {
    return this.sawDone || this.finishReason !== null
  }

  /**
   * Usage a FAILED attempt still incurred (05 §9): the provider figure when the stream
   * died after a usage chunk; else a chars/4 estimate once any content was delivered;
   * null when the request never got far enough to bill anything.
   */
  failureUsage(): NormalizedUsage | null {
    if (this.usage !== null) return this.usage
    if (!this.delivered.value) return null
    return estimateUsage(promptChars(this.request.messages), this.text.length)
  }

  /** Consume complete SSE lines; returns the remaining partial line as the new buffer. */
  absorbSseBuffer(buffer: string): string {
    const lines = buffer.split('\n')
    const rest = lines.pop() ?? ''
    for (const raw of lines) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
      if (!line.startsWith('data:')) continue // comments, event: fields, blank lines
      const data = line.slice(5).trim()
      if (data === '[DONE]') {
        this.sawDone = true
        return rest
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(data)
      } catch {
        continue // tolerate provider keep-alive junk; partial lines never reach here
      }
      this.absorbChunk(parsed)
    }
    return rest
  }

  private absorbChunk(chunk: unknown): void {
    if (chunk === null || typeof chunk !== 'object') return
    const usage = normalizeUsage((chunk as { usage?: unknown }).usage)
    if (usage !== null) this.usage = usage
    const choices = (chunk as { choices?: unknown }).choices
    if (!Array.isArray(choices) || choices.length === 0) return
    const choice = choices[0] as {
      delta?: { content?: unknown; tool_calls?: unknown }
      finish_reason?: unknown
    }
    if (typeof choice.finish_reason === 'string') this.finishReason = choice.finish_reason
    const delta = choice.delta
    if (delta === null || typeof delta !== 'object') return
    if (typeof delta.content === 'string' && delta.content !== '') {
      this.text += delta.content
      this.delivered.value = true
      this.opts.onDelta?.(delta.content)
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) this.absorbToolCallDelta(tc)
    }
  }

  private absorbToolCallDelta(tc: unknown): void {
    if (tc === null || typeof tc !== 'object') return
    const {
      index,
      id,
      function: fn,
    } = tc as {
      index?: unknown
      id?: unknown
      function?: { name?: unknown; arguments?: unknown }
    }
    if (typeof index !== 'number') return
    const slot = this.slots.get(index) ?? { id: '', name: '', argumentsJson: '' }
    const parsed: ToolCallDelta = { index }
    if (typeof id === 'string' && id !== '') {
      slot.id = id
      parsed.id = id
    }
    if (typeof fn?.name === 'string' && fn.name !== '') {
      slot.name += fn.name
      parsed.name = fn.name
    }
    if (typeof fn?.arguments === 'string' && fn.arguments !== '') {
      slot.argumentsJson += fn.arguments
      parsed.argumentsDelta = fn.arguments
    }
    this.slots.set(index, slot)
    this.delivered.value = true
    this.opts.onToolCallDelta?.(parsed)
  }

  /** Non-streaming fallback: absorb a complete chat.completion JSON body. */
  absorbNonStream(body: unknown): void {
    if (body === null || typeof body !== 'object') {
      throw new ModelClientError('output_invalid', 'non-stream response was not a JSON object', {
        retryable: false,
      })
    }
    const usage = normalizeUsage((body as { usage?: unknown }).usage)
    if (usage !== null) this.usage = usage
    const choices = (body as { choices?: unknown }).choices
    const choice = Array.isArray(choices) ? (choices[0] as unknown) : undefined
    if (choice === null || typeof choice !== 'object') {
      throw new ModelClientError('output_invalid', 'non-stream response had no choices[0]', {
        retryable: false,
      })
    }
    const { message, finish_reason } = choice as {
      message?: { content?: unknown; tool_calls?: unknown }
      finish_reason?: unknown
    }
    if (typeof finish_reason === 'string') this.finishReason = finish_reason
    if (typeof message?.content === 'string' && message.content !== '') {
      this.text = message.content
      this.delivered.value = true
      this.opts.onDelta?.(message.content)
    }
    if (Array.isArray(message?.tool_calls)) {
      for (const [i, tc] of message.tool_calls.entries()) {
        const { id, function: fn } = tc as {
          id?: unknown
          function?: { name?: unknown; arguments?: unknown }
        }
        this.slots.set(i, {
          id: typeof id === 'string' ? id : '',
          name: typeof fn?.name === 'string' ? fn.name : '',
          argumentsJson: typeof fn?.arguments === 'string' ? fn.arguments : '',
        })
      }
    }
    this.sawDone = true // a complete JSON body is by definition complete
  }

  finish(): ChatResult {
    const toolCalls = [...this.slots.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, slot]) => ({ ...slot }))
    // 05 §3.2: endpoints that omit usage get a chars/4 estimate flagged estimated:true.
    const usage = this.usage ?? estimateUsage(promptChars(this.request.messages), this.text.length)
    return { text: this.text, toolCalls, usage, finishReason: this.finishReason }
  }
}

// ---------------------------------------------------------------------------
// HTTP status → typed failure (05 §6.4 retryability table, §11 codes)
// ---------------------------------------------------------------------------

async function httpFailure(res: Response): Promise<ModelClientError> {
  let bodyText = ''
  try {
    bodyText = await res.text()
  } catch {
    // ignore — the status alone is enough to classify
  }
  const detail = bodyText === '' ? '' : `: ${truncate(bodyText)}`
  const message = `HTTP ${res.status}${detail}`
  const status = res.status
  if (status === 401 || status === 403) {
    return new ModelClientError('auth', message, { retryable: false, status })
  }
  if (status === 429) {
    return new ModelClientError('rate_limited', message, {
      retryable: true,
      status,
      retryAfterMs: parseRetryAfterMs(res.headers.get('retry-after')) ?? undefined,
    })
  }
  if (status === 408) {
    return new ModelClientError('timeout', message, { retryable: true, status })
  }
  if (status >= 500) {
    return new ModelClientError('endpoint_unreachable', message, { retryable: true, status })
  }
  // Remaining 4xx: request-shaped problems — never retried (05 §6.4).
  return new ModelClientError('validation', message, { retryable: false, status })
}

/** Retry-After: delta-seconds or an HTTP-date (RFC 9110 §10.2.3). */
export function parseRetryAfterMs(header: string | null): number | null {
  if (header === null || header.trim() === '') return null
  const seconds = Number(header.trim())
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const date = Date.parse(header)
  if (Number.isNaN(date)) return null
  return Math.max(0, date - Date.now())
}

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

function truncate(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function causeChain(err: Error): string {
  const cause = err.cause instanceof Error ? ` (${err.cause.message})` : ''
  return `${err.message}${cause}`
}

function wireMessage(message: ChatMessage): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    role: message.role,
    content:
      typeof message.content === 'string'
        ? message.content
        : message.content.map((part) =>
            part.type === 'text'
              ? { type: 'text', text: part.text }
              : { type: 'image_url', image_url: { url: part.imageUrl.url } },
          ),
  }
  if (message.toolCalls !== undefined) {
    wire.tool_calls = message.toolCalls.map((tc) => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: tc.argumentsJson },
    }))
  }
  if (message.toolCallId !== undefined) wire.tool_call_id = message.toolCallId
  return wire
}
