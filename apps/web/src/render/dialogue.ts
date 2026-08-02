/**
 * Dialogue detection (docs/04-frontend.md §6.2) — a pure per-paragraph quote state machine.
 * A range opens at a quote preceded by start/whitespace/punctuation and closes at the
 * matching quote (straight " pairs with ", curly “ pairs with ”); an unclosed quote closes at
 * paragraph end (common in drafts). Ranges include the quote marks themselves.
 * Per-paragraph only — no cross-paragraph state.
 */

/** [start, end) — character offsets into the paragraph, quote marks included. */
export type DialogueRange = readonly [number, number]

const WORD_CHAR = /[\p{L}\p{N}]/u

function isOpeningBoundary(prev: string | undefined): boolean {
  return prev === undefined || !WORD_CHAR.test(prev)
}

export function detectDialogue(text: string): DialogueRange[] {
  const ranges: Array<[number, number]> = []
  let openAt = -1
  let opener: '"' | '“' | null = null

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (opener !== null) {
      if ((opener === '"' && ch === '"') || (opener === '“' && ch === '”')) {
        ranges.push([openAt, i + 1])
        opener = null
        openAt = -1
      }
      continue
    }
    if ((ch === '"' || ch === '“') && isOpeningBoundary(text[i - 1])) {
      opener = ch as '"' | '“'
      openAt = i
    }
  }
  if (opener !== null) ranges.push([openAt, text.length])
  return ranges
}
