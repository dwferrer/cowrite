import type { CritiqueResult } from '@cowrite/shared'
import { CritiqueResult as CritiqueResultSchema } from '@cowrite/shared'
import type { ChatMessage, ContentPart } from '../models/client.js'
import { renderTemplate } from '../prompt/templates/loader.js'
import { briefRegions, type IntentBrief } from './composer.js'
import type { RunContext } from './ctx.js'

/**
 * The VLM critic (docs/08-illustration.md §4.3; wording 07 §8). One low-model call per successful
 * attempt with the downscaled image attached as a base64 `image_url` part — the only place in
 * Cowrite a model receives an image, permitted on the low lane only (05 §3.1). It returns
 * `CritiqueResult`, parsed from a fenced JSON block with ONE repair retry, then a neutral
 * `{verdict: 'revise', overall: 5}` so a flaky critic never wedges the loop (§10). The full JSON
 * is recorded as a `vlm.critique` toolCall run event — the critique transcript IS the run file.
 */

/** ≤ 768 px on the longest side before attaching — a 0–5 rubric doesn't need native res (§4.3). */
export const CRITIC_MAX_EDGE = 768

/** The neutral fallback when the critic's JSON never parses (§4.3, §10) — never wedges the loop. */
export const NEUTRAL_CRITIQUE: CritiqueResult = {
  verdict: 'revise',
  scores: { subject: 2.5, consistency: 2.5, craft: 2.5, mood: 2.5 },
  overall: 5,
  problems: [],
  promptAdvice: '',
}

/**
 * Coerce a critique into a concrete revise instruction (§4.3): the loop treats every non-accept
 * outcome as a revise, and the reviser is never steered on nothing. `promptAdvice` wins; when it
 * is blank (an agreeable small VLM saying "accept, 6.5" with nothing actionable) fall back to the
 * joined `problems`, then to a stock instruction.
 */
export function asRevise(crit: CritiqueResult): string {
  const advice = crit.promptAdvice.trim()
  if (advice !== '') return advice
  const problems = crit.problems
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .join('; ')
  if (problems !== '') return problems
  return 'keep the same moment; re-assert any listed elements; simplify the composition'
}

/**
 * Extract the JSON object a fenced block carries. Prefers a ` ```json ` / ` ``` ` fence; failing
 * that, the widest `{…}` span in the text (small VLMs often drop the fence). Returns the parsed
 * value or null.
 */
export function extractFencedJson(text: string): unknown {
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const candidates: string[] = []
  if (fence?.[1] !== undefined) candidates.push(fence[1])
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1))
  for (const raw of candidates) {
    try {
      return JSON.parse(raw.trim())
    } catch {
      // try the next candidate
    }
  }
  return null
}

/** Parse a critic response into a `CritiqueResult`, or null when it does not validate. */
export function parseCritique(text: string): CritiqueResult | null {
  const raw = extractFencedJson(text)
  if (raw === null) return null
  const parsed = CritiqueResultSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/**
 * The critique user message text (image attached separately): instructions + the SAME brief
 * regions the composer rendered — world-info, established-imagery, guidance, and target (§9).
 * The critic must see established-imagery so the consistency axis can judge drift, and guidance
 * so it doesn't penalize a user-requested deviation.
 */
function renderCritiqueText(ctx: RunContext, brief: IntentBrief, prompt: string): string {
  const instructions = renderTemplate(ctx.templates, 'illustrate-critique', {
    prompt: prompt.trim(),
  })
    .replace(/^\n+/, '')
    .replace(/\n+$/, '')
  const parts = [instructions, ...briefRegions(brief)]
  return parts.filter((p): p is string => p !== null && p !== '').join('\n\n')
}

function pngDataUrl(png: Uint8Array): string {
  return `data:image/png;base64,${Buffer.from(png).toString('base64')}`
}

function emitUsage(
  ctx: RunContext,
  usage: { promptTokens: number; completionTokens: number; estimated: boolean },
): void {
  ctx.emit({
    type: 'usage',
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    estimated: usage.estimated,
    call: 'pipeline',
  })
}

/**
 * Critique one attempt (§4.3). `downscaledPng` is the ≤ 768 px image (downscaled by the loop via
 * `ctx.imageOps`). Emits `message`/`usage`/`toolCall(vlm.critique)` run events and returns the
 * parsed `CritiqueResult` — one repair retry on a parse miss, then the neutral fallback.
 */
export async function critique(
  ctx: RunContext,
  downscaledPng: Uint8Array,
  brief: IntentBrief,
  prompt: string,
): Promise<CritiqueResult> {
  const started = Date.now()
  const text = renderCritiqueText(ctx, brief, prompt)
  const content: ContentPart[] = [
    { type: 'text', text },
    { type: 'image_url', imageUrl: { url: pngDataUrl(downscaledPng) } },
  ]
  const messages: ChatMessage[] = [{ role: 'user', content }]
  ctx.emit({ type: 'message', role: 'user', text: `${text}\n[image attached]` })

  let result = await ctx.lowClient.chat({ messages, stream: false }, { signal: ctx.signal })
  emitUsage(ctx, result.usage)
  ctx.emit({ type: 'message', role: 'assistant', text: result.text })
  let crit = parseCritique(result.text)

  if (crit === null) {
    // One repair retry (§4.3): ask for the bare fenced JSON, then give up to neutral.
    const cue =
      'Your reply was not valid JSON. Reply again with only a single fenced ```json code block ' +
      'containing the critique object (verdict, scores, overall, problems, promptAdvice) and no other text.'
    messages.push({ role: 'assistant', content: result.text }, { role: 'user', content: cue })
    ctx.emit({ type: 'message', role: 'user', text: cue })
    result = await ctx.lowClient.chat({ messages, stream: false }, { signal: ctx.signal })
    emitUsage(ctx, result.usage)
    ctx.emit({ type: 'message', role: 'assistant', text: result.text })
    crit = parseCritique(result.text)
  }

  const resolved = crit ?? NEUTRAL_CRITIQUE
  ctx.emit({
    type: 'toolCall',
    name: 'vlm.critique',
    input: { prompt },
    output: JSON.stringify(resolved),
    durationMs: Date.now() - started,
  })
  return resolved
}
