import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { FoldLevel } from './docUiStore.js'

/**
 * Persisted per-work UI preferences (docs/04-frontend.md §4.4): pane visibility/widths and
 * fold pins. One store, keyed by work id, persisted under `cowrite:ui`. The persisted
 * SHAPE carries every §4.4 slot (widths, edit-task pane, fold pins) so saved prefs
 * survive upgrades; the fold-pin actions (setFold + the §4.1 stale-key GC prune) are live
 * with the Stage-4 ladder UI — the remaining setters (resizer, edit-task pane) return
 * with the surfaces that need them.
 */

export interface PanelPrefs {
  situationOpen: boolean
  situationWidth: number
  editTaskOpen: boolean // pane ships M2; the slot persists now
  editTaskWidth: number
  foldOverrides: Record<string, FoldLevel | 'auto'>
}

export const DEFAULT_PANEL_PREFS: PanelPrefs = {
  situationOpen: false,
  situationWidth: 320,
  editTaskOpen: false,
  editTaskWidth: 360,
  foldOverrides: {},
}

interface PanelState {
  byWork: Record<string, PanelPrefs>
  setSituationOpen(workId: string, open: boolean): void
  /** Pin a section's fold level; `'auto'` clears the pin back to the distance default. */
  setFold(workId: string, sectionId: string, level: FoldLevel | 'auto'): void
  /**
   * §4.1 stale-key GC: drop every pin whose section id no longer resolves — run
   * after the refetch `sections.restructured` (the one restructure refetch owner)
   * triggers, and directly on `consolidation.applied`/`undone` attach frames.
   */
  pruneFoldOverrides(workId: string, liveSectionIds: ReadonlySet<string>): void
}

export const usePanelStore = create<PanelState>()(
  persist(
    (set) => ({
      byWork: {},

      setSituationOpen: (workId, open) =>
        set((state) => ({
          byWork: {
            ...state.byWork,
            [workId]: {
              ...(state.byWork[workId] ?? DEFAULT_PANEL_PREFS),
              situationOpen: open,
            },
          },
        })),

      setFold: (workId, sectionId, level) =>
        set((state) => {
          const prefs = state.byWork[workId] ?? DEFAULT_PANEL_PREFS
          const foldOverrides = { ...prefs.foldOverrides }
          // 'auto' is the reset — store no key at all, so the record only ever holds pins
          if (level === 'auto') delete foldOverrides[sectionId]
          else foldOverrides[sectionId] = level
          return { byWork: { ...state.byWork, [workId]: { ...prefs, foldOverrides } } }
        }),

      pruneFoldOverrides: (workId, liveSectionIds) =>
        set((state) => {
          const prefs = state.byWork[workId]
          if (!prefs) return state
          const stale = Object.keys(prefs.foldOverrides).filter((id) => !liveSectionIds.has(id))
          if (stale.length === 0) return state
          const foldOverrides = { ...prefs.foldOverrides }
          for (const id of stale) delete foldOverrides[id]
          return { byWork: { ...state.byWork, [workId]: { ...prefs, foldOverrides } } }
        }),
    }),
    { name: 'cowrite:ui' },
  ),
)
