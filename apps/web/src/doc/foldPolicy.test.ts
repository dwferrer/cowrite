import { describe, expect, it } from 'vitest'
import { defaultFold, effectiveFold, type FoldableSection } from './foldPolicy.js'

function section(overrides: Partial<FoldableSection> = {}): FoldableSection {
  return { id: 'S1', shortSummary: 'short.', longSummary: 'long.', ...overrides }
}

describe('defaultFold', () => {
  // the §5.3 ladder: 2 full / 4 long / 8 short / rest name
  const table: Array<[number, string]> = [
    [0, 'full'],
    [1, 'full'],
    [2, 'long'],
    [3, 'long'],
    [4, 'long'],
    [5, 'long'],
    [6, 'short'],
    [9, 'short'],
    [13, 'short'],
    [14, 'name'],
    [50, 'name'],
  ]
  it.each(table)('d=%i → %s', (d, level) => {
    expect(defaultFold(d)).toBe(level)
  })
})

describe('effectiveFold', () => {
  it('uses the distance default when no override is set', () => {
    expect(effectiveFold(section(), 0, {})).toBe('full')
    expect(effectiveFold(section(), 3, {})).toBe('long')
    expect(effectiveFold(section(), 10, {})).toBe('short')
    expect(effectiveFold(section(), 20, {})).toBe('name')
  })

  it('a pinned override wins over the distance default', () => {
    expect(effectiveFold(section(), 20, { S1: 'full' })).toBe('full')
    expect(effectiveFold(section(), 0, { S1: 'name' })).toBe('name')
  })

  it("an 'auto' override behaves as no override", () => {
    expect(effectiveFold(section(), 20, { S1: 'auto' })).toBe('name')
  })

  it('degrades long → short when only the short summary exists', () => {
    expect(effectiveFold(section({ longSummary: null }), 3, {})).toBe('short')
  })

  it('degrades short → long when only the long summary exists', () => {
    expect(effectiveFold(section({ shortSummary: null }), 10, {})).toBe('long')
  })

  it('degrades name → long when only the long summary exists', () => {
    expect(effectiveFold(section({ shortSummary: null }), 20, {})).toBe('long')
  })

  it('resolves every level to full when no summaries exist yet (pre-Stage 4)', () => {
    const bare = section({ shortSummary: null, longSummary: null })
    for (const d of [0, 3, 10, 20]) {
      expect(effectiveFold(bare, d, {})).toBe('full')
    }
    // pinned levels degrade the same way — never an empty body
    expect(effectiveFold(bare, 0, { S1: 'short' })).toBe('full')
    expect(effectiveFold(bare, 0, { S1: 'name' })).toBe('full')
  })
})
