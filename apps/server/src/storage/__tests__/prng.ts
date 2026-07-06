/**
 * Tiny seeded PRNG for the property/fuzz suites (spec 02 §12): mulberry32 — 32-bit
 * state, deterministic across platforms, no dependency. Not for production use.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Uniform integer in [0, maxExclusive). */
export function randInt(rand: () => number, maxExclusive: number): number {
  return Math.floor(rand() * maxExclusive)
}

/** Uniform pick from a non-empty array. */
export function pick<T>(rand: () => number, items: readonly T[]): T {
  const item = items[randInt(rand, items.length)]
  if (item === undefined) throw new Error('pick: empty array')
  return item
}
