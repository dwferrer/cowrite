/**
 * Scroll-anchor bookkeeping (docs/04-frontend.md §5.5) — pure math; DocView runs it inside
 * useLayoutEffect. Collapsed heights differ by orders of magnitude and native overflow-anchor
 * cannot be trusted across virtualizer remounts, so we track the topmost visible block and
 * restore its exact viewport offset after every re-layout; frontier stickiness (followBottom)
 * wins when the user is within 48 px of the bottom.
 */

export interface BlockPos {
  key: string
  start: number
  size: number
}

export interface ScrollAnchor {
  blockKey: string
  /** blockTop − scrollTop at capture time — ≤ 0 for the topmost intersecting block. */
  offsetPx: number
}

export const FOLLOW_BOTTOM_THRESHOLD_PX = 48

/** True when the viewport bottom is within the stickiness threshold of the scroll end. */
export function isNearBottom(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
): boolean {
  return scrollHeight - scrollTop - clientHeight < FOLLOW_BOTTOM_THRESHOLD_PX
}

/**
 * The anchor is the topmost block intersecting the viewport top: the first block whose bottom
 * is below scrollTop. `offsetPx` records where its top sat relative to the viewport.
 */
export function computeAnchor(
  positions: readonly BlockPos[],
  scrollTop: number,
): ScrollAnchor | null {
  let best: BlockPos | null = null
  for (const p of positions) {
    if (p.start + p.size > scrollTop && (best === null || p.start < best.start)) best = p
  }
  if (!best) return null
  return { blockKey: best.key, offsetPx: best.start - scrollTop }
}

/**
 * ScrollTop that restores the anchored block to its captured viewport offset, given the
 * block's new top. Returns null when the block no longer exists (caller falls back to the
 * section header, offset 0).
 */
export function restoreScrollTop(
  anchor: ScrollAnchor,
  newBlockStart: number | undefined,
): number | null {
  if (newBlockStart === undefined) return null
  return Math.max(0, newBlockStart - anchor.offsetPx)
}
