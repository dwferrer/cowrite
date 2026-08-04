import type { AnchorExcerpt } from '@cowrite/shared'
import type { SyncHasher, TokenEstimator } from './estimate.js'
import type { SnapshotSection, WorkSnapshot } from './snapshot.js'

/**
 * Voice anchors (docs/06-context-engine.md §4.3): 3–5 pinned excerpts sampled from
 * across the finished manuscript by pure positional stratification — deterministic given
 * inputs, zero scoring machinery, zero per-task churn. Excerpts pin a char range, token
 * count, and a content hash of the excerpt text; a hash mismatch at beginTask re-derives
 * ONLY that excerpt in place (cache-friendly single-region invalidation).
 */

const MAX_EXCERPTS = 4

/** Anchor candidates: frozen leaf sections with content, excluding the newest one
 *  (its mood already adjoins the frontier). Document order. */
export function anchorCandidates(snapshot: WorkSnapshot): SnapshotSection[] {
  const leaves = snapshot.sections.filter((s) => s.leaf && s.content !== null && s.content !== '')
  return leaves.slice(0, Math.max(0, leaves.length - 1))
}

/**
 * Take a contiguous excerpt from the section START (scene openings establish voice
 * fastest), sized `sizeTokens`, cut at the last paragraph boundary within size.
 */
export function deriveExcerpt(
  section: SnapshotSection,
  sizeTokens: number,
  est: TokenEstimator,
  hasher: SyncHasher,
): AnchorExcerpt {
  const content = section.content ?? ''
  let text = est.headByTokens(content, sizeTokens)
  if (text.length < content.length) {
    const lastBoundary = text.lastIndexOf('\n\n')
    if (lastBoundary > 0) text = text.slice(0, lastBoundary)
  }
  return {
    sectionId: section.id,
    start: 0,
    end: text.length,
    tokens: est.count(text),
    contentHash: hasher.hash(text),
  }
}

/**
 * §4.3 selection, verbatim: K = min(4, candidates); divide the manuscript by cumulative
 * token position into K equal spans; per span pick the candidate with the largest content
 * token count (tie-break: document order), skipping already-picked sections; excerpt from
 * each winner's start, sized budget/K.
 */
export function selectAnchors(
  snapshot: WorkSnapshot,
  budget: number,
  est: TokenEstimator,
  hasher: SyncHasher,
): AnchorExcerpt[] {
  const candidates = anchorCandidates(snapshot)
  if (candidates.length === 0) return [] // young work; local context is all we have

  const k = Math.min(MAX_EXCERPTS, candidates.length)
  const withTokens = candidates.map((section) => ({
    section,
    tokens: est.count(section.content ?? '', section.contentHash ?? undefined),
  }))
  let cursor = 0
  const positioned = withTokens.map((c) => {
    const start = cursor
    cursor += c.tokens
    return { ...c, mid: start + c.tokens / 2 }
  })
  const total = cursor
  const picked = new Set<string>()
  const winners: Array<(typeof positioned)[number]> = []
  for (let span = 0; span < k; span++) {
    const lo = (span * total) / k
    const hi = ((span + 1) * total) / k
    let best: (typeof positioned)[number] | null = null
    for (const c of positioned) {
      if (picked.has(c.section.id)) continue
      const inSpan = c.mid >= lo && (c.mid < hi || span === k - 1)
      if (!inSpan) continue
      if (best === null || c.tokens > best.tokens) best = c // tie-break: document order
    }
    if (best !== null) {
      picked.add(best.section.id)
      winners.push(best)
    }
  }

  const perExcerpt = Math.max(1, Math.floor(budget / k))
  return winners.map((w) => deriveExcerpt(w.section, perExcerpt, est, hasher))
}

/**
 * Per-excerpt staleness (06 §4.3, §10): at beginTask each excerpt's contentHash is
 * checked against the snapshot; on mismatch only that excerpt is re-derived — same
 * section, same size — and keeps its position in `<voice-anchors>`. Excerpts whose source
 * section vanished are dropped. Returns the excerpts plus which positions changed.
 */
export function reconcileAnchors(
  excerpts: AnchorExcerpt[],
  snapshot: WorkSnapshot,
  budget: number,
  est: TokenEstimator,
  hasher: SyncHasher,
): { excerpts: AnchorExcerpt[]; changed: boolean } {
  const k = Math.max(1, excerpts.length)
  const perExcerpt = Math.max(1, Math.floor(budget / Math.min(MAX_EXCERPTS, k)))
  let changed = false
  const next: AnchorExcerpt[] = []
  for (const excerpt of excerpts) {
    const section = snapshot.sectionById.get(excerpt.sectionId)
    if (section === undefined || section.content === null) {
      changed = true // source deleted: drop the excerpt
      continue
    }
    const current = section.content.slice(excerpt.start, excerpt.end)
    if (hasher.hash(current) === excerpt.contentHash) {
      next.push(excerpt)
      continue
    }
    next.push(deriveExcerpt(section, perExcerpt, est, hasher))
    changed = true
  }
  return { excerpts: next, changed }
}

/** Render one excerpt's text from the snapshot (assembly + hashing share this slice). */
export function excerptText(excerpt: AnchorExcerpt, snapshot: WorkSnapshot): string {
  const section = snapshot.sectionById.get(excerpt.sectionId)
  if (section === undefined || section.content === null) return ''
  return section.content.slice(excerpt.start, excerpt.end)
}
