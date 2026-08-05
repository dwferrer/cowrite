/**
 * `createMockLlm()` — the scriptable OpenAI-compatible mock (docs/09-testing.md §2.3).
 *
 * Implements `POST /v1/chat/completions` (streaming SSE with `delta.content` /
 * `delta.tool_calls`, `finish_reason`, and usage in the final data chunk before `[DONE]`;
 * plus the non-streaming shape) and `GET /v1/models`. Behavior is driven by an ordered
 * scenario queue (`scenario.ts`); every incoming chat request is captured for assertions.
 * Control routes (`/__mock/scenario`, `/__mock/reset`, `/__mock/state`) allow the same
 * JSON steps to be enqueued from another process (e2e).
 */
import type { ServerResponse } from 'node:http'
import {
  handleControlRoutes,
  type MockHttpServer,
  readJsonBody,
  sendJson,
  startMockServer,
  type TimerPool,
} from './base.js'
import { ScenarioQueue, type ScenarioState } from './scenario.js'

export interface LlmMatch {
  /** Assert lane routing: the request's `model` must equal this. */
  model?: string
  /** The last message's content (stringified) must include this substring. */
  lastMessageIncludes?: string
  /** Whether the request must (or must not) carry a `tools` array. */
  hasTools?: boolean
}

export interface LlmToolCall {
  name: string
  /** JSON-serializable arguments; sent as `function.arguments` (a JSON string). */
  arguments?: unknown
}

export type LlmStep =
  | { type: 'respond'; text?: string; toolCalls?: LlmToolCall[]; match?: LlmMatch }
  | { type: 'respondStream'; text: string; chunkSize?: number; delayMs?: number; match?: LlmMatch }
  | { type: 'hang'; ms: number; match?: LlmMatch }
  | { type: 'dieMidStream'; text?: string; afterChars?: number; match?: LlmMatch }
  /** SSE headers (and optional leading text), then silence until the client gives up —
   *  the first-token / idle-gap timeout probe (`hang` never even sends headers). */
  | { type: 'stall'; text?: string; match?: LlmMatch }
  | {
      type: 'http'
      status: number
      body?: unknown
      retryAfterMs?: number
      match?: LlmMatch
    }

export interface CapturedChatRequest {
  model: string | undefined
  messages: Array<Record<string, unknown>>
  tools: unknown[] | undefined
  toolChoice: unknown
  stream: boolean
  /** The request's `authorization` header, for bearer-auth assertions. */
  authorization: string | undefined
  /** The full parsed request body, for asserting any other param. */
  body: Record<string, unknown>
}

/** Typed step builder over the shared queue; steps stay plain JSON for the control route. */
export class LlmScenario {
  readonly queue = new ScenarioQueue<LlmStep>()

  /** Script one exchange: assistant text, or one/many tool calls. */
  respond(
    response: string | { toolCall: LlmToolCall } | { toolCalls: LlmToolCall[] },
    match?: LlmMatch,
  ): this {
    if (typeof response === 'string') {
      this.queue.push({ type: 'respond', text: response, match })
    } else if ('toolCall' in response) {
      this.queue.push({ type: 'respond', toolCalls: [response.toolCall], match })
    } else {
      this.queue.push({ type: 'respond', toolCalls: response.toolCalls, match })
    }
    return this
  }

  /** Script a streamed text response with explicit chunking and per-chunk delay. */
  respondStream(
    text: string,
    opts?: { chunkSize?: number; delayMs?: number; match?: LlmMatch },
  ): this {
    this.queue.push({
      type: 'respondStream',
      text,
      chunkSize: opts?.chunkSize,
      delayMs: opts?.delayMs,
      match: opts?.match,
    })
    return this
  }

  /** Hold the connection open (no bytes) for `ms`, then destroy it — the timeout ladder probe. */
  hang(ms: number, match?: LlmMatch): this {
    this.queue.push({ type: 'hang', ms, match })
    return this
  }

  /** Stream `afterChars` characters of `text`, then destroy the socket mid-stream. */
  dieMidStream(opts?: { text?: string; afterChars?: number; match?: LlmMatch }): this {
    this.queue.push({
      type: 'dieMidStream',
      text: opts?.text,
      afterChars: opts?.afterChars,
      match: opts?.match,
    })
    return this
  }

  /** Send SSE headers (+ optional leading text), then go silent — timeout-ladder probe. */
  stall(opts?: { text?: string; match?: LlmMatch }): this {
    this.queue.push({ type: 'stall', text: opts?.text, match: opts?.match })
    return this
  }

  /** Answer with a raw HTTP error (429/500/…), optionally with a Retry-After header. */
  http(status: number, body?: unknown, opts?: { retryAfterMs?: number; match?: LlmMatch }): this {
    this.queue.push({
      type: 'http',
      status,
      body,
      retryAfterMs: opts?.retryAfterMs,
      match: opts?.match,
    })
    return this
  }

  /** Append raw JSON steps (the control-route shape). */
  enqueue(steps: LlmStep[]): this {
    this.queue.push(...steps)
    return this
  }

  reset(): void {
    this.queue.reset()
  }

  assertDrained(): void {
    this.queue.assertDrained()
  }

  get pending(): number {
    return this.queue.pending
  }

  state(): ScenarioState {
    return this.queue.state()
  }
}

export interface MockLlm {
  url: string
  port: number
  scenario: LlmScenario
  /** Every `POST /v1/chat/completions` body received, in order. */
  requests: CapturedChatRequest[]
  close: () => Promise<void>
}

export interface MockLlmOptions {
  /** Model ids listed by `GET /v1/models`. Defaults to `mock-high` and `mock-low`. */
  models?: string[]
  /** Listen port; 0 (default) picks an ephemeral port. */
  port?: number
}

const CREATED = 1_700_000_000

/** Deterministic chars/4 token estimate — stable enough for usage assertions. */
function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

function messageText(message: Record<string, unknown> | undefined): string {
  if (message === undefined) return ''
  const content = message.content
  return typeof content === 'string' ? content : JSON.stringify(content ?? '')
}

function matchStep(step: LlmStep, captured: CapturedChatRequest): string | null {
  const match = step.match
  if (!match) return null
  if (match.model !== undefined && captured.model !== match.model) {
    return `expected model ${JSON.stringify(match.model)}, got ${JSON.stringify(captured.model)}`
  }
  if (match.hasTools !== undefined) {
    const hasTools = Array.isArray(captured.tools) && captured.tools.length > 0
    if (hasTools !== match.hasTools) {
      return `expected hasTools=${match.hasTools}, got ${hasTools}`
    }
  }
  if (match.lastMessageIncludes !== undefined) {
    const last = messageText(captured.messages[captured.messages.length - 1])
    if (!last.includes(match.lastMessageIncludes)) {
      return `last message does not include ${JSON.stringify(match.lastMessageIncludes)}`
    }
  }
  return null
}

/** Deterministic default bodies for improvised background responses. */
export const IMPROVISED_TITLE = 'Improvised Chapter'
export const IMPROVISED_SHORT_SUMMARY =
  'The mock model summarizes the chapter in two steady sentences. Nothing is invented.'
export const IMPROVISED_LONG_SUMMARY =
  'The mock model walks the chapter start to finish in one deterministic paragraph, ' +
  'flat and factual, listing what happened in order and where the prose leaves off.'
/** 08 §4.2 rule 2: one flowing paragraph, 60–120 words — this one is 68. */
export const IMPROVISED_IMAGE_PROMPT =
  'A single quiet room at dusk, seen from a low angle near the doorway, holding one steady ' +
  'moment rather than a montage: warm lamplight pooling across a worn wooden table, dust ' +
  'drifting in the last low sun through a half-open window, long soft shadows stretching ' +
  'toward the foreground, muted amber and grey palette, a stillness that reads as the ' +
  'scene pausing to breathe, medium shot, gentle natural light.'
/** Always accepts on attempt 1 — the improviser exists to keep an UNTRIGGERED background
 *  run quiet, not to exercise the revise loop (08 §4.1, §4.3). */
export const IMPROVISED_CRITIQUE = {
  verdict: 'accept' as const,
  scores: { subject: 4, consistency: 4, craft: 4, mood: 4 },
  overall: 8,
  problems: [] as string[],
  promptAdvice: '',
}

/**
 * Recognize an unscripted background-task request by its template markers and build a
 * deterministic response step; null for anything that is not background-shaped (the
 * caller then falls through to the strict queue and its loud exhausted failure).
 *
 * - enrich-section (07 §6.5's template): instructions name the `<summary-short>` /
 *   `<summary-long>` blocks and carry a `<target>` region. A `<title>` block is only
 *   emitted when the template still asks for one (a user-pinned title drops that line).
 * - propose-boundaries (07 §6.6): instructions name the `<boundaries>` block over a
 *   `<local-context>` of `<snippet id="…">` items; the improviser cuts after the
 *   middle listed snippet (or proposes nothing when none are listed).
 * - illustrate-compose / illustrate-revise (08 §4.2): both ask for one `<image-prompt>`
 *   block — every enrich-section completion auto-triggers `illustrate-section` for a
 *   stale/missing image (05 §6.2), which a test scripting only enrich never asked for.
 * - illustrate-critique (08 §4.3): the VLM critic's fenced-JSON instructions; always
 *   improvised as an immediate accept so the auto-triggered run commits in one attempt.
 */
export function improviseBackgroundStep(captured: CapturedChatRequest): LlmStep | null {
  const last = messageText(captured.messages[captured.messages.length - 1])
  if (last === '') return null

  const enrichShaped =
    last.includes('<summary-short>') && last.includes('<summary-long>') && last.includes('<target>')
  if (enrichShaped) {
    const wantsTitle = last.includes('<title> —')
    const blocks = [
      ...(wantsTitle ? [`<title>\n${IMPROVISED_TITLE}\n</title>`] : []),
      `<summary-short>\n${IMPROVISED_SHORT_SUMMARY}\n</summary-short>`,
      `<summary-long>\n${IMPROVISED_LONG_SUMMARY}\n</summary-long>`,
    ]
    return { type: 'respond', text: blocks.join('\n') }
  }

  const boundariesShaped = last.includes('<boundaries>') && last.includes('<local-context>')
  if (boundariesShaped) {
    const local = last.slice(last.indexOf('<local-context>'))
    const ids = [...local.matchAll(/<snippet id="([^"]+)"/g)].map((m) => m[1] as string)
    const cut = ids[Math.floor((ids.length - 1) / 2)]
    const proposal =
      cut === undefined
        ? { boundaries: [] }
        : { boundaries: [{ afterSnippetId: cut, kind: 'chapter', title: IMPROVISED_TITLE }] }
    return { type: 'respond', text: `<boundaries>\n${JSON.stringify(proposal)}\n</boundaries>` }
  }

  const imagePromptShaped = last.includes('<image-prompt>')
  if (imagePromptShaped) {
    return {
      type: 'respond',
      text: `Sure, here is the prompt:\n<image-prompt>\n${IMPROVISED_IMAGE_PROMPT}\n</image-prompt>`,
    }
  }

  const critiqueShaped = last.includes('Reply with only a single fenced JSON code block')
  if (critiqueShaped) {
    return {
      type: 'respond',
      text: `Here is my review:\n\`\`\`json\n${JSON.stringify(IMPROVISED_CRITIQUE)}\n\`\`\``,
    }
  }

  return null
}

interface CompletionPayload {
  content: string | null
  toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  finishReason: 'stop' | 'tool_calls'
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}

function buildPayload(
  captured: CapturedChatRequest,
  text: string | undefined,
  toolCalls: LlmToolCall[] | undefined,
  counter: number,
): CompletionPayload {
  const calls = (toolCalls ?? []).map((call, i) => ({
    id: `call_mock_${counter}_${i}`,
    type: 'function' as const,
    function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
  }))
  const promptTokens = estimateTokens(captured.messages.map(messageText).join('\n'))
  const completionText = text ?? calls.map((c) => c.function.name + c.function.arguments).join('')
  const completionTokens = estimateTokens(completionText)
  return {
    content: text ?? null,
    toolCalls: calls,
    finishReason: calls.length > 0 ? 'tool_calls' : 'stop',
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  }
}

/** Boot the mock on an ephemeral port. Always `close()` it (afterEach/afterAll). */
export async function createMockLlm(options?: MockLlmOptions): Promise<MockLlm> {
  const models = options?.models ?? ['mock-high', 'mock-low']
  const scenario = new LlmScenario()
  const requests: CapturedChatRequest[] = []
  let completionCounter = 0

  const base: MockHttpServer = await startMockServer(async (req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://mock').pathname

    if (
      await handleControlRoutes(req, res, pathname, scenario.queue, () => {
        scenario.reset()
        requests.length = 0
      })
    ) {
      return
    }

    if (pathname === '/v1/models' && req.method === 'GET') {
      sendJson(res, 200, {
        object: 'list',
        data: models.map((id) => ({
          id,
          object: 'model',
          created: CREATED,
          owned_by: 'cowrite-mock',
        })),
      })
      return
    }

    if (pathname === '/v1/chat/completions' && req.method === 'POST') {
      const body = (await readJsonBody(req)) as Record<string, unknown>
      const captured: CapturedChatRequest = {
        model: typeof body.model === 'string' ? body.model : undefined,
        messages: Array.isArray(body.messages)
          ? (body.messages as Array<Record<string, unknown>>)
          : [],
        tools: Array.isArray(body.tools) ? body.tools : undefined,
        toolChoice: body.tool_choice,
        stream: body.stream === true,
        authorization: req.headers.authorization,
        body,
      }
      requests.push(captured)
      // Background improviser (docs/09 §2.3): an UNSCRIPTED enrich-section /
      // propose-boundaries shaped request (recognized by its template markers) gets a
      // quiet deterministic answer instead of poisoning the strict scenario queue —
      // sweeps and debounced consolidations under COWRITE_MOCK_LLM=1 run whenever they
      // like, and a test cannot script what it did not trigger. Scripted steps always
      // take precedence, and interactive kinds keep the loud exhausted-queue failure.
      const improvised = scenario.queue.pending === 0 ? improviseBackgroundStep(captured) : null
      const step =
        improvised ??
        scenario.queue.take(
          `POST /v1/chat/completions (model=${String(captured.model)}, stream=${captured.stream})`,
          (s) => matchStep(s, captured),
        )
      completionCounter += 1
      await executeStep(step, captured, res, base.timers, completionCounter)
      return
    }

    sendJson(res, 404, {
      error: { type: 'not_found', message: `no route for ${req.method} ${pathname}` },
    })
  }, options?.port ?? 0)

  return {
    url: base.url,
    port: base.port,
    scenario,
    requests,
    close: base.close,
  }
}

async function executeStep(
  step: LlmStep,
  captured: CapturedChatRequest,
  res: ServerResponse,
  timers: TimerPool,
  counter: number,
): Promise<void> {
  switch (step.type) {
    case 'http': {
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (step.retryAfterMs !== undefined) {
        headers['retry-after'] = String(Math.ceil(step.retryAfterMs / 1000))
      }
      res.writeHead(step.status, headers)
      res.end(
        JSON.stringify(
          step.body ?? { error: { type: 'mock_http_error', message: `scripted ${step.status}` } },
        ),
      )
      return
    }
    case 'hang': {
      timers.schedule(() => res.socket?.destroy(), step.ms)
      return
    }
    case 'stall': {
      startSse(res)
      if (step.text !== undefined && step.text !== '') {
        writeDeltaChunks(res, captured, step.text, 5, counter)
      }
      // …then nothing: the connection stays open (headers + any text delivered) until
      // the client times out/aborts or the server closes. Never ends the response.
      return
    }
    case 'dieMidStream': {
      const text = step.text ?? 'This stream is about to die mid-write, partial prose left behind.'
      const afterChars = step.afterChars ?? Math.floor(text.length / 2)
      startSse(res)
      writeDeltaChunks(res, captured, text.slice(0, afterChars), 5, counter)
      // Flush what was written before killing the socket, so the client observes a
      // genuine mid-stream death (partial deltas, then an abrupt close) — destroying
      // immediately would discard the buffered frames and look like a connect failure.
      await new Promise<void>((resolve) => res.write('', () => resolve()))
      res.socket?.destroy()
      return
    }
    case 'respond': {
      const payload = buildPayload(captured, step.text, step.toolCalls, counter)
      if (captured.stream) {
        startSse(res)
        if (payload.content !== null) writeDeltaChunks(res, captured, payload.content, 24, counter)
        for (const [i, call] of payload.toolCalls.entries()) {
          writeChunk(res, captured, counter, {
            delta: {
              tool_calls: [{ index: i, id: call.id, type: call.type, function: call.function }],
            },
            finish_reason: null,
          })
        }
        finishSse(res, captured, payload, counter)
      } else {
        sendCompletion(res, captured, payload, counter)
      }
      return
    }
    case 'respondStream': {
      const payload = buildPayload(captured, step.text, undefined, counter)
      if (!captured.stream) {
        sendCompletion(res, captured, payload, counter)
        return
      }
      startSse(res)
      const chunkSize = Math.max(1, step.chunkSize ?? 24)
      const delayMs = step.delayMs ?? 0
      for (let at = 0; at < step.text.length; at += chunkSize) {
        if (res.writableEnded || res.socket?.destroyed) return
        writeChunk(res, captured, counter, {
          delta: { content: step.text.slice(at, at + chunkSize) },
          finish_reason: null,
        })
        if (delayMs > 0) await timers.sleep(delayMs)
      }
      finishSse(res, captured, payload, counter)
      return
    }
  }
}

function startSse(res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
}

function chunkEnvelope(captured: CapturedChatRequest, counter: number): Record<string, unknown> {
  return {
    id: `chatcmpl-mock-${counter}`,
    object: 'chat.completion.chunk',
    created: CREATED,
    model: captured.model ?? 'mock',
  }
}

function writeChunk(
  res: ServerResponse,
  captured: CapturedChatRequest,
  counter: number,
  choice: { delta: Record<string, unknown>; finish_reason: string | null },
): void {
  const payload = { ...chunkEnvelope(captured, counter), choices: [{ index: 0, ...choice }] }
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function writeDeltaChunks(
  res: ServerResponse,
  captured: CapturedChatRequest,
  text: string,
  chunkSize: number,
  counter: number,
): void {
  for (let at = 0; at < text.length; at += chunkSize) {
    writeChunk(res, captured, counter, {
      delta: { content: text.slice(at, at + chunkSize) },
      finish_reason: null,
    })
  }
}

function finishSse(
  res: ServerResponse,
  captured: CapturedChatRequest,
  payload: CompletionPayload,
  counter: number,
): void {
  if (res.writableEnded || res.socket?.destroyed) return
  writeChunk(res, captured, counter, { delta: {}, finish_reason: payload.finishReason })
  // Usage rides in the final data chunk (the `stream_options.include_usage` shape).
  res.write(
    `data: ${JSON.stringify({ ...chunkEnvelope(captured, counter), choices: [], usage: payload.usage })}\n\n`,
  )
  res.write('data: [DONE]\n\n')
  res.end()
}

function sendCompletion(
  res: ServerResponse,
  captured: CapturedChatRequest,
  payload: CompletionPayload,
  counter: number,
): void {
  sendJson(res, 200, {
    id: `chatcmpl-mock-${counter}`,
    object: 'chat.completion',
    created: CREATED,
    model: captured.model ?? 'mock',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: payload.content,
          ...(payload.toolCalls.length > 0 ? { tool_calls: payload.toolCalls } : {}),
        },
        finish_reason: payload.finishReason,
      },
    ],
    usage: payload.usage,
  })
}
