import type { ContextSearchArgs, ContextSearchMatch } from '@cowrite/shared'
import type { WorkSnapshot } from './snapshot.js'

/**
 * `context_search` (docs/06-context-engine.md §6): case-insensitive literal substring
 * with an optional whole-word flag, over section `content.md` files, live snippet texts,
 * and world-entry bodies — everything a hit could usefully expand. A linear scan over a
 * few MB is milliseconds; no index needed. Served from the task's frozen snapshot so
 * results are idempotent under concurrent background writes (§10). Regex is deferred.
 */

export const MAX_MATCHES = 20
/** ~40 tokens of excerpt around the match, approximated as chars each side. */
const EXCERPT_RADIUS_CHARS = 80

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}_]/u.test(ch)
}

function excerptAround(text: string, index: number, length: number): string {
  let lo = Math.max(0, index - EXCERPT_RADIUS_CHARS)
  let hi = Math.min(text.length, index + length + EXCERPT_RADIUS_CHARS)
  // trim to word boundaries so excerpts don't open/close mid-word
  while (lo > 0 && isWordChar(text[lo - 1]) && isWordChar(text[lo])) lo--
  while (hi < text.length && isWordChar(text[hi - 1]) && isWordChar(text[hi])) hi++
  const prefix = lo > 0 ? '…' : ''
  const suffix = hi < text.length ? '…' : ''
  return `${prefix}${text.slice(lo, hi).replaceAll('\n', ' ').trim()}${suffix}`
}

function scanText(
  text: string,
  query: string,
  wholeWord: boolean,
  onMatch: (index: number, line: number) => boolean,
): void {
  const haystack = text.toLowerCase()
  const needle = query.toLowerCase()
  if (needle === '') return
  let from = 0
  let line = 1
  let lineScanPos = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at === -1) return
    from = at + 1
    if (wholeWord && (isWordChar(text[at - 1]) || isWordChar(text[at + needle.length]))) continue
    // advance the line counter incrementally (matches arrive in ascending order)
    for (let i = lineScanPos; i < at; i++) {
      if (text[i] === '\n') line++
    }
    lineScanPos = at
    if (!onMatch(at, line)) return
  }
}

export function searchSnapshot(
  snapshot: WorkSnapshot,
  args: ContextSearchArgs,
): ContextSearchMatch[] {
  const matches: ContextSearchMatch[] = []
  const wholeWord = args.wholeWord ?? false

  const scanEntity = (
    kind: 'section' | 'snippet' | 'world',
    id: string,
    path: string,
    text: string,
  ): boolean => {
    let keepGoing = true
    scanText(text, args.query, wholeWord, (index, line) => {
      matches.push({ kind, id, path, line, excerpt: excerptAround(text, index, args.query.length) })
      keepGoing = matches.length < MAX_MATCHES
      return keepGoing
    })
    return keepGoing
  }

  const sections =
    args.scope === undefined
      ? snapshot.sections
      : snapshot.sections.filter((s) => {
          // scope: the named section and its whole subtree
          if (s.id === args.scope?.id) return true
          let cursor = s.parentId
          while (cursor !== null) {
            if (cursor === args.scope?.id) return true
            cursor = snapshot.sectionById.get(cursor)?.parentId ?? null
          }
          return false
        })

  for (const s of sections) {
    if (s.content === null) continue
    const path = s.path === '' ? s.name : `${s.path} › ${s.name}`
    if (!scanEntity('section', s.id, path, s.content)) return matches
  }
  if (args.scope === undefined) {
    for (const snippet of snapshot.snippets) {
      if (!scanEntity('snippet', snippet.id, 'frontier', snippet.text)) return matches
    }
    for (const entry of snapshot.worldEntries) {
      if (!scanEntity('world', entry.id, entry.name, entry.body)) return matches
    }
  }
  return matches
}

/** Render matches as the tool-result body (byte-deterministic). */
export function renderSearchResults(query: string, matches: ContextSearchMatch[]): string {
  if (matches.length === 0) {
    return `No matches for "${query}". Try a shorter or different phrase.`
  }
  const lines = matches.map((m) => `- [${m.kind} ${m.id}] ${m.path}:${m.line} — ${m.excerpt}`)
  const cap =
    matches.length >= MAX_MATCHES
      ? `\n(first ${MAX_MATCHES} matches — narrow the query or scope for more)`
      : ''
  return `${matches.length} match${matches.length === 1 ? '' : 'es'} for "${query}":\n${lines.join('\n')}${cap}`
}
