import { describe, expect, it } from 'vitest'
import { type BlockPos, computeAnchor, isNearBottom, restoreScrollTop } from './anchoring.js'

const positions: BlockPos[] = [
  { key: 'h:1', start: 0, size: 44 },
  { key: 'b:1', start: 44, size: 15_000 },
  { key: 'h:2', start: 15_044, size: 44 },
  { key: 'b:2', start: 15_088, size: 3_000 },
]

describe('computeAnchor', () => {
  it('picks the topmost block intersecting the viewport top', () => {
    const anchor = computeAnchor(positions, 200)
    expect(anchor).toEqual({ blockKey: 'b:1', offsetPx: 44 - 200 })
  })

  it('offset is ≤ 0 when the block starts above the viewport top and 0 at an exact edge', () => {
    expect(computeAnchor(positions, 15_044)?.blockKey).toBe('h:2')
    expect(computeAnchor(positions, 15_044)?.offsetPx).toBe(0)
    expect(computeAnchor(positions, 15_050)?.offsetPx).toBe(-6)
  })

  it('a block exactly ending at scrollTop is not the anchor (blockBottom must exceed it)', () => {
    // h:1 ends at 44; scrollTop 44 ⇒ anchor is b:1
    expect(computeAnchor(positions, 44)?.blockKey).toBe('b:1')
  })

  it('returns null with no blocks', () => {
    expect(computeAnchor([], 100)).toBeNull()
  })
})

describe('restoreScrollTop', () => {
  it('restores the exact visual position after heights above the anchor change', () => {
    const scrollTop = 15_100
    const anchor = computeAnchor(positions, scrollTop)
    expect(anchor?.blockKey).toBe('b:2')
    // a fold collapse above shrinks b:1 from 15,000 to 140 px → b:2 now starts at 4,228
    const newStart = 44 + 140 + 44
    const restored = restoreScrollTop(anchor as NonNullable<typeof anchor>, newStart)
    // the anchored block keeps its offset relative to the viewport top
    expect(restored).toBe(newStart - (anchor as NonNullable<typeof anchor>).offsetPx)
    expect(newStart - (restored as number)).toBe((anchor as NonNullable<typeof anchor>).offsetPx)
  })

  it('clamps to 0 when the restored position would be negative', () => {
    expect(restoreScrollTop({ blockKey: 'b:1', offsetPx: 500 }, 100)).toBe(0)
  })

  it('returns null when the anchor block no longer exists', () => {
    expect(restoreScrollTop({ blockKey: 'gone', offsetPx: -10 }, undefined)).toBeNull()
  })
})

describe('isNearBottom', () => {
  it('is true strictly within 48 px of the bottom', () => {
    // scrollHeight 1000, clientHeight 500
    expect(isNearBottom(500, 500, 1000)).toBe(true) // exactly at the bottom
    expect(isNearBottom(453, 500, 1000)).toBe(true) // 47 px away
    expect(isNearBottom(452, 500, 1000)).toBe(false) // 48 px away — threshold is strict
    expect(isNearBottom(0, 500, 1000)).toBe(false)
  })
})
