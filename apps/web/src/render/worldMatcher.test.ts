import { describe, expect, it } from 'vitest'
import { buildWorldMatcher, type KeyMatch, pickNonOverlapping } from './worldMatcher.js'

const spans = (text: string, matches: KeyMatch[]) => matches.map((m) => text.slice(m.start, m.end))

describe('WorldMatcher', () => {
  it('matches a key case-insensitively and reports the entry id', () => {
    const matcher = buildWorldMatcher([{ id: 'E1', keys: ['Mara Voss'] }])
    const text = 'Then MARA VOSS turned; mara voss smiled.'
    const matches = matcher.match(text)
    expect(matches).toHaveLength(2)
    expect(matches.every((m) => m.entryId === 'E1')).toBe(true)
    expect(spans(text, matches)).toEqual(['MARA VOSS', 'mara voss'])
  })

  it('enforces word boundaries on both ends', () => {
    const matcher = buildWorldMatcher([{ id: 'E1', keys: ['Mara'] }])
    expect(matcher.match('Maraud the Marauder')).toHaveLength(0)
    expect(matcher.match('Amara spoke')).toHaveLength(0)
    const ok = matcher.match('Mara, then (Mara) and Mara')
    expect(ok).toHaveLength(3)
  })

  it('finds ALL occurrences per entry per block', () => {
    const matcher = buildWorldMatcher([{ id: 'E1', keys: ['glass'] }])
    const text = 'glass on glass under glass'
    expect(matcher.match(text)).toHaveLength(3)
  })

  it('matches multi-word keys across internal spaces', () => {
    const matcher = buildWorldMatcher([{ id: 'E1', keys: ['storm glass'] }])
    const text = 'She held the storm glass tight.'
    const matches = matcher.match(text)
    expect(spans(text, matches)).toEqual(['storm glass'])
  })

  it('reports overlapping matches from different keys', () => {
    const matcher = buildWorldMatcher([
      { id: 'E1', keys: ['storm'] },
      { id: 'E2', keys: ['storm glass'] },
    ])
    const text = 'the storm glass cracked'
    const matches = matcher.match(text)
    // "storm" (E1) and "storm glass" (E2) both match — all matches are reported
    expect(matches.map((m) => m.entryId).sort()).toEqual(['E1', 'E2'])
  })

  it('matches keys from multiple entries in one scan', () => {
    const matcher = buildWorldMatcher([
      { id: 'E1', keys: ['Mara', 'the ferry'] },
      { id: 'E2', keys: ['lighthouse'] },
    ])
    const text = 'Mara took the ferry past the lighthouse.'
    const matches = matcher.match(text)
    expect(matches.map((m) => m.key).sort()).toEqual(['Mara', 'lighthouse', 'the ferry'])
  })

  it('handles empty key lists (entries without keys never highlight)', () => {
    const matcher = buildWorldMatcher([{ id: 'E1', keys: [] }])
    expect(matcher.match('anything at all')).toHaveLength(0)
  })

  it('keeps spans aligned across length-changing case folds (Turkish İ)', () => {
    // Regression: matching ran on text.toLowerCase(), but 'İ'.toLowerCase() is two
    // UTF-16 units ('i̇') — every span after the İ indexed one unit off the original.
    const matcher = buildWorldMatcher([{ id: 'E1', keys: ['Aria'] }])
    const text = 'İstanbul is where Aria lives'
    const matches = matcher.match(text)
    expect(spans(text, matches)).toEqual(['Aria'])
    expect(matches[0]?.start).toBe(text.indexOf('Aria'))
    expect(matches[0]?.end).toBe(text.indexOf('Aria') + 'Aria'.length)
  })
})

describe('pickNonOverlapping', () => {
  it('keeps the earliest-start longest span and drops overlaps', () => {
    const matcher = buildWorldMatcher([
      { id: 'E1', keys: ['storm'] },
      { id: 'E2', keys: ['storm glass'] },
      { id: 'E3', keys: ['glass'] },
    ])
    const text = 'the storm glass cracked'
    const chosen = pickNonOverlapping(matcher.match(text))
    expect(chosen).toHaveLength(1)
    expect(chosen[0]?.entryId).toBe('E2')
    expect(spans(text, chosen)).toEqual(['storm glass'])
  })

  it('keeps non-overlapping matches intact and sorted', () => {
    const matcher = buildWorldMatcher([
      { id: 'E1', keys: ['Mara'] },
      { id: 'E2', keys: ['ferry'] },
    ])
    const text = 'Mara took the ferry; Mara paid.'
    const chosen = pickNonOverlapping(matcher.match(text))
    expect(spans(text, chosen)).toEqual(['Mara', 'ferry', 'Mara'])
  })
})
