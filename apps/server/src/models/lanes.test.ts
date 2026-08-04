import { createMockLlm, type MockLlm } from '@cowrite/mock-llm'
import { AppConfig } from '@cowrite/shared'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ModelClientError } from './client.js'
import { buildClients, resolveHarnessKnobs } from './lanes.js'

/**
 * Lane wiring against `@cowrite/mock-llm` (docs/09 §2.3): one server for the file, the
 * scenario and captured requests reset per test, drained at the end of each.
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

function configWithBothLanes(): AppConfig {
  return AppConfig.parse({
    models: {
      high: {
        baseUrl: `${llm.url}/v1`,
        model: 'mock-high',
        temperature: 0.7,
        maxOutputTokens: 999,
      },
      low: { baseUrl: `${llm.url}/v1`, model: 'mock-low' },
    },
    harness: { retry: { maxAttempts: 1 } },
  })
}

const imageMessage = {
  role: 'user' as const,
  content: [
    { type: 'text' as const, text: 'critique this illustration' },
    { type: 'image_url' as const, imageUrl: { url: 'data:image/png;base64,AAAA' } },
  ],
}

describe('buildClients', () => {
  it('builds null for unconfigured lanes — config_missing is task creation’s job (05 §3.1)', () => {
    const { high, low } = buildClients(AppConfig.parse({}))
    expect(high).toBeNull()
    expect(low).toBeNull()
  })

  it('wires lane, model, and sampler params from ModelEndpoint config', async () => {
    const { high, low } = buildClients(configWithBothLanes())
    expect(high?.lane).toBe('high')
    expect(low?.lane).toBe('low')

    llm.scenario.respond('hi', { model: 'mock-high' })
    await high?.chat({ messages: [{ role: 'user', content: 'go' }] })
    expect(llm.requests[0]?.body).toMatchObject({
      model: 'mock-high',
      temperature: 0.7,
      max_tokens: 999,
    })
  })

  it('HIGH lane rejects image content parts with a typed error before any request', async () => {
    const { high } = buildClients(configWithBothLanes())
    const err = await high
      ?.chat({ messages: [imageMessage] })
      .then(() => null)
      .catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ModelClientError)
    expect((err as ModelClientError).code).toBe('validation')
    expect((err as ModelClientError).retryable).toBe(false)
    expect(llm.requests).toHaveLength(0) // rejected before any bytes left the process
  })

  it('LOW lane permits image_url parts and sends them on the wire (Stage 5 seam)', async () => {
    const { low } = buildClients(configWithBothLanes())
    llm.scenario.respond('a fine painting', { model: 'mock-low' })
    const result = await low?.chat({ messages: [imageMessage] })
    expect(result?.text).toBe('a fine painting')

    const sent = llm.requests[0]?.messages as Array<{ content: unknown }>
    expect(sent[0]?.content).toEqual([
      { type: 'text', text: 'critique this illustration' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ])
  })
})

describe('resolveHarnessKnobs', () => {
  it('fills 05 §6.4 defaults from an empty override set', () => {
    const knobs = resolveHarnessKnobs({})
    expect(knobs).toEqual({
      connectTimeoutMs: 15_000,
      firstTokenTimeoutMs: 60_000,
      idleTokenTimeoutMs: 30_000,
      totalTimeoutMs: { high: 300_000, low: 300_000 },
      illustrationBudgetMs: 600_000,
      retry: { maxAttempts: 3, backoffMs: 1_000, backoffMaxMs: 4_000 },
      spendWarnUsd: 5,
      spendStopUsd: null,
    })
  })

  it('sparse overrides keep sibling defaults', () => {
    const knobs = resolveHarnessKnobs({ totalTimeoutMs: { high: 10_000 } })
    expect(knobs.totalTimeoutMs).toEqual({ high: 10_000, low: 300_000 })
    expect(knobs.retry.maxAttempts).toBe(3)
  })

  it('per-lane totalMs feeds the client ladder', () => {
    const { high, low } = buildClients(configWithBothLanes())
    expect(high?.ladder().totalMs).toBe(300_000)
    expect(low?.ladder().totalMs).toBe(300_000)
    expect(high?.ladder({ totalMs: 42 }).totalMs).toBe(42)
  })
})
