import { describe, expect, it } from 'vitest'
import type { ChatMessage } from './client.js'
import { deriveCostUsd, estimateUsage, normalizeUsage, promptChars } from './usage.js'

describe('normalizeUsage', () => {
  it('reads the OpenAI snake_case shape', () => {
    expect(
      normalizeUsage({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }),
    ).toEqual({ promptTokens: 100, completionTokens: 20, estimated: false })
  })

  it('reads camelCase and Anthropic-style input/output spellings', () => {
    expect(normalizeUsage({ promptTokens: 7, completionTokens: 3 })).toEqual({
      promptTokens: 7,
      completionTokens: 3,
      estimated: false,
    })
    expect(normalizeUsage({ input_tokens: 5, output_tokens: 2 })).toEqual({
      promptTokens: 5,
      completionTokens: 2,
      estimated: false,
    })
  })

  it('rounds fractional counts and zero-fills a missing side', () => {
    expect(normalizeUsage({ prompt_tokens: 10.6 })).toEqual({
      promptTokens: 11,
      completionTokens: 0,
      estimated: false,
    })
  })

  it('returns null for absent/garbage usage so the caller can estimate', () => {
    expect(normalizeUsage(undefined)).toBeNull()
    expect(normalizeUsage(null)).toBeNull()
    expect(normalizeUsage('lots')).toBeNull()
    expect(normalizeUsage({})).toBeNull()
    expect(normalizeUsage({ prompt_tokens: -1, completion_tokens: Number.NaN })).toBeNull()
  })
})

describe('estimateUsage (chars/4 fallback, 05 §cost)', () => {
  it('divides by 4 rounding up and flags estimated', () => {
    expect(estimateUsage(10, 9)).toEqual({ promptTokens: 3, completionTokens: 3, estimated: true })
    expect(estimateUsage(0, 0)).toEqual({ promptTokens: 0, completionTokens: 0, estimated: true })
  })
})

describe('promptChars', () => {
  it('counts string content, text parts, and replayed tool calls; images count zero', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: '12345' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'abc' },
          { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAAAAAA' } },
        ],
      },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_1', name: 'cite', argumentsJson: '{"id":1}' }],
      },
    ]
    expect(promptChars(messages)).toBe(5 + 3 + 'cite'.length + '{"id":1}'.length)
  })
})

describe('deriveCostUsd (read-time derivation, 05 §9)', () => {
  const usage = { promptTokens: 2_000_000, completionTokens: 500_000 }

  it('computes tokens × costPerMTok when both prices are set', () => {
    expect(deriveCostUsd(usage, { promptCostPerMTok: 3, completionCostPerMTok: 15 })).toBeCloseTo(
      2 * 3 + 0.5 * 15,
    )
  })

  it('returns null when either price is unconfigured — the UI shows tokens only', () => {
    expect(deriveCostUsd(usage, { promptCostPerMTok: null, completionCostPerMTok: 15 })).toBeNull()
    expect(deriveCostUsd(usage, { promptCostPerMTok: 3, completionCostPerMTok: null })).toBeNull()
  })
})
