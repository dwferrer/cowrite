import { describe, expect, it } from 'vitest'
import { wordCount, xxh64OfBuffer, xxh64OfString } from './hash.js'

const HASH_FORMAT = /^xxh64:[0-9a-f]{16}$/

describe('xxh64', () => {
  it('matches the shared Hash schema format', async () => {
    expect(await xxh64OfString('Mara pressed her palm against the storm glass')).toMatch(
      HASH_FORMAT,
    )
    expect(await xxh64OfBuffer(Uint8Array.from([1, 2, 3]))).toMatch(HASH_FORMAT)
  })

  it('produces the reference xxh64 value for the empty input', async () => {
    // XXH64("") with seed 0 — reference vector from the xxHash spec.
    expect(await xxh64OfString('')).toBe('xxh64:ef46db3751d8e999')
    expect(await xxh64OfBuffer(new Uint8Array(0))).toBe('xxh64:ef46db3751d8e999')
  })

  it('hashes a string and its UTF-8 bytes identically', async () => {
    const text = 'the storm glass — l’heure bleue'
    const viaString = await xxh64OfString(text)
    const viaBuffer = await xxh64OfBuffer(new TextEncoder().encode(text))
    expect(viaBuffer).toBe(viaString)
  })

  it('is deterministic and input-sensitive', async () => {
    expect(await xxh64OfString('abc')).toBe(await xxh64OfString('abc'))
    expect(await xxh64OfString('abc')).not.toBe(await xxh64OfString('abd'))
  })
})

describe('wordCount', () => {
  it('counts whitespace-separated words', () => {
    expect(wordCount('Mara pressed her palm')).toBe(4)
  })

  it('treats any whitespace run as one separator', () => {
    expect(wordCount('  one\ttwo\n\nthree   four  ')).toBe(4)
  })

  it('returns 0 for empty or whitespace-only text', () => {
    expect(wordCount('')).toBe(0)
    expect(wordCount('   \n\t ')).toBe(0)
  })
})
