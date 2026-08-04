import type { ModelEndpoint } from '@cowrite/shared'
import type { ChatMessage } from './client.js'

/**
 * Usage accounting helpers (docs/05-agents.md §3.2, §9).
 *
 * - `normalizeUsage` maps whatever a provider reports (snake_case OpenAI, camelCase,
 *   Anthropic-style input/output) onto one shape with `estimated: false`.
 * - When a provider omits usage entirely, `estimateUsage` supplies the chars/4 fallback
 *   flagged `estimated: true` (05 §cost).
 * - Cost is derived at read time from the endpoint's configured prices — never stored
 *   (prices change, token counts don't; 05 §9).
 */

export interface NormalizedUsage {
  promptTokens: number
  completionTokens: number
  estimated: boolean
}

function pickInt(source: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return Math.round(value)
    }
  }
  return null
}

/**
 * Normalize a provider `usage` object; returns null when the provider reported nothing
 * usable (the caller then falls back to `estimateUsage`).
 */
export function normalizeUsage(raw: unknown): NormalizedUsage | null {
  if (raw === null || typeof raw !== 'object') return null
  const source = raw as Record<string, unknown>
  const promptTokens = pickInt(source, ['prompt_tokens', 'promptTokens', 'input_tokens'])
  const completionTokens = pickInt(source, [
    'completion_tokens',
    'completionTokens',
    'output_tokens',
  ])
  if (promptTokens === null && completionTokens === null) return null
  return {
    promptTokens: promptTokens ?? 0,
    completionTokens: completionTokens ?? 0,
    estimated: false,
  }
}

/** The chars/4 fallback (05 §3.2) — flagged so rollups can show "~". */
export function estimateUsage(
  promptCharCount: number,
  completionCharCount: number,
): NormalizedUsage {
  return {
    promptTokens: Math.ceil(promptCharCount / 4),
    completionTokens: Math.ceil(completionCharCount / 4),
    estimated: true,
  }
}

/** Character count of everything the prompt carries (text parts; image parts count 0). */
export function promptChars(messages: ChatMessage[]): number {
  let total = 0
  for (const message of messages) {
    if (typeof message.content === 'string') {
      total += message.content.length
    } else {
      for (const part of message.content) {
        if (part.type === 'text') total += part.text.length
      }
    }
    if (message.toolCalls !== undefined) {
      for (const tc of message.toolCalls) total += tc.name.length + tc.argumentsJson.length
    }
  }
  return total
}

/**
 * Cost in USD from the endpoint's per-MTok prices, derived at read time (05 §9).
 * Null when either price is unconfigured — the UI then shows tokens only.
 */
export function deriveCostUsd(
  usage: Pick<NormalizedUsage, 'promptTokens' | 'completionTokens'>,
  prices: Pick<ModelEndpoint, 'promptCostPerMTok' | 'completionCostPerMTok'>,
): number | null {
  if (prices.promptCostPerMTok === null || prices.completionCostPerMTok === null) return null
  return (
    (usage.promptTokens * prices.promptCostPerMTok +
      usage.completionTokens * prices.completionCostPerMTok) /
    1_000_000
  )
}
