import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing'

/**
 * Fractional order keys over the base-36 alphabet `0-9a-z` (spec 02 §4). Sort
 * lexicographically; ties are broken by the caller with the entity ULID.
 *
 * Two generators cooperate behind the one exported API (keyBetween / nKeysBetween):
 *
 * - fractional-indexing (fast path), with the same alphabet passed as `intDigits`
 *   (integer-part head markers): the library's default heads use `A-Z` for keys before
 *   the first, which would escape the lowercase-only OrderKey charset and break ordering
 *   on case-insensitive filesystems (Windows is a first-class target). With
 *   lowercase-only heads every generated key — including insert-before-first — matches
 *   `^[0-9a-z]+$`. The first key is therefore 'i0' rather than the library default 'a0'.
 * - a pure-lexicographic midpoint fallback, used whenever the library REJECTS the
 *   bounds. Files are the truth: users hand-author keys like the spec's own §5.4
 *   sample 'a0', which satisfies the shared OrderKey regex but not the library grammar
 *   — such keys must work as bounds instead of aborting a reconcile or an append.
 *   Routing is by attempting the library call and catching its rejection, so the
 *   classification can never drift from the installed library's own grammar (there is
 *   no hand-maintained predicate to keep in sync). Fallback keys are strictly between
 *   their bounds, never end in '0' (so a later insert below one always has room), and
 *   always match the regex.
 */

export const ORDER_KEY_DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz'

const ORDER_KEY_RE = /^[0-9a-z]+$/
const ZERO = '0'

export function isValidOrderKey(key: string): boolean {
  return ORDER_KEY_RE.test(key)
}

/**
 * Thrown for the one gap no key can fill: `between(a, b)` where `b` is `a` (or, for an
 * open lower bound, nothing) extended by only '0' digits — e.g. `between(null, '000')`
 * or `between('a', 'a0')`. '0' is the alphabet's smallest digit and generated keys
 * never end in '0', so nothing sorts strictly inside such a gap; only hand-authored
 * keys can create one. The caller must renumber the surrounding keys (e.g. rewrite
 * them with fresh `nKeysBetween` output) rather than retry.
 */
export class OrderKeyGapExhaustedError extends Error {
  constructor(
    readonly lower: string | null,
    readonly upper: string,
  ) {
    super(
      `no order key sorts between ${JSON.stringify(lower)} and ${JSON.stringify(upper)}: ` +
        "the upper bound extends the lower by only '0' digits — renumber the existing keys",
    )
    this.name = 'OrderKeyGapExhaustedError'
  }
}

function assertValidBound(key: string | null, side: 'a' | 'b'): void {
  if (key !== null && !isValidOrderKey(key)) {
    throw new Error(`invalid order key for bound ${side}: ${JSON.stringify(key)}`)
  }
}

/** No key sorts strictly between `a` and `b` iff `b` is `a` right-padded with '0's. */
function gapIsEmpty(a: string, b: string): boolean {
  for (let i = 0; i < b.length; i++) {
    if (b.charAt(i) !== (a.charAt(i) || ZERO)) return false
  }
  return true
}

/**
 * The classic lexicographic-midpoint step over ORDER_KEY_DIGITS: a key strictly between
 * `a` ('' = open start) and `b` (null = open end) that never ends in '0'. Preconditions
 * (enforced by fallbackBetween): `a < b` when `b` is non-null, and the gap is non-empty.
 */
function lexMidpoint(a: string, b: string | null): string {
  if (b !== null) {
    // Strip the longest common prefix, reading `a` as if right-padded with '0's.
    let n = 0
    while (n < b.length && (a.charAt(n) || ZERO) === b.charAt(n)) n++
    if (n > 0) return b.slice(0, n) + lexMidpoint(a.slice(n), b.slice(n))
  }
  const digitA = a === '' ? 0 : ORDER_KEY_DIGITS.indexOf(a.charAt(0))
  const digitB = b === null ? ORDER_KEY_DIGITS.length : ORDER_KEY_DIGITS.indexOf(b.charAt(0))
  if (digitB - digitA > 1) {
    // Room at this position: one strictly-inside digit ends the key. It is never '0'
    // because the midpoint is strictly greater than digitA >= 0.
    return ORDER_KEY_DIGITS.charAt(Math.round(0.5 * (digitA + digitB)))
  }
  // Consecutive first digits: b's first digit alone works iff b has more after it …
  if (b !== null && b.length > 1) return b.slice(0, 1)
  // … otherwise recurse under a's first digit with an open upper bound.
  return ORDER_KEY_DIGITS.charAt(digitA) + lexMidpoint(a.slice(1), null)
}

/**
 * Fallback generation for bounds the library grammar rejects. Mirrors the library's
 * bound handling (out-of-order bounds are swapped, equal bounds throw); append-after is
 * simply the midpoint between `a` and the open end.
 */
function fallbackBetween(a: string | null, b: string | null): string {
  let lo = a
  let hi = b
  if (lo !== null && hi !== null) {
    if (lo === hi) throw new Error(`order key bounds are equal: ${JSON.stringify(lo)}`)
    if (lo > hi) [lo, hi] = [hi, lo]
  }
  if (hi !== null && gapIsEmpty(lo ?? '', hi)) throw new OrderKeyGapExhaustedError(lo, hi)
  return lexMidpoint(lo ?? '', hi)
}

/**
 * Generate a key strictly between `a` and `b` (null = open end). Accepts ANY bound
 * matching the shared OrderKey regex, hand-authored or generated.
 * @throws OrderKeyGapExhaustedError for the degenerate all-'0' gap (see the class doc).
 */
export function keyBetween(a: string | null, b: string | null): string {
  assertValidBound(a, 'a')
  assertValidBound(b, 'b')
  try {
    return generateKeyBetween(a, b, ORDER_KEY_DIGITS, ORDER_KEY_DIGITS)
  } catch {
    // The library rejected a bound (or the gap): the fallback decides conclusively,
    // throwing the typed errors above for genuinely impossible gaps.
    return fallbackBetween(a, b)
  }
}

/**
 * Generate `n` distinct sorted keys strictly between `a` and `b` (null = open end).
 * Kept for M1 Stage 4: the consolidation engine renumbers key runs with it.
 */
export function nKeysBetween(a: string | null, b: string | null, n: number): string[] {
  assertValidBound(a, 'a')
  assertValidBound(b, 'b')
  try {
    return generateNKeysBetween(a, b, n, ORDER_KEY_DIGITS, ORDER_KEY_DIGITS)
  } catch {
    // library-rejected bounds: fall through to the fallback splitting below
  }
  // The library's own splitting strategy, over the fallback generator.
  if (n <= 0) return []
  if (n === 1) return [fallbackBetween(a, b)]
  if (b === null) {
    const keys: string[] = []
    let c = a
    for (let i = 0; i < n; i++) {
      c = fallbackBetween(c, null)
      keys.push(c)
    }
    return keys
  }
  if (a === null) {
    const keys: string[] = []
    let c: string = b
    for (let i = 0; i < n; i++) {
      c = fallbackBetween(null, c)
      keys.push(c)
    }
    return keys.reverse()
  }
  const mid = Math.floor(n / 2)
  const c = fallbackBetween(a, b)
  return [...nKeysBetween(a, c, mid), c, ...nKeysBetween(c, b, n - mid - 1)]
}

/**
 * Plain lexicographic comparison (the alphabet is ASCII-ascending, so code-unit order is
 * key order). Returns negative/zero/positive; equal keys are tie-broken by the caller
 * using the entity ULID (spec 02 §4).
 */
export function compareOrderKeys(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}
