import { countTokens, decode, encode } from 'gpt-tokenizer/encoding/cl100k_base'
import xxhash from 'xxhash-wasm'

/**
 * THE token estimator (docs/06-context-engine.md §8.3): one tokenizer for the whole
 * system — `gpt-tokenizer` (cl100k) as a consistent ±tokenMarginPct estimate. The engine
 * computes all counts itself, lazily, cached by content hash; no other subsystem
 * tokenizes. Counts are cached in an in-memory map keyed on the xxh64 hashes storage
 * already maintains when the caller has one, else on a cheap internal key.
 */

const CACHE_MAX = 50_000

export class TokenEstimator {
  private readonly cache = new Map<string, number>()
  private readonly cacheMax: number

  constructor(cacheMax = CACHE_MAX) {
    this.cacheMax = cacheMax
  }

  /** Estimated token count of `text`; `cacheKey` is a content hash when the caller has one. */
  count(text: string, cacheKey?: string): number {
    if (text === '') return 0
    const key = cacheKey ?? `s:${text.length}:${fnv1a(text)}`
    const hit = this.cache.get(key)
    if (hit !== undefined) return hit
    const n = countTokens(text)
    if (this.cache.size >= this.cacheMax) this.evictOldestHalf()
    this.cache.set(key, n)
    return n
  }

  /** Cache size, exposed for the eviction tests. */
  get cacheSize(): number {
    return this.cache.size
  }

  /**
   * At capacity, drop the oldest half by Map insertion order instead of clearing —
   * a full clear() is a re-tokenization cliff for every live count right after it.
   */
  private evictOldestHalf(): void {
    const drop = Math.ceil(this.cache.size / 2)
    let n = 0
    for (const key of this.cache.keys()) {
      if (n >= drop) break
      this.cache.delete(key)
      n += 1
    }
  }

  /** The first ≤ `maxTokens` tokens of `text`, decoded back to a string (deterministic). */
  headByTokens(text: string, maxTokens: number): string {
    if (maxTokens <= 0) return ''
    const tokens = encode(text)
    if (tokens.length <= maxTokens) return text
    return decode(tokens.slice(0, maxTokens))
  }

  /** The last ≤ `maxTokens` tokens of `text`, decoded back to a string (deterministic). */
  tailByTokens(text: string, maxTokens: number): string {
    if (maxTokens <= 0) return ''
    const tokens = encode(text)
    if (tokens.length <= maxTokens) return text
    return decode(tokens.slice(tokens.length - maxTokens))
  }
}

/** Cheap sync 32-bit FNV-1a over UTF-16 code units — internal cache keying only. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}

// ---------------------------------------------------------------------------
// Sync xxh64 hashing in the shared `Hash` format ('xxh64:<16 hex>'). The wasm module
// initializes asynchronously, so the engine constructs the hasher once in `load` and
// everything downstream hashes synchronously (assembly must be sync + deterministic).
// ---------------------------------------------------------------------------

export interface SyncHasher {
  hash(text: string): string
}

export async function createSyncHasher(): Promise<SyncHasher> {
  const { h64ToString } = await xxhash()
  return { hash: (text) => `xxh64:${h64ToString(text)}` }
}
