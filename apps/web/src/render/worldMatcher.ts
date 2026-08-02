/**
 * World-key matcher (docs/04-frontend.md §6.3) — a dependency-free Aho–Corasick automaton
 * built from all keys of all entries, case-insensitive, word-boundary-checked on both ends.
 * Build cost O(total key chars); scan cost O(text length) per block. ALL matches per entry
 * per block are reported; `pickNonOverlapping` reduces them to a decoratable span set.
 */

export interface WorldKeySource {
  id: string
  keys: readonly string[]
}

export interface KeyMatch {
  /** [start, end) character offsets into the scanned text. */
  start: number
  end: number
  entryId: string
  key: string
}

interface Output {
  entryId: string
  key: string
  length: number
}

interface TrieNode {
  children: Map<string, number>
  fail: number
  outputs: Output[]
}

const WORD_CHAR = /[\p{L}\p{N}]/u

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && WORD_CHAR.test(ch)
}

/**
 * Length-preserving case fold. A handful of characters change UTF-16 length under
 * `toLowerCase()` (Turkish 'İ' → 'i̇' grows by one unit) — a whole-string lowercase
 * would shift every later span off its original offsets. Folding per character and
 * keeping any char whose fold changes length guarantees folded[i] aligns with text[i].
 */
function foldChar(ch: string): string {
  const lower = ch.toLowerCase()
  return lower.length === ch.length ? lower : ch
}

function foldText(text: string): string {
  let out = ''
  for (const ch of text) out += foldChar(ch) // per code point, so surrogate pairs stay paired
  return out
}

export class WorldMatcher {
  private readonly nodes: TrieNode[] = [{ children: new Map(), fail: 0, outputs: [] }]

  constructor(entries: readonly WorldKeySource[]) {
    for (const entry of entries) {
      for (const key of entry.keys) {
        // the same length-preserving fold as match(), so pattern lengths index originals
        const pattern = foldText(key)
        if (pattern.length === 0) continue
        let node = 0
        for (const ch of pattern.split('')) {
          const current = this.nodes[node] as TrieNode
          let next = current.children.get(ch)
          if (next === undefined) {
            next = this.nodes.length
            this.nodes.push({ children: new Map(), fail: 0, outputs: [] })
            current.children.set(ch, next)
          }
          node = next
        }
        ;(this.nodes[node] as TrieNode).outputs.push({
          entryId: entry.id,
          key,
          length: pattern.length,
        })
      }
    }
    // BFS failure links; outputs of the fail target are merged so every suffix match reports
    const queue: number[] = []
    const root = this.nodes[0] as TrieNode
    for (const child of root.children.values()) {
      ;(this.nodes[child] as TrieNode).fail = 0
      queue.push(child)
    }
    while (queue.length > 0) {
      const index = queue.shift() as number
      const node = this.nodes[index] as TrieNode
      for (const [ch, child] of node.children) {
        queue.push(child)
        let fail = node.fail
        while (fail !== 0 && !(this.nodes[fail] as TrieNode).children.has(ch)) {
          fail = (this.nodes[fail] as TrieNode).fail
        }
        const target = (this.nodes[fail] as TrieNode).children.get(ch)
        const childNode = this.nodes[child] as TrieNode
        childNode.fail = target !== undefined && target !== child ? target : 0
        childNode.outputs.push(...(this.nodes[childNode.fail] as TrieNode).outputs)
      }
    }
  }

  /** Every occurrence of every key, word-boundary-checked on both ends, case-insensitive. */
  match(text: string): KeyMatch[] {
    const lower = foldText(text)
    const matches: KeyMatch[] = []
    let state = 0
    for (let i = 0; i < lower.length; i++) {
      const ch = lower[i] as string
      while (state !== 0 && !(this.nodes[state] as TrieNode).children.has(ch)) {
        state = (this.nodes[state] as TrieNode).fail
      }
      state = (this.nodes[state] as TrieNode).children.get(ch) ?? 0
      for (const out of (this.nodes[state] as TrieNode).outputs) {
        const start = i - out.length + 1
        const end = i + 1
        if (isWordChar(text[start - 1]) || isWordChar(text[end])) continue // word boundaries
        matches.push({ start, end, entryId: out.entryId, key: out.key })
      }
    }
    return matches
  }
}

export function buildWorldMatcher(entries: readonly WorldKeySource[]): WorldMatcher {
  return new WorldMatcher(entries)
}

/**
 * Reduce raw matches (which may overlap, e.g. "storm" inside "storm glass") to a
 * non-overlapping span set for decoration: earliest start wins; on a tie the longest match.
 */
export function pickNonOverlapping(matches: readonly KeyMatch[]): KeyMatch[] {
  const sorted = [...matches].sort((a, b) => a.start - b.start || b.end - a.end)
  const chosen: KeyMatch[] = []
  let lastEnd = -1
  for (const m of sorted) {
    if (m.start < lastEnd) continue // overlaps (or duplicates) the previous chosen span
    chosen.push(m)
    lastEnd = m.end
  }
  return chosen
}
