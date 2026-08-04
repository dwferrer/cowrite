import { describe, expect, it } from 'vitest'
import { createSyncHasher, TokenEstimator } from '../estimate.js'

/**
 * The one token estimator (docs/06-context-engine.md §8.3): gpt-tokenizer (cl100k),
 * hash-cached lazy counts, deterministic head/tail token slicing.
 */

describe('TokenEstimator', () => {
  it('counts tokens deterministically and non-trivially', () => {
    const est = new TokenEstimator()
    const text = 'The lighthouse keeper counted the ships while the fog rolled in.'
    const n = est.count(text)
    expect(n).toBeGreaterThan(5)
    expect(n).toBeLessThan(text.length)
    expect(est.count(text)).toBe(n)
  })

  it('empty text is 0 tokens', () => {
    expect(new TokenEstimator().count('')).toBe(0)
  })

  it('caches by the caller-provided content hash: same key skips retokenization', () => {
    const est = new TokenEstimator()
    const first = est.count('one two three four five', 'xxh64:aaaaaaaaaaaaaaaa')
    // Same key, DIFFERENT text: the cache answers — proof the key drives the lookup.
    const second = est.count(
      'completely different and much longer text here',
      'xxh64:aaaaaaaaaaaaaaaa',
    )
    expect(second).toBe(first)
  })

  it('without a key, different texts get independent counts', () => {
    const est = new TokenEstimator()
    expect(est.count('a b c')).not.toBe(est.count('a much longer sentence with many words in it'))
  })

  it('headByTokens returns a decoded prefix of at most n tokens', () => {
    const est = new TokenEstimator()
    const text = 'One two three four five six seven eight nine ten eleven twelve.'
    const head = est.headByTokens(text, 4)
    expect(text.startsWith(head)).toBe(true)
    expect(est.count(head)).toBeLessThanOrEqual(4)
    expect(est.headByTokens(text, 10_000)).toBe(text)
    expect(est.headByTokens(text, 0)).toBe('')
  })

  it('at capacity, evicts the oldest half by insertion order — no full-clear cliff', () => {
    const est = new TokenEstimator(4)
    for (let i = 0; i < 4; i++) est.count(`word${i} filler text`, `k${i}`)
    expect(est.cacheSize).toBe(4)
    // The 5th insert evicts k0/k1 (oldest half) and keeps k2/k3 warm.
    est.count('the fifth entry arrives', 'k4')
    expect(est.cacheSize).toBe(3)
    // Warm keys still answer from the cache: same key + different text ⇒ cached count.
    const k3 = est.count('word3 filler text', 'k3')
    expect(est.count('a completely different and much longer string', 'k3')).toBe(k3)
    expect(est.cacheSize).toBe(3)
    // Evicted keys retokenize: the same probe under an evicted key gets the fresh count.
    expect(est.count('a completely different and much longer string', 'k0')).not.toBe(k3)
  })

  it('tailByTokens returns a decoded suffix of at most n tokens', () => {
    const est = new TokenEstimator()
    const text = 'One two three four five six seven eight nine ten eleven twelve.'
    const tail = est.tailByTokens(text, 4)
    expect(text.endsWith(tail)).toBe(true)
    expect(est.count(tail)).toBeLessThanOrEqual(4)
    expect(est.tailByTokens(text, 10_000)).toBe(text)
  })
})

describe('createSyncHasher', () => {
  it('produces the shared Hash format and is stable', async () => {
    const hasher = await createSyncHasher()
    const h = hasher.hash('some text')
    expect(h).toMatch(/^xxh64:[0-9a-f]{16}$/)
    expect(hasher.hash('some text')).toBe(h)
    expect(hasher.hash('other text')).not.toBe(h)
  })
})
