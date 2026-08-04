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

  // The 04 §5.3 degradation matrix, verbatim:
  //   long  + no longSummary  → short if shortSummary exists, else full
  //   short + no shortSummary → name (NameCard renders from the title alone)
  //   name                    → name (needs no summary text)
  describe('degradation follows the 04 §5.3 matrix', () => {
    const both = section()
    const shortOnly = section({ longSummary: null })
    const longOnly = section({ shortSummary: null })
    const bare = section({ shortSummary: null, longSummary: null })

    const matrix: Array<[string, FoldableSection, 'full' | 'long' | 'short' | 'name']> = [
      // base long (d=3)
      ['both', both, 'long'],
      ['shortOnly', shortOnly, 'short'],
      ['longOnly', longOnly, 'long'],
      ['bare', bare, 'full'],
    ]
    it.each(matrix)('base long, %s', (_label, s, expected) => {
      expect(effectiveFold(s, 3, {})).toBe(expected)
    })

    const shortMatrix: Array<[string, FoldableSection, 'full' | 'long' | 'short' | 'name']> = [
      ['both', both, 'short'],
      ['shortOnly', shortOnly, 'short'],
      // BUG regression: short with no shortSummary used to fall to long/full — the
      // spec's letter says it falls to NAME (the card renders from the title alone).
      ['longOnly', longOnly, 'name'],
      ['bare', bare, 'name'],
    ]
    it.each(shortMatrix)('base short, %s', (_label, s, expected) => {
      expect(effectiveFold(s, 10, {})).toBe(expected)
    })

    it('name never degrades — the undocumented name→full rule is gone', () => {
      // BUG regression: name with no shortSummary used to jump to long/full, blowing
      // the deep past up into prose. A NameCard needs no summary text at all.
      expect(effectiveFold(bare, 20, {})).toBe('name')
      expect(effectiveFold(longOnly, 20, {})).toBe('name')
      expect(effectiveFold(bare, 0, { S1: 'name' })).toBe('name')
    })

    it('pinned levels degrade by the same matrix', () => {
      expect(effectiveFold(bare, 0, { S1: 'long' })).toBe('full')
      expect(effectiveFold(shortOnly, 0, { S1: 'long' })).toBe('short')
      expect(effectiveFold(bare, 0, { S1: 'short' })).toBe('name')
    })
  })
})
