import { describe, expect, it, vi } from 'vitest'
import { discoverPrices, fillPrices } from './pricing.js'

const OPENROUTER_MODELS = {
  data: [
    { id: 'other/model', pricing: { prompt: '0.000001', completion: '0.000002' } },
    {
      id: 'deepseek/deepseek-v4-flash-0731',
      pricing: { prompt: '0.00000015', completion: '0.0000006', request: '0' },
    },
  ],
}

function fetchReturning(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as typeof fetch
}

const ENDPOINT = {
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: 'k',
  model: 'deepseek/deepseek-v4-flash-0731',
}

describe('discoverPrices', () => {
  it('converts OpenRouter per-token strings to per-MTok numbers', async () => {
    const found = await discoverPrices(ENDPOINT, fetchReturning(OPENROUTER_MODELS))
    expect(found).toEqual({ promptCostPerMTok: 0.15, completionCostPerMTok: 0.6 })
  })

  it('returns null for a vanilla OpenAI models list (no pricing field)', async () => {
    const body = { data: [{ id: ENDPOINT.model, object: 'model' }] }
    expect(await discoverPrices(ENDPOINT, fetchReturning(body))).toBeNull()
  })

  it('returns null when the model is absent, pricing is malformed, or the request fails', async () => {
    expect(await discoverPrices(ENDPOINT, fetchReturning({ data: [{ id: 'nope' }] }))).toBeNull()
    expect(
      await discoverPrices(
        ENDPOINT,
        fetchReturning({ data: [{ id: ENDPOINT.model, pricing: { prompt: 'NaN' } }] }),
      ),
    ).toBeNull()
    expect(await discoverPrices(ENDPOINT, fetchReturning({}, 500))).toBeNull()
    const dies = vi.fn(async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    expect(await discoverPrices(ENDPOINT, dies)).toBeNull()
  })
})

describe('fillPrices', () => {
  const found = { promptCostPerMTok: 0.15, completionCostPerMTok: 0.6 }

  it('fills only null prices — config-set values always win', () => {
    const ep = { promptCostPerMTok: null, completionCostPerMTok: 9.99 }
    expect(fillPrices(ep, found)).toBe(true)
    expect(ep).toEqual({ promptCostPerMTok: 0.15, completionCostPerMTok: 9.99 })
  })

  it('is a no-op when both prices are configured', () => {
    const ep = { promptCostPerMTok: 1, completionCostPerMTok: 2 }
    expect(fillPrices(ep, found)).toBe(false)
    expect(ep).toEqual({ promptCostPerMTok: 1, completionCostPerMTok: 2 })
  })
})
