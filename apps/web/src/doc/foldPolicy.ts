import type { SectionRow } from '@cowrite/shared'
import type { FoldLevel } from '../state/docUiStore.js'

/**
 * The pure fold-level policy (docs/04-frontend.md §5.3). Distance-based defaults + manual
 * override + graceful degradation when enrichment lags. This ladder is pure UI ergonomics —
 * the model's context map is computed independently by the engine (06).
 *
 * Degradation follows §5.3's letter exactly: a `long` with no long summary falls to
 * `short` when the short exists, else to `full`; a `short` with no short summary falls
 * to `name` (the NameCard renders from the title alone — untitled sections show
 * "Chapter N"). `name` never degrades: it needs no summary text to render.
 */

/** Distance thresholds, exported as one constants object so profiling can tune them. */
export const FOLD_DEFAULTS = { full: 2, long: 4, short: 8 } as const

/**
 * Distance → default fold level. `d` = number of leaf sections between this leaf and the
 * frontier (the last leaf has d = 0). The 2 most recent chapters render prose, the next 4
 * long summaries, the next 8 short summaries, the deep past name-only cards.
 */
export function defaultFold(d: number): FoldLevel {
  if (d <= FOLD_DEFAULTS.full - 1) return 'full'
  if (d <= FOLD_DEFAULTS.full + FOLD_DEFAULTS.long - 1) return 'long'
  if (d <= FOLD_DEFAULTS.full + FOLD_DEFAULTS.long + FOLD_DEFAULTS.short - 1) return 'short'
  return 'name'
}

/** The summary fields degradation consults — a structural subset of SectionRow. */
export type FoldableSection = Pick<SectionRow, 'id' | 'shortSummary' | 'longSummary'>

/**
 * Merge the pinned override (panelStore.foldOverrides) over the distance default, then apply
 * graceful degradation so a missing summary never renders as an empty body (04 §5.3).
 */
export function effectiveFold(
  s: FoldableSection,
  d: number,
  overrides: Record<string, FoldLevel | 'auto'>,
): FoldLevel {
  const ov = overrides[s.id]
  const base = ov !== undefined && ov !== 'auto' ? ov : defaultFold(d)
  // graceful degradation when enrichment lags (04 §5.3, verbatim): long falls toward
  // short/full; short falls to name (a NameCard needs no summary — title alone renders);
  // name stands on its own.
  if (base === 'long' && !s.longSummary) return s.shortSummary ? 'short' : 'full'
  if (base === 'short' && !s.shortSummary) return 'name'
  return base
}
