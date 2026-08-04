import type { BudgetKnobs, Fidelity } from '@cowrite/shared'
import type { TokenEstimator } from './estimate.js'
import type { SnapshotSection, WorkSnapshot } from './snapshot.js'

/**
 * The default context map (docs/06-context-engine.md §4): a pure function of
 * (snapshot, knobs) obeying the total-coverage invariant — every section at ≥ `name`
 * fidelity, every un-consolidated snippet at full text (snippets are handled by
 * assembly; this module decides section and world fidelities).
 */

export interface DefaultMap {
  /** Every section's default fidelity — the coverage invariant guarantees a row per id. */
  sections: Map<string, Fidelity>
  /** Rule-2 members: un-enriched frozen leaves included at `full`, demotion-exempt. */
  rule2Full: Set<string>
  /** Every world entry's default fidelity (`short`, or `name` after budget demotion). */
  world: Map<string, 'name' | 'short'>
  /** The resolved chapter level (deepest enriched level along the frontier path); null
   *  when nothing is enriched anywhere (rules 3–5 have no members — 06 §4.1). */
  chapterLevel: string | null
}

/** The best renderable fidelity ≤ `wanted` for a section (06 §4.2: summaries render only
 *  when their files exist; `full` needs leaf prose). Never below `name`. */
export function renderableFidelity(section: SnapshotSection, wanted: Fidelity): Fidelity {
  let level = wanted
  if (level === 'full' && !section.leaf) level = 'long'
  if (level === 'long' && section.longSummary === null) level = 'short'
  if (level === 'short' && section.shortSummary === null) level = 'name'
  return level
}

/** Token cost of a section at a fidelity (content only; tag overhead is assembly's). */
export function sectionFidelityTokens(
  section: SnapshotSection,
  fidelity: Fidelity,
  est: TokenEstimator,
): number {
  switch (fidelity) {
    case 'name':
      // one line: path-qualified title + id — ~10 tokens, estimated from the real strings
      return est.count(`${section.path} ${section.name} ${section.id}`)
    case 'short':
      return section.shortSummary === null ? 0 : est.count(section.shortSummary)
    case 'long':
      return section.longSummary === null ? 0 : est.count(section.longSummary)
    case 'full':
      return section.content === null
        ? 0
        : est.count(section.content, section.contentHash ?? undefined)
  }
}

/** Token cost of a world entry at a fidelity. */
export function worldFidelityTokens(
  entry: { name: string; shortSummary: string | null; body: string; bodyHash: string },
  fidelity: 'name' | 'short' | 'full',
  est: TokenEstimator,
): number {
  switch (fidelity) {
    case 'name':
      return est.count(entry.name)
    case 'short':
      return (
        est.count(entry.name) + (entry.shortSummary === null ? 0 : est.count(entry.shortSummary))
      )
    case 'full':
      return est.count(entry.name) + est.count(entry.body, entry.bodyHash)
  }
}

/**
 * "Chapter-level" (06 §4.1): the deepest level in the work's levelScheme for which
 * enriched sections exist along the frontier path — resolved here as "for which any
 * enriched (short-summarized) section of that kind exists", deepest first. With the
 * default flat ['chapter'] scheme it is simply 'chapter' once anything is enriched.
 */
function resolveChapterLevel(snapshot: WorkSnapshot): string | null {
  const scheme = snapshot.levelScheme
  for (let i = scheme.length - 1; i >= 0; i--) {
    const level = scheme[i]
    if (level === undefined) continue
    if (snapshot.sections.some((s) => s.kind === level && s.shortSummary !== null)) return level
  }
  return null
}

export function computeDefaultMap(
  snapshot: WorkSnapshot,
  knobs: BudgetKnobs,
  est: TokenEstimator,
): DefaultMap {
  const sections = new Map<string, Fidelity>()
  const rule2Full = new Set<string>()

  // Baseline: rule 5 — everything present at ≥ name; roots at short.
  for (const s of snapshot.sections) {
    sections.set(s.id, s.depth === 0 ? renderableFidelity(s, 'short') : 'name')
  }

  // Rule 2: frozen-but-unenriched leaves carry their own text (coverage beats budget).
  for (const s of snapshot.sections) {
    if (s.leaf && s.shortSummary === null && s.content !== null && s.content !== '') {
      sections.set(s.id, 'full')
      rule2Full.add(s.id)
    }
  }

  const chapterLevel = resolveChapterLevel(snapshot)
  const rule3 = new Set<string>()
  const rule4: string[] = [] // document order
  if (chapterLevel !== null) {
    // Rule-2 fulls already sit above `long`; the 2 adjacent-context slots go to the last
    // 2 chapter-level sections that would otherwise render as summaries.
    const chapters = snapshot.sections.filter(
      (s) => s.kind === chapterLevel && !rule2Full.has(s.id),
    )
    // Frontier-adjacent: the 2 chapter-level sections immediately before the frontier → long.
    const adjacent = chapters.slice(-2)
    for (const s of adjacent) {
      sections.set(s.id, renderableFidelity(s, 'long'))
      rule3.add(s.id)
    }
    // Rule 4: remaining earlier chapter-level siblings of the current part/arc → short.
    const frontierChapter = chapters[chapters.length - 1]
    if (frontierChapter !== undefined) {
      for (const s of chapters.slice(0, Math.max(0, chapters.length - 2))) {
        if (s.parentId !== frontierChapter.parentId) continue
        sections.set(s.id, renderableFidelity(s, 'short'))
        rule4.push(s.id)
      }
    }
  }

  // Skeleton demotion (06 §4.1): if rules 3–5 exceed skeletonSummaryBudget, demote
  // uniformly and deterministically — rule-4 short → name first (document-order earliest
  // first), then rule-3 long → short. Rule-2 fulls are exempt (coverage beats budget).
  // The running total is incremental — one full scan, then subtract/add per demotion —
  // so demotion stays O(n) in estimator calls, never a full re-scan per demoted section.
  const sectionById = new Map(snapshot.sections.map((s) => [s.id, s]))
  let skeletonTotal = 0
  for (const s of snapshot.sections) {
    if (rule2Full.has(s.id)) continue
    skeletonTotal += sectionFidelityTokens(s, sections.get(s.id) ?? 'name', est)
  }
  if (skeletonTotal > knobs.skeletonSummaryBudget) {
    for (const id of rule4) {
      const s = sectionById.get(id)
      if (s === undefined) continue
      const from = sections.get(id) ?? 'name'
      sections.set(id, 'name')
      skeletonTotal += sectionFidelityTokens(s, 'name', est) - sectionFidelityTokens(s, from, est)
      if (skeletonTotal <= knobs.skeletonSummaryBudget) break
    }
  }
  if (skeletonTotal > knobs.skeletonSummaryBudget) {
    const longs = snapshot.sections.filter((s) => rule3.has(s.id) && sections.get(s.id) === 'long')
    for (const s of longs) {
      const to = renderableFidelity(s, 'short')
      sections.set(s.id, to)
      skeletonTotal += sectionFidelityTokens(s, to, est) - sectionFidelityTokens(s, 'long', est)
      if (skeletonTotal <= knobs.skeletonSummaryBudget) break
    }
  }

  // World-info (06 §4.1 rule 6): every entry at short; if over worldInfoSummaryBudget,
  // demote to name largest-first by token count (tie-break: newest — larger ULID — first).
  const world = new Map<string, 'name' | 'short'>()
  for (const e of snapshot.worldEntries) {
    world.set(e.id, e.shortSummary === null ? 'name' : 'short')
  }
  let worldTotal = 0
  for (const e of snapshot.worldEntries) {
    worldTotal += worldFidelityTokens(e, world.get(e.id) ?? 'name', est)
  }
  if (worldTotal > knobs.worldInfoSummaryBudget) {
    const demotable = snapshot.worldEntries
      .filter((e) => world.get(e.id) === 'short')
      .map((e) => ({ entry: e, tokens: worldFidelityTokens(e, 'short', est) }))
      .sort((a, b) =>
        b.tokens !== a.tokens ? b.tokens - a.tokens : b.entry.id < a.entry.id ? -1 : 1,
      )
    // Incremental again: swap each demoted entry's short cost for its name cost.
    for (const candidate of demotable) {
      world.set(candidate.entry.id, 'name')
      worldTotal += worldFidelityTokens(candidate.entry, 'name', est) - candidate.tokens
      if (worldTotal <= knobs.worldInfoSummaryBudget) break
    }
  }

  return { sections, rule2Full, world, chapterLevel }
}
