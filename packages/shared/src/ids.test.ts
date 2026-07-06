import { describe, expect, it } from 'vitest'
import { EntityKind, Hash, IsoTime, OrderKey, Ulid } from './ids.js'

describe('Ulid', () => {
  it('accepts a 26-char Crockford base32 ULID', () => {
    expect(Ulid.parse('01J2P7R9GT5W0ZNXK3M8QAB4CD')).toBe('01J2P7R9GT5W0ZNXK3M8QAB4CD')
  })

  it('rejects wrong length, lowercase, and excluded letters (I L O U)', () => {
    expect(Ulid.safeParse('01J2P7R9GT5W0ZNXK3M8QAB4C').success).toBe(false) // 25 chars
    expect(Ulid.safeParse('01J2P7R9GT5W0ZNXK3M8QAB4CDX').success).toBe(false) // 27 chars
    expect(Ulid.safeParse('01j2p7r9gt5w0znxk3m8qab4cd').success).toBe(false) // lowercase
    expect(Ulid.safeParse('01J2P7R9GT5W0ZNXK3M8QAB4CI').success).toBe(false) // I
    expect(Ulid.safeParse('01J2P7R9GT5W0ZNXK3M8QAB4CL').success).toBe(false) // L
    expect(Ulid.safeParse('01J2P7R9GT5W0ZNXK3M8QAB4CO').success).toBe(false) // O
    expect(Ulid.safeParse('01J2P7R9GT5W0ZNXK3M8QAB4CU').success).toBe(false) // U
    expect(Ulid.safeParse('').success).toBe(false)
  })
})

describe('OrderKey', () => {
  it('accepts base-36 fractional keys', () => {
    expect(OrderKey.parse('a2')).toBe('a2')
    expect(OrderKey.parse('0')).toBe('0')
    expect(OrderKey.parse('zz9')).toBe('zz9')
  })

  it('rejects empty, uppercase, and out-of-alphabet characters', () => {
    expect(OrderKey.safeParse('').success).toBe(false)
    expect(OrderKey.safeParse('A2').success).toBe(false)
    expect(OrderKey.safeParse('a.2').success).toBe(false)
    expect(OrderKey.safeParse('a 2').success).toBe(false)
  })
})

describe('IsoTime', () => {
  it('accepts UTC ISO-8601 datetimes', () => {
    expect(IsoTime.parse('2026-07-06T14:02:11Z')).toBe('2026-07-06T14:02:11Z')
  })

  it('rejects date-only and non-datetime strings', () => {
    expect(IsoTime.safeParse('2026-07-06').success).toBe(false)
    expect(IsoTime.safeParse('yesterday').success).toBe(false)
  })
})

describe('Hash', () => {
  it('accepts xxh64-prefixed 16-hex-digit hashes', () => {
    expect(Hash.parse('xxh64:0123456789abcdef')).toBe('xxh64:0123456789abcdef')
  })

  it('rejects missing prefix, wrong length, and uppercase hex', () => {
    expect(Hash.safeParse('0123456789abcdef').success).toBe(false)
    expect(Hash.safeParse('xxh64:0123456789abcde').success).toBe(false)
    expect(Hash.safeParse('xxh64:0123456789abcdef0').success).toBe(false)
    expect(Hash.safeParse('xxh64:0123456789ABCDEF').success).toBe(false)
    expect(Hash.safeParse('sha256:0123456789abcdef').success).toBe(false)
  })
})

describe('EntityKind', () => {
  it('is the closed five-kind enum', () => {
    expect(EntityKind.options).toEqual(['work', 'section', 'snippet', 'world', 'run'])
    expect(EntityKind.safeParse('illustration').success).toBe(false)
  })
})
