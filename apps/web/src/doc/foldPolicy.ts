import type { SectionRow } from '@cowrite/shared'
import type { FoldLevel } from '../state/docUiStore.js'

/**
 * The pure fold-level policy (docs/04-frontend.md §5.3). Distance-based defaults + manual
 * override + graceful degradation when enrichment lags. This ladder is pure UI ergonomics —
 * the model's context map is computed independently by the engine (06).
 *
 * Degradation rule: never render an empty body. A level whose summary text is missing falls
 * toward the nearest level that has something to show, bottoming out at `full` (real prose is
 * always available). Until summaries exist (they are produced by consolidation/enrichment,
 * Stage 4) every section therefore resolves to `full`.
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
  // graceful degradation when enrichment lags: fall toward whatever text exists, ending at
  // `full` — with no summaries at all (pre-Stage 4) everything resolves to `full`.
  if (base === 'name' && !s.shortSummary) return s.longSummary ? 'long' : 'full'
  if (base === 'short' && !s.shortSummary) return s.longSummary ? 'long' : 'full'
  if (base === 'long' && !s.longSummary) return s.shortSummary ? 'short' : 'full'
  return base
}
