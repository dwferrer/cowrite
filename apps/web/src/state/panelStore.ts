import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { FoldLevel } from './docUiStore.js'

/**
 * Persisted per-work UI preferences (docs/04-frontend.md §4.4): pane visibility/widths and
 * fold pins. One store, keyed by work id, persisted under `cowrite:ui`. The persisted
 * SHAPE carries every §4.4 slot (widths, edit-task pane, fold pins) so saved prefs
 * survive upgrades, but Stage 2 only mutates `situationOpen` — the other setters return
 * with the UI surfaces that need them (resizer, edit-task pane, fold pin menu).
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
    }),
    { name: 'cowrite:ui' },
  ),
)
