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
})
