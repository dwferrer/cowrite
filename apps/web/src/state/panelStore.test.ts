import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_PANEL_PREFS, usePanelStore } from './panelStore.js'

const W = '01ARZ3NDEKTSV4RRFFQ69G5FA0'

beforeEach(() => {
  localStorage.clear()
  usePanelStore.setState({ byWork: {} })
})

describe('panelStore', () => {
  it('setSituationOpen seeds the full persisted prefs shape from the defaults', () => {
    usePanelStore.getState().setSituationOpen(W, true)
    expect(usePanelStore.getState().byWork[W]).toEqual({
      ...DEFAULT_PANEL_PREFS,
      situationOpen: true,
    })
  })

  it('persists pane visibility per work under cowrite:ui', () => {
    usePanelStore.getState().setSituationOpen(W, true)
    expect(usePanelStore.getState().byWork[W]?.situationOpen).toBe(true)

    const raw = localStorage.getItem('cowrite:ui')
    expect(raw).toBeTruthy()
    expect(JSON.parse(raw as string).state.byWork[W].situationOpen).toBe(true)
  })

  it('keeps works independent', () => {
    const W2 = '01ARZ3NDEKTSV4RRFFQ69G5FA3'
    usePanelStore.getState().setSituationOpen(W, true)
    expect(usePanelStore.getState().byWork[W2]).toBeUndefined()
  })

  describe('fold pins (04 §5.3)', () => {
    const S1 = '01ARZ3NDEKTSV4RRFFQ69G5FB1'
    const S2 = '01ARZ3NDEKTSV4RRFFQ69G5FB2'

    it('setFold pins a level and seeds the prefs shape', () => {
      usePanelStore.getState().setFold(W, S1, 'full')
      expect(usePanelStore.getState().byWork[W]).toEqual({
        ...DEFAULT_PANEL_PREFS,
        foldOverrides: { [S1]: 'full' },
      })
    })

    it("setFold 'auto' removes the pin entirely (record holds only pins)", () => {
      usePanelStore.getState().setFold(W, S1, 'name')
      usePanelStore.getState().setFold(W, S1, 'auto')
      expect(usePanelStore.getState().byWork[W]?.foldOverrides).toEqual({})
    })

    it('pins persist under cowrite:ui', () => {
      usePanelStore.getState().setFold(W, S1, 'short')
      const raw = localStorage.getItem('cowrite:ui')
      expect(JSON.parse(raw as string).state.byWork[W].foldOverrides[S1]).toBe('short')
    })

    it('pruneFoldOverrides drops pins whose section no longer resolves (§4.1 GC)', () => {
      usePanelStore.getState().setFold(W, S1, 'full')
      usePanelStore.getState().setFold(W, S2, 'name')
      usePanelStore.getState().pruneFoldOverrides(W, new Set([S2]))
      expect(usePanelStore.getState().byWork[W]?.foldOverrides).toEqual({ [S2]: 'name' })
    })

    it('pruneFoldOverrides is a no-op for unknown works and live-only pins', () => {
      usePanelStore.getState().setFold(W, S1, 'long')
      const before = usePanelStore.getState().byWork
      usePanelStore.getState().pruneFoldOverrides('01ARZ3NDEKTSV4RRFFQ69G5FA9', new Set())
      usePanelStore.getState().pruneFoldOverrides(W, new Set([S1]))
      expect(usePanelStore.getState().byWork).toBe(before)
    })
  })
})
