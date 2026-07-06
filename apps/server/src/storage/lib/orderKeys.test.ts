import { describe, expect, it } from 'vitest'
import {
  compareOrderKeys,
  isValidOrderKey,
  keyBetween,
  nKeysBetween,
  OrderKeyGapExhaustedError,
} from './orderKeys.js'

/** Regex-valid keys users hand-author (spec 02 §5.4 samples and friends) that the
 *  fractional-indexing key grammar rejects — they must exercise the fallback. */
const HAND_KEYS = ['a0', 'a2', 'z', '0z', 'zz'] as const

describe('keyBetween', () => {
  it('generates a first key when both bounds are open', () => {
    expect(keyBetween(null, null)).toBe('i0')
  })

  it('appends after the last key', () => {
    const a = keyBetween(null, null)
    const b = keyBetween(a, null)
    const c = keyBetween(b, null)
    expect(compareOrderKeys(a, b)).toBeLessThan(0)
    expect(compareOrderKeys(b, c)).toBeLessThan(0)
  })

  it('inserts between two neighbors', () => {
    const a = keyBetween(null, null)
    const c = keyBetween(a, null)
    const b = keyBetween(a, c)
    expect(a < b && b < c).toBe(true)
  })

  it('inserts before the first key, staying in the lowercase alphabet', () => {
    const first = keyBetween(null, null)
    const before = keyBetween(null, first)
    expect(before < first).toBe(true)
    expect(isValidOrderKey(before)).toBe(true)
  })

  it('survives long append / prepend / midpoint chains with valid, ordered keys', () => {
    let head = keyBetween(null, null)
    let tail = head
    const keys = [head]
    for (let i = 0; i < 200; i++) {
      tail = keyBetween(tail, null)
      keys.push(tail)
      head = keyBetween(null, head)
      keys.unshift(head)
    }
    // dense midpoints between the two smallest keys
    let lo = keys[0] as string
    const hi = keys[1] as string
    const mids: string[] = []
    for (let i = 0; i < 50; i++) {
      const mid = keyBetween(lo, hi)
      expect(lo < mid && mid < hi).toBe(true)
      lo = mid
      mids.push(mid)
    }
    keys.splice(1, 0, ...mids)
    for (const key of keys) expect(isValidOrderKey(key)).toBe(true)
    const sorted = [...keys].sort(compareOrderKeys)
    expect(sorted).toEqual(keys)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('rejects malformed bounds', () => {
    expect(() => keyBetween('A0', null)).toThrow(/invalid order key/)
    expect(() => keyBetween(null, 'a 0')).toThrow(/invalid order key/)
    expect(() => keyBetween('', null)).toThrow(/invalid order key/)
  })
})

describe('hand-authored (non-library) bounds take the lexicographic fallback', () => {
  it("inserts between the spec's own §5.4 sample keys", () => {
    const mid = keyBetween('a0', 'a2')
    expect('a0' < mid && mid < 'a2').toBe(true)
    expect(isValidOrderKey(mid)).toBe(true)
  })

  it('appends after any hand-authored key with a valid, larger key', () => {
    for (const key of HAND_KEYS) {
      const next = keyBetween(key, null)
      expect(compareOrderKeys(key, next)).toBeLessThan(0)
      expect(isValidOrderKey(next)).toBe(true)
      expect(next.endsWith('0')).toBe(false) // room below it always survives
    }
  })

  it('inserts before any hand-authored key with a valid, smaller key', () => {
    for (const key of HAND_KEYS) {
      const prev = keyBetween(null, key)
      expect(compareOrderKeys(prev, key)).toBeLessThan(0)
      expect(isValidOrderKey(prev)).toBe(true)
      expect(prev.endsWith('0')).toBe(false)
    }
  })

  it('mixes library and hand-authored bounds in either order', () => {
    const lib = keyBetween(null, null) // 'i0'
    const below = keyBetween('a0', lib)
    expect('a0' < below && below < lib).toBe(true)
    const above = keyBetween(lib, 'z')
    expect(lib < above && above < 'z').toBe(true)
    for (const key of [below, above]) expect(isValidOrderKey(key)).toBe(true)
  })

  it('survives dense midpoint chains seeded from hand-authored keys', () => {
    for (const [seedLo, seedHi] of [
      ['a0', 'a2'],
      ['0z', 'z'],
      ['z', 'zz'],
    ] as const) {
      let lo: string = seedLo
      for (let i = 0; i < 100; i++) {
        const mid = keyBetween(lo, seedHi)
        expect(lo < mid && mid < seedHi).toBe(true)
        expect(isValidOrderKey(mid)).toBe(true)
        lo = mid
      }
    }
  })

  it('sustains long append chains from a hand-authored frontier', () => {
    let tail = 'zz'
    const keys = [tail]
    for (let i = 0; i < 200; i++) {
      tail = keyBetween(tail, null)
      keys.push(tail)
    }
    for (const key of keys) expect(isValidOrderKey(key)).toBe(true)
    expect([...keys].sort(compareOrderKeys)).toEqual(keys)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('routes a key the LIBRARY rejects to the fallback even when it looks library-shaped', () => {
    // The reserved smallest integer (most-negative head + all-'0' digits) has a valid
    // head and integer-part length, yet generateKeyBetween rejects it outright. With
    // classification-by-attempt there is no hand-maintained grammar to drift: the
    // rejection itself routes the call to the lexicographic fallback.
    const reserved = '0'.repeat(19)
    const after = keyBetween(reserved, null)
    expect(compareOrderKeys(reserved, after)).toBeLessThan(0)
    expect(isValidOrderKey(after)).toBe(true)
    const between = keyBetween(reserved, '1')
    expect(reserved < between && between < '1').toBe(true)
    expect(between.endsWith('0')).toBe(false)
  })

  it("throws the typed renumber error for the empty gap below an all-'0' bound", () => {
    expect(() => keyBetween(null, '0')).toThrow(OrderKeyGapExhaustedError)
    expect(() => keyBetween(null, '000')).toThrow(/renumber/)
    expect(() => keyBetween('a', 'a00')).toThrow(OrderKeyGapExhaustedError)
  })
})

describe('nKeysBetween', () => {
  it('generates n distinct sorted keys between open bounds', () => {
    const keys = nKeysBetween(null, null, 5)
    expect(keys).toHaveLength(5)
    expect([...keys].sort(compareOrderKeys)).toEqual(keys)
    expect(new Set(keys).size).toBe(5)
    for (const key of keys) expect(isValidOrderKey(key)).toBe(true)
  })

  it('generates keys strictly inside closed bounds', () => {
    const a = keyBetween(null, null)
    const b = keyBetween(a, null)
    const keys = nKeysBetween(a, b, 7)
    for (const key of keys) {
      expect(a < key && key < b).toBe(true)
      expect(isValidOrderKey(key)).toBe(true)
    }
    expect([...keys].sort(compareOrderKeys)).toEqual(keys)
  })

  it('returns an empty array for n = 0', () => {
    expect(nKeysBetween(null, null, 0)).toEqual([])
  })

  it('generates ordered in-bound keys between hand-authored bounds (fallback)', () => {
    for (const [a, b] of [
      ['a0', 'a2'],
      [null, '0z'],
      ['zz', null],
      ['a2', 'i0'], // hand-authored low bound, library high bound
    ] as const) {
      const keys = nKeysBetween(a, b, 9)
      expect(keys).toHaveLength(9)
      expect([...keys].sort(compareOrderKeys)).toEqual(keys)
      expect(new Set(keys).size).toBe(9)
      for (const key of keys) {
        expect(isValidOrderKey(key)).toBe(true)
        if (a !== null) expect(a < key).toBe(true)
        if (b !== null) expect(key < b).toBe(true)
      }
    }
  })
})

describe('isValidOrderKey', () => {
  it('accepts base-36 lowercase keys', () => {
    for (const key of ['i0', 'a0', '0z9', 'zzzz']) expect(isValidOrderKey(key)).toBe(true)
  })

  it('rejects uppercase, empty, and out-of-alphabet strings', () => {
    for (const key of ['', 'A0', 'a_0', 'a 0', 'a-0', 'å0']) {
      expect(isValidOrderKey(key)).toBe(false)
    }
  })
})

describe('compareOrderKeys', () => {
  it('orders lexicographically and reports equality', () => {
    expect(compareOrderKeys('i0', 'i1')).toBeLessThan(0)
    expect(compareOrderKeys('i1', 'i0')).toBeGreaterThan(0)
    expect(compareOrderKeys('i0', 'i0')).toBe(0)
    // a shorter key sorts before its own extension
    expect(compareOrderKeys('i0', 'i0i')).toBeLessThan(0)
  })
})
