import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { createMockLlm, type MockLlm } from '@cowrite/mock-llm'
import { HarnessKnobs, type HarnessKnobsOverrides, ModelEndpoint } from '@cowrite/shared'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  ModelClientError,
  OpenAiCompatClient,
  parseRetryAfterMs,
  RETRY_AFTER_CAP_MS,
  type ToolCallDelta,
} from './client.js'

/**
 * Model-client tests against `@cowrite/mock-llm` scenarios (docs/09 §2.3): one server
 * booted for the whole file, scenario + captured requests reset per test, every test
 * ending drained. A handful of byte-level cases (SSE lines split mid-JSON, tool-call
 * arguments split across chunks, a stream that omits usage) use a one-shot raw
 * `node:http` responder below — framing surgery the scenario API deliberately does not
 * expose.
 */

let llm: MockLlm

beforeAll(async () => {
  llm = await createMockLlm()
})

afterAll(async () => {
  await llm.close()
})

beforeEach(() => {
  llm.scenario.reset()
  llm.requests.length = 0
})

afterEach(() => {
  llm.scenario.assertDrained()
})

/** Millisecond-scale knobs so reliability tests run fast; overridable per test. */
function fastKnobs(overrides: HarnessKnobsOverrides = {}): HarnessKnobs {
  return HarnessKnobs.parse({
    connectTimeoutMs: 2_000,
    firstTokenTimeoutMs: 1_000,
    idleTokenTimeoutMs: 1_000,
    totalTimeoutMs: { high: 5_000, low: 5_000 },
    retry: { maxAttempts: 3, backoffMs: 1, backoffMaxMs: 4 },
    ...overrides,
  })
}

function clientFor(baseUrl: string, overrides: HarnessKnobsOverrides = {}) {
  return new OpenAiCompatClient({
    lane: 'high',
    endpoint: ModelEndpoint.parse({
      baseUrl,
      apiKey: 'test-key',
      model: 'mock-high',
      temperature: 0.4,
      maxOutputTokens: 512,
    }),
    knobs: fastKnobs(overrides),
    allowImageParts: false,
  })
}

function makeClient(overrides: HarnessKnobsOverrides = {}) {
  return clientFor(`${llm.url}/v1`, overrides)
}

const userMessage = { role: 'user' as const, content: 'Write the next paragraph.' }

function endpoint() {
  return ModelEndpoint.parse({ baseUrl: `${llm.url}/v1`, apiKey: '', model: 'mock-high' })
}

/** chars/4 with the mock's floor — the usage arithmetic `@cowrite/mock-llm` reports. */
function mockTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

describe('streaming happy path', () => {
  it('streams deltas in order, reads usage from the final chunk, returns finishReason', async () => {
    llm.scenario.respondStream('Once upon a time.', { chunkSize: 6 })
    const deltas: string[] = []
    const result = await makeClient().chat(
      { messages: [userMessage] },
      { onDelta: (d) => deltas.push(d) },
    )

    expect(deltas).toEqual(['Once u', 'pon a ', 'time.'])
    expect(result.text).toBe('Once upon a time.')
    expect(result.finishReason).toBe('stop')
    expect(result.toolCalls).toEqual([])
    // Usage rides the final data chunk (`stream_options.include_usage` shape) and is
    // the provider's own accounting — estimated:false.
    expect(result.usage).toEqual({
      promptTokens: mockTokens(userMessage.content),
      completionTokens: mockTokens('Once upon a time.'),
      estimated: false,
    })
  })

  it('sends OpenAI wire shape: endpoint params, stream_options, bearer auth', async () => {
    llm.scenario.respond('ok')
    await makeClient().chat({
      messages: [userMessage],
      tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
      toolChoice: 'none',
    })

    const req = llm.requests[0]
    expect(req?.authorization).toBe('Bearer test-key')
    expect(req?.body).toMatchObject({
      model: 'mock-high',
      temperature: 0.4,
      max_tokens: 512,
      stream: true,
      stream_options: { include_usage: true },
      tool_choice: 'none',
    })
    expect(req?.tools).toHaveLength(1)
  })

  it('omits reasoning and provider fields entirely when unconfigured', async () => {
    llm.scenario.respond('ok')
    await makeClient().chat({ messages: [userMessage] })
    const body = llm.requests[0]?.body ?? {}
    expect('reasoning' in body).toBe(false)
    expect('reasoning_effort' in body).toBe(false)
    expect('provider' in body).toBe(false)
  })

  it('effort alone rides the OpenAI-standard reasoning_effort field', async () => {
    llm.scenario.respond('ok')
    const client = new OpenAiCompatClient({
      lane: 'low',
      endpoint: ModelEndpoint.parse({
        baseUrl: `${llm.url}/v1`,
        model: 'mock-low',
        reasoning: { effort: 'low' },
      }),
      knobs: fastKnobs(),
      allowImageParts: true,
    })
    await client.chat({ messages: [userMessage] })
    const body = llm.requests[0]?.body ?? {}
    expect(body.reasoning_effort).toBe('low')
    expect('reasoning' in body).toBe(false) // no object form when only effort is set
  })

  it('a maxTokens cap wins over effort (OpenRouter forbids both) and uses the reasoning object', async () => {
    llm.scenario.respond('ok')
    const client = new OpenAiCompatClient({
      lane: 'low',
      endpoint: ModelEndpoint.parse({
        baseUrl: `${llm.url}/v1`,
        model: 'mock-low',
        reasoning: { effort: 'medium', maxTokens: 256, exclude: true },
      }),
      knobs: fastKnobs(),
      allowImageParts: true,
    })
    await client.chat({ messages: [userMessage] })
    const body = llm.requests[0]?.body ?? {}
    // effort is dropped — never sent alongside max_tokens
    expect(body.reasoning).toEqual({ max_tokens: 256, exclude: true })
    expect('reasoning_effort' in body).toBe(false)
  })

  it('exclude with effort (no cap) rides the reasoning object, not the top-level alias', async () => {
    llm.scenario.respond('ok')
    const client = new OpenAiCompatClient({
      lane: 'low',
      endpoint: ModelEndpoint.parse({
        baseUrl: `${llm.url}/v1`,
        model: 'mock-low',
        reasoning: { effort: 'high', exclude: true },
      }),
      knobs: fastKnobs(),
      allowImageParts: true,
    })
    await client.chat({ messages: [userMessage] })
    expect(llm.requests[0]?.body.reasoning).toEqual({ effort: 'high', exclude: true })
  })

  it('passes OpenRouter provider routing through verbatim', async () => {
    llm.scenario.respond('ok')
    const provider = { quantizations: ['fp16'], sort: 'throughput', allow_fallbacks: false }
    const client = new OpenAiCompatClient({
      lane: 'low',
      endpoint: ModelEndpoint.parse({
        baseUrl: `${llm.url}/v1`,
        model: 'mock-low',
        provider,
      }),
      knobs: fastKnobs(),
      allowImageParts: true,
    })
    await client.chat({ messages: [userMessage] })
    expect(llm.requests[0]?.body.provider).toEqual(provider)
  })
})

describe('tool-call accumulation', () => {
  it('accumulates tool_calls arriving as separate chunks by index', async () => {
    llm.scenario.respond({
      toolCalls: [
        { name: 'lookup', arguments: { query: 'cats' } },
        { name: 'cite', arguments: {} },
      ],
    })
    const seen: ToolCallDelta[] = []
    const result = await makeClient().chat(
      { messages: [userMessage] },
      { onToolCallDelta: (d) => seen.push(d) },
    )
    expect(result.finishReason).toBe('tool_calls')
    expect(result.toolCalls.map((c) => c.name)).toEqual(['lookup', 'cite'])
    expect(result.toolCalls[0]?.argumentsJson).toBe('{"query":"cats"}')
    expect(seen.length).toBeGreaterThanOrEqual(2)
  })
})

describe('reliability', () => {
  it('die-mid-stream surfaces a typed retryable error with the partial text, no silent retry', async () => {
    llm.scenario.dieMidStream({ text: 'Three good paragraphs', afterChars: 21 })

    const err = await makeClient()
      .chat({ messages: [userMessage] })
      .then(() => null)
      .catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ModelClientError)
    const typed = err as ModelClientError
    expect(typed.code).toBe('endpoint_unreachable')
    expect(typed.retryable).toBe(true)
    expect(typed.partialText).toBe('Three good paragraphs')
    // deltas were delivered — the client must NOT replay internally (05 §6.5: runner policy)
    expect(llm.requests).toHaveLength(1)
  })

  it('retries a 429 with Retry-After honored, then succeeds', async () => {
    llm.scenario.http(429, undefined, { retryAfterMs: 0 }).respondStream('recovered')
    const result = await makeClient().chat({ messages: [userMessage] })
    expect(result.text).toBe('recovered')
    expect(llm.requests).toHaveLength(2)
  })

  it('onRetry fires before each pre-delivery retry with the classified error', async () => {
    llm.scenario.http(429, undefined, { retryAfterMs: 0 }).respondStream('recovered')
    const seen: string[] = []
    const result = await makeClient().chat(
      { messages: [userMessage] },
      { onRetry: (err) => seen.push(err.code) },
    )
    expect(result.text).toBe('recovered')
    expect(seen).toEqual(['rate_limited']) // numbering is the caller's (05 §6.5)
  })

  it('onRetry never fires when deltas were already delivered (mid-stream death)', async () => {
    llm.scenario.dieMidStream({ text: 'partial ', afterChars: 8 })
    const seen: string[] = []
    const err = await makeClient()
      .chat({ messages: [userMessage] }, { onRetry: (e) => seen.push(e.code) })
      .then(() => null)
      .catch((e: unknown) => e)
    expect((err as ModelClientError).retryable).toBe(true)
    expect(seen).toEqual([]) // the runner owns mid-stream replay policy (05 §6.5)
  })

  it('attemptBudget caps TOTAL calls below knobs.retry.maxAttempts (one shared budget)', async () => {
    llm.scenario.http(429).http(429)
    const err = await makeClient({ retry: { maxAttempts: 5, backoffMs: 1, backoffMaxMs: 2 } })
      .chat({ messages: [userMessage] }, { attemptBudget: 2 })
      .then(() => null)
      .catch((e: unknown) => e)
    expect((err as ModelClientError).code).toBe('rate_limited')
    expect(llm.requests).toHaveLength(2) // budget 2, NOT the knob's 5
  })

  it('caps an honored Retry-After at 30 s (a hostile 3600 s header never parks the lane)', async () => {
    llm.scenario.http(429, undefined, { retryAfterMs: 3_600_000 }).respondStream('ok')
    const sleeps: number[] = []
    const client = new OpenAiCompatClient({
      lane: 'high',
      endpoint: endpoint(),
      knobs: fastKnobs({ totalTimeoutMs: { high: 600_000, low: 600_000 } }),
      sleepImpl: async (ms) => {
        sleeps.push(ms)
      },
    })
    const result = await client.chat({ messages: [userMessage] })
    expect(result.text).toBe('ok')
    expect(sleeps).toEqual([RETRY_AFTER_CAP_MS]) // min(3 600 000, 30 000, remaining total)
  })

  it('caps the retry wait at the REMAINING total budget when that is smaller', async () => {
    llm.scenario.http(429, undefined, { retryAfterMs: 3_600_000 }).respondStream('ok')
    const sleeps: number[] = []
    const client = new OpenAiCompatClient({
      lane: 'high',
      endpoint: endpoint(),
      knobs: fastKnobs(), // totalTimeoutMs.high = 5 000 — smaller than the 30 s cap
      sleepImpl: async (ms) => {
        sleeps.push(ms)
      },
    })
    const result = await client.chat({ messages: [userMessage] })
    expect(result.text).toBe('ok')
    expect(sleeps).toHaveLength(1)
    expect(sleeps[0]).toBeLessThanOrEqual(5_000)
  })

  it('cancel during a Retry-After wait settles immediately (abort-aware sleep)', async () => {
    llm.scenario.http(429, undefined, { retryAfterMs: 3_600_000 })
    const ac = new AbortController()
    const client = new OpenAiCompatClient({
      lane: 'high',
      endpoint: endpoint(),
      knobs: fastKnobs({ totalTimeoutMs: { high: 600_000, low: 600_000 } }),
      // a REAL timer sleep: the abort race, not the sleep, must settle the call
      sleepImpl: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    })
    const started = Date.now()
    const pending = client
      .chat({ messages: [userMessage] }, { signal: ac.signal })
      .then(() => null)
      .catch((e: unknown) => e)
    setTimeout(() => ac.abort(new Error('cancelled by user')), 20)
    const err = await pending
    expect(Date.now() - started).toBeLessThan(2_000) // never the 30 s honored wait
    expect(String(err)).toContain('cancelled by user')
  })

  it('exhausted 429 retries throw rate_limited after maxAttempts requests', async () => {
    llm.scenario.http(429).http(429)
    const err = await makeClient({ retry: { maxAttempts: 2, backoffMs: 1, backoffMaxMs: 2 } })
      .chat({ messages: [userMessage] })
      .then(() => null)
      .catch((e: unknown) => e)

    expect((err as ModelClientError).code).toBe('rate_limited')
    expect((err as ModelClientError).retryable).toBe(true)
    expect(llm.requests).toHaveLength(2)
  })

  it('never retries 4xx validation or auth failures', async () => {
    llm.scenario.http(401)
    const authErr = await makeClient()
      .chat({ messages: [userMessage] })
      .then(() => null)
      .catch((e: unknown) => e)
    expect((authErr as ModelClientError).code).toBe('auth')
    expect((authErr as ModelClientError).retryable).toBe(false)
    expect(llm.requests).toHaveLength(1)

    llm.scenario.http(400)
    const valErr = await makeClient()
      .chat({ messages: [userMessage] })
      .then(() => null)
      .catch((e: unknown) => e)
    expect((valErr as ModelClientError).code).toBe('validation')
    expect((valErr as ModelClientError).retryable).toBe(false)
    expect(llm.requests).toHaveLength(2)
  })

  it('idle-gap timeout fires while chunks stall mid-stream', async () => {
    llm.scenario.stall({ text: 'started then ' }) // SSE head + text, then silence

    const err = await makeClient()
      .chat({ messages: [userMessage] }, { timeouts: { idleGapMs: 100 } })
      .then(() => null)
      .catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ModelClientError)
    const typed = err as ModelClientError
    expect(typed.code).toBe('timeout')
    expect(typed.timeoutKind).toBe('idle-gap')
    expect(typed.retryable).toBe(true)
    expect(typed.partialText).toBe('started then ')
    expect(llm.requests).toHaveLength(1) // deltas delivered ⇒ runner owns the replay
  })

  it('first-token timeout fires when the stream never starts', async () => {
    llm.scenario.stall() // headers only, no body bytes
    const err = await makeClient({ retry: { maxAttempts: 1, backoffMs: 1, backoffMaxMs: 2 } })
      .chat({ messages: [userMessage] }, { timeouts: { firstTokenMs: 80 } })
      .then(() => null)
      .catch((e: unknown) => e)

    const typed = err as ModelClientError
    expect(typed.code).toBe('timeout')
    expect(typed.timeoutKind).toBe('first-token')
    expect(typed.retryable).toBe(true)
  })

  it('caller abort propagates untouched — never wrapped, never retried', async () => {
    llm.scenario.stall() // stall until aborted
    const ac = new AbortController()
    const pending = makeClient()
      .chat({ messages: [userMessage] }, { signal: ac.signal })
      .then(() => null)
      .catch((e: unknown) => e)
    setTimeout(() => ac.abort(), 30)

    const err = await pending
    expect(err).not.toBeInstanceOf(ModelClientError)
    expect((err as Error).name).toBe('AbortError')
    expect(llm.requests).toHaveLength(1)
  })
})

describe('non-stream fallback', () => {
  it('parses a plain JSON completion when stream:false', async () => {
    llm.scenario.enqueue([
      { type: 'respond', text: 'plain answer', toolCalls: [{ name: 'cite', arguments: {} }] },
    ])
    const result = await makeClient().chat({ messages: [userMessage], stream: false })
    expect(result.text).toBe('plain answer')
    expect(result.finishReason).toBe('tool_calls') // tool calls present ⇒ provider says so
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0]).toMatchObject({ name: 'cite', argumentsJson: '{}' })
    expect(result.usage).toMatchObject({ estimated: false })
    expect(llm.requests[0]?.body.stream).toBe(false)
    expect(llm.requests[0]?.body.stream_options).toBeUndefined()
  })
})

describe('parseRetryAfterMs', () => {
  it('parses delta-seconds and rejects garbage', () => {
    expect(parseRetryAfterMs('2')).toBe(2000)
    expect(parseRetryAfterMs('0')).toBe(0)
    expect(parseRetryAfterMs('soon')).toBeNull()
    expect(parseRetryAfterMs(null)).toBeNull()
  })

  it('parses an HTTP-date relative to now', () => {
    const inTwoSeconds = new Date(Date.now() + 2000).toUTCString()
    const ms = parseRetryAfterMs(inTwoSeconds)
    expect(ms).not.toBeNull()
    expect(ms as number).toBeGreaterThanOrEqual(0)
    expect(ms as number).toBeLessThanOrEqual(2500)
  })
})

// ---------------------------------------------------------------------------
// Byte-level SSE framing cases: a one-shot raw responder (the scenario API keeps
// its steps JSON-serializable, so it cannot split bytes mid-JSON or omit usage).
// ---------------------------------------------------------------------------

async function withRawResponder(
  respond: (res: ServerResponse) => void,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const sockets = new Set<Socket>()
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => respond(res))
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  try {
    await run(`http://127.0.0.1:${port}/v1`)
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

function sseHead(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
}

function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

function contentChunk(content: string): unknown {
  return { choices: [{ index: 0, delta: { content } }] }
}

function finishChunk(reason: string): unknown {
  return { choices: [{ index: 0, delta: {}, finish_reason: reason }] }
}

describe('byte-level SSE framing (raw responder)', () => {
  it('reassembles SSE data lines split across chunk boundaries', async () => {
    const line = sseData(contentChunk('Hello world'))
    await withRawResponder(
      (res) => {
        sseHead(res)
        res.write(line.slice(0, 18)) // mid-JSON split
        setTimeout(() => {
          res.write(line.slice(18))
          res.write(sseData(finishChunk('stop')))
          res.write('data: [DONE]\n\n')
          res.end()
        }, 20)
      },
      async (baseUrl) => {
        const result = await clientFor(baseUrl).chat({ messages: [userMessage] })
        expect(result.text).toBe('Hello world')
        expect(result.finishReason).toBe('stop')
      },
    )
  })

  it('accumulates tool_calls deltas by index with arguments split across chunks', async () => {
    await withRawResponder(
      (res) => {
        sseHead(res)
        res.write(
          sseData({
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    { index: 0, id: 'call_1', function: { name: 'lookup', arguments: '{"qu' } },
                  ],
                },
              },
            ],
          }),
        )
        res.write(
          sseData({
            choices: [
              {
                index: 0,
                delta: { tool_calls: [{ index: 0, function: { arguments: 'ery":"cats"}' } }] },
              },
            ],
          }),
        )
        res.write(sseData(finishChunk('tool_calls')))
        res.write('data: [DONE]\n\n')
        res.end()
      },
      async (baseUrl) => {
        const seen: ToolCallDelta[] = []
        const result = await clientFor(baseUrl).chat(
          { messages: [userMessage] },
          { onToolCallDelta: (d) => seen.push(d) },
        )
        expect(result.finishReason).toBe('tool_calls')
        expect(result.toolCalls).toEqual([
          { id: 'call_1', name: 'lookup', argumentsJson: '{"query":"cats"}' },
        ])
        expect(seen[0]).toEqual({ index: 0, id: 'call_1', name: 'lookup', argumentsDelta: '{"qu' })
      },
    )
  })

  it('estimates chars/4 flagged estimated:true when the endpoint omits usage', async () => {
    await withRawResponder(
      (res) => {
        sseHead(res)
        res.write(sseData(contentChunk('abcdefgh'))) // 8 chars, no usage chunk
        res.write(sseData(finishChunk('stop')))
        res.write('data: [DONE]\n\n')
        res.end()
      },
      async (baseUrl) => {
        const result = await clientFor(baseUrl).chat({ messages: [userMessage] })
        expect(result.usage).toEqual({
          promptTokens: Math.ceil(userMessage.content.length / 4),
          completionTokens: 2,
          estimated: true,
        })
      },
    )
  })
})
