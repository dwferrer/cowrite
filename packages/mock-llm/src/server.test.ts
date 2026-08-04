import { afterEach, describe, expect, it } from 'vitest'
import { createMockLlm, type MockLlm } from './server.js'
import { postJson, readSse } from './testUtil.js'

let llm: MockLlm

afterEach(async () => {
  await llm.close()
})

function chatUrl(): string {
  return `${llm.url}/v1/chat/completions`
}

const BASE_REQUEST = {
  model: 'mock-high',
  messages: [
    { role: 'system', content: 'You are a co-writer.' },
    { role: 'user', content: 'Continue the story.' },
  ],
}

describe('GET /v1/models', () => {
  it('lists the configured model ids', async () => {
    llm = await createMockLlm()
    const res = await fetch(`${llm.url}/v1/models`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { object: string; data: Array<{ id: string }> }
    expect(body.object).toBe('list')
    expect(body.data.map((m) => m.id)).toEqual(['mock-high', 'mock-low'])
  })
})

describe('non-streaming completions', () => {
  it('responds with scripted text, finish_reason stop, and usage', async () => {
    llm = await createMockLlm()
    llm.scenario.respond('Mara pressed on through the storm.')
    const res = await postJson(chatUrl(), BASE_REQUEST)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      choices: Array<{ message: { role: string; content: string }; finish_reason: string }>
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
    }
    expect(body.choices[0]?.message.content).toBe('Mara pressed on through the storm.')
    expect(body.choices[0]?.finish_reason).toBe('stop')
    expect(body.usage.total_tokens).toBe(body.usage.prompt_tokens + body.usage.completion_tokens)
    expect(body.usage.completion_tokens).toBeGreaterThan(0)
    llm.scenario.assertDrained()
  })

  it('responds with a scripted tool call', async () => {
    llm = await createMockLlm()
    llm.scenario.respond({
      toolCall: {
        name: 'context_expand',
        arguments: { kind: 'section', id: 'ch7', level: 'full' },
      },
    })
    const res = await postJson(chatUrl(), { ...BASE_REQUEST, tools: [{ type: 'function' }] })
    const body = (await res.json()) as {
      choices: Array<{
        message: {
          content: null
          tool_calls: Array<{ function: { name: string; arguments: string } }>
        }
        finish_reason: string
      }>
    }
    const choice = body.choices[0]
    expect(choice?.finish_reason).toBe('tool_calls')
    expect(choice?.message.content).toBeNull()
    expect(choice?.message.tool_calls[0]?.function.name).toBe('context_expand')
    expect(JSON.parse(choice?.message.tool_calls[0]?.function.arguments ?? '')).toEqual({
      kind: 'section',
      id: 'ch7',
      level: 'full',
    })
    llm.scenario.assertDrained()
  })

  it('captures the incoming request for assertions', async () => {
    llm = await createMockLlm()
    llm.scenario.respond('ok')
    await fetch(chatUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-key' },
      body: JSON.stringify({ ...BASE_REQUEST, temperature: 0.7, tool_choice: 'none' }),
    })
    expect(llm.requests).toHaveLength(1)
    const captured = llm.requests[0]
    expect(captured?.model).toBe('mock-high')
    expect(captured?.messages).toHaveLength(2)
    expect(captured?.toolChoice).toBe('none')
    expect(captured?.stream).toBe(false)
    expect(captured?.authorization).toBe('Bearer test-key')
    expect(captured?.body.temperature).toBe(0.7)
  })

  it('enforces match predicates: wrong model fails loudly with 500', async () => {
    llm = await createMockLlm()
    llm.scenario.respond('high only', { model: 'mock-high' })
    const res = await postJson(chatUrl(), { ...BASE_REQUEST, model: 'mock-low' })
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: { type: string; message: string } }
    expect(body.error.type).toBe('mock_scenario_error')
    expect(body.error.message).toContain('expected model "mock-high"')
    expect(() => llm.scenario.assertDrained()).toThrow(/expected model/)
    llm.scenario.reset()
  })

  it('fails loudly on an unscripted request', async () => {
    llm = await createMockLlm()
    const res = await postJson(chatUrl(), BASE_REQUEST)
    expect(res.status).toBe(500)
    expect(() => llm.scenario.assertDrained()).toThrow(/unscripted request/)
    llm.scenario.reset()
  })
})

describe('streaming completions', () => {
  it('streams delta.content chunks with finish_reason and usage in the final data chunk', async () => {
    llm = await createMockLlm()
    const text = 'The storm glass shattered on the deck, and everyone went quiet.'
    llm.scenario.respondStream(text, { chunkSize: 7 })
    const res = await postJson(chatUrl(), {
      ...BASE_REQUEST,
      stream: true,
      stream_options: { include_usage: true },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const events = await readSse(res)
    expect(events.at(-1)).toBe('[DONE]')

    const parsed = events.slice(0, -1).map((e) => JSON.parse(e) as Record<string, unknown>)
    const deltas = parsed
      .map((p) => (p.choices as Array<{ delta?: { content?: string } }>)[0]?.delta?.content)
      .filter((c): c is string => typeof c === 'string')
    expect(deltas.join('')).toBe(text)
    expect(deltas[0]).toBe('The sto') // chunkSize honored

    const finish = parsed.find(
      (p) => (p.choices as Array<{ finish_reason: string | null }>)[0]?.finish_reason !== null,
    ) as { choices: Array<{ finish_reason: string }> } | undefined
    expect(finish?.choices[0]?.finish_reason).toBe('stop')

    const usageChunk = parsed.at(-1) as {
      choices: unknown[]
      usage: { prompt_tokens: number; completion_tokens: number }
    }
    expect(usageChunk.choices).toEqual([])
    expect(usageChunk.usage.completion_tokens).toBeGreaterThan(0)
    llm.scenario.assertDrained()
  })

  it('paces chunks with delayMs without leaving timers dangling', async () => {
    llm = await createMockLlm()
    llm.scenario.respondStream('abcdef', { chunkSize: 2, delayMs: 5 })
    const res = await postJson(chatUrl(), { ...BASE_REQUEST, stream: true })
    const events = await readSse(res)
    const deltas = events
      .filter((e) => e !== '[DONE]')
      .map((e) => JSON.parse(e) as { choices: Array<{ delta?: { content?: string } }> })
      .map((p) => p.choices[0]?.delta?.content)
      .filter((c): c is string => typeof c === 'string')
    expect(deltas).toEqual(['ab', 'cd', 'ef'])
    llm.scenario.assertDrained()
  })

  it('streams tool calls as delta.tool_calls', async () => {
    llm = await createMockLlm()
    llm.scenario.respond({ toolCall: { name: 'finish_planning', arguments: {} } })
    const res = await postJson(chatUrl(), { ...BASE_REQUEST, stream: true })
    const events = await readSse(res)
    const withTool = events
      .filter((e) => e !== '[DONE]')
      .map((e) => JSON.parse(e) as { choices: Array<{ delta?: { tool_calls?: unknown[] } }> })
      .find((p) => p.choices[0]?.delta?.tool_calls !== undefined)
    expect(withTool).toBeDefined()
    const call = withTool?.choices[0]?.delta?.tool_calls?.[0] as {
      function: { name: string; arguments: string }
    }
    expect(call.function.name).toBe('finish_planning')
    const finish = events
      .filter((e) => e !== '[DONE]')
      .map((e) => JSON.parse(e) as { choices: Array<{ finish_reason: string | null }> })
      .find((p) => p.choices[0]?.finish_reason !== null)
    expect(finish?.choices[0]?.finish_reason).toBe('tool_calls')
    llm.scenario.assertDrained()
  })

  it('dieMidStream delivers a partial then kills the socket', async () => {
    llm = await createMockLlm()
    const text = 'This prose will be cut off before it finishes properly.'
    llm.scenario.dieMidStream({ text, afterChars: 20 })
    const res = await postJson(chatUrl(), { ...BASE_REQUEST, stream: true })
    expect(res.status).toBe(200)
    let failure: (Error & { collected?: string[] }) | undefined
    try {
      await readSse(res)
    } catch (err) {
      failure = err as Error & { collected?: string[] }
    }
    expect(failure).toBeDefined()
    const deltas = (failure?.collected ?? [])
      .map((e) => JSON.parse(e) as { choices: Array<{ delta?: { content?: string } }> })
      .map((p) => p.choices[0]?.delta?.content)
      .filter((c): c is string => typeof c === 'string')
    expect(deltas.join('')).toBe(text.slice(0, 20))
    llm.scenario.assertDrained()
  })
})

describe('failure injection', () => {
  it('http(429) returns the status, body, and Retry-After', async () => {
    llm = await createMockLlm()
    llm.scenario.http(429, { error: { message: 'rate limited' } }, { retryAfterMs: 2000 })
    const res = await postJson(chatUrl(), BASE_REQUEST)
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('2')
    const body = (await res.json()) as { error: { message: string } }
    expect(body.error.message).toBe('rate limited')
    llm.scenario.assertDrained()
  })

  it('http(500) then a scripted success supports retry-ladder tests', async () => {
    llm = await createMockLlm()
    llm.scenario.http(500).respond('recovered')
    const first = await postJson(chatUrl(), BASE_REQUEST)
    expect(first.status).toBe(500)
    const second = await postJson(chatUrl(), BASE_REQUEST)
    const body = (await second.json()) as { choices: Array<{ message: { content: string } }> }
    expect(body.choices[0]?.message.content).toBe('recovered')
    llm.scenario.assertDrained()
  })

  it('hang(ms) holds then destroys the connection so clients see a network error', async () => {
    llm = await createMockLlm()
    llm.scenario.hang(30)
    await expect(postJson(chatUrl(), BASE_REQUEST)).rejects.toThrow()
    llm.scenario.assertDrained()
  })

  it('stall sends SSE headers (+ optional text) then silence — first-token/idle probes', async () => {
    llm = await createMockLlm()
    llm.scenario.stall({ text: 'started then ' })
    const res = await postJson(chatUrl(), { ...BASE_REQUEST, stream: true })
    // Headers arrived (unlike `hang`), so the client's FIRST-token/idle timers govern.
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    // The leading text is delivered (as delta.content frames), then nothing more.
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    const first = await reader.read()
    const deltas = new TextDecoder()
      .decode(first.value)
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map(
        (line) => JSON.parse(line.slice(6)) as { choices: Array<{ delta?: { content?: string } }> },
      )
      .map((p) => p.choices[0]?.delta?.content ?? '')
      .join('')
    expect(deltas).toBe('started then ')
    const second = await Promise.race([
      reader.read().then(() => 'more-bytes'),
      new Promise((resolve) => setTimeout(resolve, 120, 'silence')),
    ])
    expect(second).toBe('silence')
    await reader.cancel()
    llm.scenario.assertDrained()
  })

  it('close() while hanging clears the timer and the socket (no dangling handles)', async () => {
    llm = await createMockLlm()
    llm.scenario.hang(60_000)
    const pending = postJson(chatUrl(), BASE_REQUEST).catch(() => 'errored')
    // Give the request time to reach the server before tearing down.
    await new Promise((resolve) => setTimeout(resolve, 25))
    await llm.close()
    expect(await pending).toBe('errored')
    llm = await createMockLlm() // afterEach closes this one
  })
})

describe('control routes', () => {
  it('POST /__mock/scenario enqueues raw JSON steps usable cross-process', async () => {
    llm = await createMockLlm()
    const enqueue = await postJson(`${llm.url}/__mock/scenario`, [
      { type: 'respond', text: 'from the control route' },
    ])
    expect(enqueue.status).toBe(200)
    const res = await postJson(chatUrl(), BASE_REQUEST)
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> }
    expect(body.choices[0]?.message.content).toBe('from the control route')
    llm.scenario.assertDrained()
  })

  it('GET /__mock/state reports pending/consumed/errors; POST /__mock/reset clears', async () => {
    llm = await createMockLlm()
    llm.scenario.respond('one').respond('two')
    await postJson(chatUrl(), BASE_REQUEST)
    const state = (await (await fetch(`${llm.url}/__mock/state`)).json()) as {
      pending: number
      consumed: number
      errors: string[]
    }
    expect(state).toEqual({ pending: 1, consumed: 1, errors: [] })

    const reset = await postJson(`${llm.url}/__mock/reset`, {})
    expect(reset.status).toBe(200)
    const after = (await (await fetch(`${llm.url}/__mock/state`)).json()) as { pending: number }
    expect(after.pending).toBe(0)
    expect(llm.requests).toHaveLength(0) // reset also clears captures
    llm.scenario.assertDrained()
  })
})

describe('background improviser (unscripted enrich/boundaries requests)', () => {
  const ENRICH_PROMPT =
    '<instructions>\nProduce, in this order:\n' +
    '<title> — a human-readable chapter name.\n' +
    '<summary-short> — 2–4 sentences.\n<summary-long> — 1–3 paragraphs.\n</instructions>\n' +
    '<target>\n<section id="01JGSEC" name="" fidelity="full">\nProse.\n</section>\n</target>'
  const BOUNDARIES_PROMPT =
    '<instructions>\nPropose boundaries as one <boundaries> block containing only JSON.\n' +
    '</instructions>\n<local-context>\n' +
    '<snippet id="01JGAAA">\nOne.\n</snippet>\n' +
    '<snippet id="01JGBBB">\nTwo.\n</snippet>\n' +
    '<snippet id="01JGCCC">\nThree.\n</snippet>\n</local-context>'

  const chat = (content: string) =>
    postJson(chatUrl(), { model: 'mock-low', messages: [{ role: 'user', content }] })

  it('improvises an enrich-shaped request when the queue is empty — no poisoning', async () => {
    llm = await createMockLlm()
    const res = await chat(ENRICH_PROMPT)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> }
    const text = body.choices[0]?.message.content ?? ''
    expect(text).toContain('<title>')
    expect(text).toContain('<summary-short>')
    expect(text).toContain('<summary-long>')
    llm.scenario.assertDrained() // nothing scripted, nothing failed
  })

  it('drops the <title> block when the template pinned the title away', async () => {
    llm = await createMockLlm()
    const pinned = ENRICH_PROMPT.replace('<title> — a human-readable chapter name.\n', '')
    const res = await chat(pinned)
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> }
    const text = body.choices[0]?.message.content ?? ''
    expect(text).not.toContain('<title>')
    expect(text).toContain('<summary-short>')
    llm.scenario.assertDrained()
  })

  it('improvises a mid-prefix boundary cut from the listed snippet ids', async () => {
    llm = await createMockLlm()
    const res = await chat(BOUNDARIES_PROMPT)
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> }
    const text = body.choices[0]?.message.content ?? ''
    const json = text.slice(text.indexOf('\n') + 1, text.lastIndexOf('\n</boundaries>'))
    const proposal = JSON.parse(json) as {
      boundaries: Array<{ afterSnippetId: string; kind: string }>
    }
    expect(proposal.boundaries).toHaveLength(1)
    expect(proposal.boundaries[0]?.afterSnippetId).toBe('01JGBBB')
    expect(proposal.boundaries[0]?.kind).toBe('chapter')
    llm.scenario.assertDrained()
  })

  it('scripted steps take precedence over the improviser', async () => {
    llm = await createMockLlm()
    llm.scenario.respond('<summary-short>\nScripted.\n</summary-short>')
    const res = await chat(ENRICH_PROMPT)
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> }
    expect(body.choices[0]?.message.content).toBe('<summary-short>\nScripted.\n</summary-short>')
    llm.scenario.assertDrained()
  })

  it('interactive requests keep the loud exhausted-queue failure', async () => {
    llm = await createMockLlm()
    const res = await postJson(chatUrl(), BASE_REQUEST) // not background-shaped
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: { type: string; message: string } }
    expect(body.error.type).toBe('mock_scenario_error')
    expect(body.error.message).toContain('scenario exhausted')
    expect(llm.scenario.state().errors).toHaveLength(1)
    llm.scenario.reset() // clear the recorded failure so afterEach teardown stays clean
  })
})
