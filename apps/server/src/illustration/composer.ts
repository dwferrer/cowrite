import type { ChatMessage } from '../models/client.js'
import {
  IMAGE_PROMPT_BLOCK_TAG,
  renderEstablishedImagery,
  renderGuidance,
} from '../prompt/imagePrompt.js'
import { type ExpectedBlockSpec, formatBlockList, parseTaskOutput } from '../prompt/outputParser.js'
import { renderWorldInfo, type WorldEntryItem } from '../prompt/regions.js'
import { tagBlock } from '../prompt/tags.js'
import { renderTemplate } from '../prompt/templates/loader.js'
import type { IllustrationStorage, RunContext } from './ctx.js'

/**
 * The composer + reviser (docs/08-illustration.md §4.2; wording 07 §8). Both are plain text-only
 * low-model calls that emit one `<image-prompt>` block — a single natural-language descriptive
 * paragraph, content only (no tags, negatives, artist names, or quality boilerplate; those live
 * in the user's workflow). `buildIntentBrief` assembles the brief from storage reads; `compose`
 * writes the first prompt and `revise` rewrites it from the critic's instruction. The matched
 * world-entry ids are recorded on the brief so they land in `IllustrationMeta.entities` (§4.2) —
 * the established-imagery lookup key, which works by id and so survives the no-names rule.
 */

/** ≤ 4 matched world entries, most-mentioned first (§4.2). */
export const MATCHED_ENTRY_CAP = 4
/** Full body of a matched entry, capped ~400 tokens each (§4.2). */
export const ENTRY_BODY_TOKEN_CAP = 400
/** Last 3 prior winning prompts whose entities intersect the matched ids (§4.2). */
export const ESTABLISHED_IMAGERY_CAP = 3
/** User guidance is clamped to 500 chars (§4.2 rule 6; TaskSpec already caps at 500). */
export const GUIDANCE_CHAR_CAP = 500
/** Content-truncation fallback (§4.2): first ~1 000 + last ~2 000 tokens with a `[…]` marker. */
export const TARGET_HEAD_TOKENS = 1_000
export const TARGET_TAIL_TOKENS = 2_000
/** The elision marker placed between the head and tail of a truncated section body (§4.2). */
export const TRUNCATION_MARKER = '[…]'

// ---------------------------------------------------------------------------
// Intent sources + the assembled brief
// ---------------------------------------------------------------------------

/** Section illustration intent: title + long summary (or the content fallback). */
export interface SectionIntent {
  kind: 'section'
  title: string
  /** enrichment long summary; null forces the content-truncation fallback (§4.2). */
  longSummary: string | null
  /** section content.md — scanned for world-entry keys and used for the fallback body. */
  content: string
}

/** World-entry image intent: name + body; `entities = [entryId]` (§4.2). */
export interface WorldIntent {
  kind: 'world'
  entryId: string
  name: string
  body: string
}

export type IntentSource = SectionIntent | WorldIntent

export interface BriefWorldEntryItem {
  id: string
  name: string
  body: string
}

export interface EstablishedImageryItem {
  /** the shared entity's name, for the `<imagery from="…">` label */
  from: string
  /** a prior winning image prompt, verbatim */
  text: string
}

/** The intent brief — recorded as a run message via the compose/revise prompt (§4.1). */
export interface IntentBrief {
  kind: 'section' | 'world'
  title: string
  /** section long summary / truncated content, or the world entry body. */
  targetText: string
  worldEntries: BriefWorldEntryItem[]
  establishedImagery: EstablishedImageryItem[]
  guidance: string | null
  /** matched world-entry ids (+ the entry's own id for world images) → `IllustrationMeta.entities`. */
  entities: string[]
}

// ---------------------------------------------------------------------------
// Token helpers (whitespace-word approximation — the caps are heuristic, §4.2)
// ---------------------------------------------------------------------------

/** Split on whitespace, keeping the tokens; empty for blank input. */
function words(text: string): string[] {
  const trimmed = text.trim()
  return trimmed === '' ? [] : trimmed.split(/\s+/)
}

/** Clamp `text` to at most `maxTokens` whitespace words. */
export function capTokens(text: string, maxTokens: number): string {
  const w = words(text)
  return w.length <= maxTokens ? text.trim() : w.slice(0, maxTokens).join(' ')
}

/**
 * The §4.2 content-truncation fallback: when a section has no long summary, bias toward the setup
 * and the climax by keeping the first ~1 000 and last ~2 000 tokens with a `[…]` marker between.
 * Short bodies pass through unchanged.
 */
export function truncateContent(
  content: string,
  head = TARGET_HEAD_TOKENS,
  tail = TARGET_TAIL_TOKENS,
): { text: string; truncated: boolean } {
  const w = words(content)
  if (w.length <= head + tail) return { text: content.trim(), truncated: false }
  const headText = w.slice(0, head).join(' ')
  const tailText = w.slice(w.length - tail).join(' ')
  return { text: `${headText}\n\n${TRUNCATION_MARKER}\n\n${tailText}`, truncated: true }
}

// ---------------------------------------------------------------------------
// Brief assembly
// ---------------------------------------------------------------------------

/** ISO instant sort key for "newest first"; unparsable dates sort last. */
function generatedAtMs(iso: string): number {
  const t = Date.parse(iso)
  return Number.isNaN(t) ? 0 : t
}

/**
 * Assemble the intent brief from storage reads (§4.2): matched world entries (full bodies, cap 4,
 * most-mentioned first via `matchWorldEntries`), established imagery (prior winning prompts whose
 * recorded `entities` intersect the matched ids, last 3), and the target material. No context
 * engine, no ledger — plain reads.
 */
export async function buildIntentBrief(
  storage: IllustrationStorage,
  intent: IntentSource,
  guidance?: string,
): Promise<IntentBrief> {
  const clampedGuidance =
    guidance !== undefined && guidance.trim() !== '' ? guidance.slice(0, GUIDANCE_CHAR_CAP) : null

  let title: string
  let targetText: string
  let worldEntries: BriefWorldEntryItem[]
  let entities: string[]
  const entityNames = new Map<string, string>()

  if (intent.kind === 'section') {
    title = intent.title
    targetText =
      intent.longSummary !== null && intent.longSummary.trim() !== ''
        ? intent.longSummary.trim()
        : truncateContent(intent.content).text
    // `matchWorldEntries` returns most-mentioned first (02 §StorageService); cap to 4.
    const matched = (await storage.matchWorldEntries(intent.content)).slice(0, MATCHED_ENTRY_CAP)
    worldEntries = matched.map((e) => ({
      id: e.meta.id,
      name: e.meta.name,
      body: capTokens(e.body, ENTRY_BODY_TOKEN_CAP),
    }))
    entities = matched.map((e) => e.meta.id)
    for (const e of matched) entityNames.set(e.meta.id, e.meta.name)
  } else {
    title = intent.name
    targetText = intent.body.trim()
    worldEntries = []
    entities = [intent.entryId]
    entityNames.set(intent.entryId, intent.name)
  }

  const entitySet = new Set(entities)
  // Targeted read (§4.2): storage returns only metas whose entities intersect the matched ids,
  // so a compose never lists every illustration in the work just to find ≤3 priors.
  const metas = await storage.listIllustrationMetasByEntities(entities)
  const establishedImagery = metas
    .filter((m) => m.meta.prompt !== null)
    .sort((a, b) => generatedAtMs(b.meta.generatedAt) - generatedAtMs(a.meta.generatedAt))
    .slice(0, ESTABLISHED_IMAGERY_CAP)
    .map((m) => {
      const sharedId = m.meta.entities.find((id) => entitySet.has(id))
      const from = (sharedId !== undefined ? entityNames.get(sharedId) : undefined) ?? title
      return { from, text: m.meta.prompt as string }
    })

  return {
    kind: intent.kind,
    title,
    targetText,
    worldEntries,
    establishedImagery,
    guidance: clampedGuidance,
    entities,
  }
}

// ---------------------------------------------------------------------------
// Prompt rendering (region order §4.2: instructions, world-info, established-imagery,
// guidance, target). Templates own the instruction wording (07 §8).
// ---------------------------------------------------------------------------

/** Strip framing blank lines from a rendered template block (template files end with `\n`). */
function frame(markup: string): string {
  return markup.replace(/^\n+/, '').replace(/\n+$/, '')
}

/**
 * The shared brief regions in §4.2 order (world-info, established-imagery, guidance, target).
 * Exported so the critic renders the SAME established-imagery + guidance the composer saw
 * (§4.3, §9) — the consistency axis can then judge drift and guidance isn't penalized.
 */
export function briefRegions(brief: IntentBrief): (string | null)[] {
  const worldItems: WorldEntryItem[] = brief.worldEntries.map((e) => ({
    id: e.id,
    name: e.name,
    fidelity: 'full',
    content: e.body,
  }))
  const heading = brief.title.trim() === '' ? '' : `# ${brief.title.trim()}\n\n`
  return [
    renderWorldInfo(worldItems),
    renderEstablishedImagery(brief.establishedImagery),
    brief.guidance === null ? null : renderGuidance(brief.guidance),
    tagBlock('target', [], `${heading}${brief.targetText}`),
  ]
}

/** The compose user message: `illustrate-compose` instructions + the brief regions. */
export function renderComposeMessage(brief: IntentBrief, ctx: RunContext): string {
  const instructions = frame(renderTemplate(ctx.templates, 'illustrate-compose'))
  return [instructions, ...briefRegions(brief)]
    .filter((p): p is string => p !== null && p !== '')
    .join('\n\n')
}

/** The revise user message: `illustrate-revise` (with the previous prompt + advice) + the brief. */
export function renderReviseMessage(
  brief: IntentBrief,
  previousPrompt: string,
  advice: string,
  ctx: RunContext,
): string {
  const instructions = frame(
    renderTemplate(ctx.templates, 'illustrate-revise', {
      previousPrompt: previousPrompt.trim(),
      advice: advice.trim(),
    }),
  )
  return [instructions, ...briefRegions(brief)]
    .filter((p): p is string => p !== null && p !== '')
    .join('\n\n')
}

// ---------------------------------------------------------------------------
// The low-model calls
// ---------------------------------------------------------------------------

const IMAGE_PROMPT_SPEC: ExpectedBlockSpec[] = [{ tag: IMAGE_PROMPT_BLOCK_TAG }]

/**
 * One image-prompt call with one repair turn (§10: the tag-block repair covers the
 * `<image-prompt>` block). Emits the `message`/`output`/`usage` run events (call `pipeline`) and
 * returns the parsed paragraph. If both turns miss the block, the whole trimmed response is used
 * (diffusion text encoders truncate gracefully — never wedge the loop on a tag miss).
 */
async function callImagePrompt(ctx: RunContext, userMessage: string): Promise<string> {
  const messages: ChatMessage[] = [{ role: 'user', content: userMessage }]
  ctx.emit({ type: 'message', role: 'user', text: userMessage })

  let result = await ctx.lowClient.chat({ messages, stream: false }, { signal: ctx.signal })
  ctx.emit({ type: 'output', text: result.text })
  ctx.emit({
    type: 'usage',
    promptTokens: result.usage.promptTokens,
    completionTokens: result.usage.completionTokens,
    estimated: result.usage.estimated,
    call: 'pipeline',
  })
  ctx.emit({ type: 'message', role: 'assistant', text: result.text })

  let parsed = parseTaskOutput(result.text, IMAGE_PROMPT_SPEC)
  if (parsed.ok) return parsed.blocks[0]?.content.trim() ?? result.text.trim()

  // One repair turn.
  const cue = renderTemplate(ctx.templates, 'repair', {
    blockList: formatBlockList(parsed.missing),
  })
  messages.push({ role: 'assistant', content: result.text }, { role: 'user', content: cue })
  ctx.emit({ type: 'message', role: 'user', text: cue })
  result = await ctx.lowClient.chat({ messages, stream: false }, { signal: ctx.signal })
  ctx.emit({ type: 'output', text: result.text })
  ctx.emit({
    type: 'usage',
    promptTokens: result.usage.promptTokens,
    completionTokens: result.usage.completionTokens,
    estimated: result.usage.estimated,
    call: 'pipeline',
  })
  ctx.emit({ type: 'message', role: 'assistant', text: result.text })

  parsed = parseTaskOutput(result.text, IMAGE_PROMPT_SPEC)
  if (parsed.ok) return parsed.blocks[0]?.content.trim() ?? result.text.trim()
  return result.text.trim()
}

/** Compose the first image prompt from the brief (§4.2 — low-model call #1, text only). */
export function compose(ctx: RunContext, brief: IntentBrief): Promise<string> {
  return callImagePrompt(ctx, renderComposeMessage(brief, ctx))
}

/** Rewrite the prompt from the critic's actionable instruction (§4.3 — keep the same moment). */
export function revise(
  ctx: RunContext,
  brief: IntentBrief,
  previousPrompt: string,
  advice: string,
): Promise<string> {
  return callImagePrompt(ctx, renderReviseMessage(brief, previousPrompt, advice, ctx))
}
