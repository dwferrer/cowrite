import { type ImageryItem, renderImageryItem, renderRegion } from './regions.js'
import { tagBlock } from './tags.js'

/**
 * Image-prompt composition constants + the two compose-only regions of 07 §2.1 (loop owned
 * by 08-illustration.md). Deliberately minimal until Stage 5: the illustration templates
 * (`illustrate-compose.md` / `-revise.md` / `-critique.md`) land with that stage, along
 * with the §8 length-rule enforcement (a one-liner over storage's `wordCount`).
 */

/** The composer/reviser output block (§2.5): one descriptive paragraph. */
export const IMAGE_PROMPT_BLOCK_TAG = 'image-prompt' as const
/** §8 rule 2: one flowing paragraph, 60–120 words. */
export const IMAGE_PROMPT_MIN_WORDS = 60
export const IMAGE_PROMPT_MAX_WORDS = 120

/** `<established-imagery>` — prior winning image prompts, verbatim (08 §compose). */
export function renderEstablishedImagery(items: readonly ImageryItem[]): string | null {
  return renderRegion('established-imagery', items.map(renderImageryItem))
}

/** `<guidance>` — the user's regeneration guidance, verbatim; omitted when blank (§2.1). */
export function renderGuidance(text: string): string | null {
  if (text.trim() === '') return null
  return tagBlock('guidance', [], text)
}
