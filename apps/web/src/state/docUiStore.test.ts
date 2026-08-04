import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearCrashCopy, gcCrashCopies, readCrashCopy, useDocUiStore } from './docUiStore.js'

vi.mock('../api/editingSignal.js', () => ({ signalEditing: vi.fn() }))

import { signalEditing } from '../api/editingSignal.js'

const W = '01ARZ3NDEKTSV4RRFFQ69G5FA0'
const A = '01ARZ3NDEKTSV4RRFFQ69G5FA1'
const B = '01ARZ3NDEKTSV4RRFFQ69G5FA2'

beforeEach(() => {
  useDocUiStore.setState({ selection: null, editing: null, peekRevision: null, followBottom: true })
  localStorage.clear()
  vi.mocked(signalEditing).mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('docUiStore', () => {
  it('select sets the selection and clears any revision peek', () => {
    useDocUiStore.setState({ peekRevision: { snippetId: A, rev: 1 } })
    useDocUiStore.getState().select({ kind: 'snippet', id: A })
    expect(useDocUiStore.getState().selection).toEqual({ kind: 'snippet', id: A })
    expect(useDocUiStore.getState().peekRevision).toBeNull()
  })

  it('beginEdit clears selection/peek, stores the draft, and fires the editing signal', () => {
    useDocUiStore.getState().select({ kind: 'snippet', id: B })
    useDocUiStore.getState().beginEdit(W, { kind: 'snippet', id: A }, 'initial', { baseRev: 3 })

    const state = useDocUiStore.getState()
    expect(state.selection).toBeNull()
    expect(state.editing).toMatchObject({ kind: 'snippet', id: A, draft: 'initial', baseRev: 3 })
    expect(signalEditing).toHaveBeenCalledWith(W, A)
  })

  it('section edits never fire the snippet editing signal', () => {
    useDocUiStore
      .getState()
      .beginEdit(W, { kind: 'section', id: A }, 'prose', { baseHash: 'xxh64:0123456789abcdef' })
    expect(signalEditing).not.toHaveBeenCalled()
  })

  it('updateDraft mirrors a throttled crash copy to localStorage', () => {
    vi.useFakeTimers()
    useDocUiStore.getState().beginEdit(W, { kind: 'snippet', id: A }, '')

    useDocUiStore.getState().updateDraft(W, A, 'first')
    // leading write goes straight through
    expect(readCrashCopy(W, A)).toBe('first')

    useDocUiStore.getState().updateDraft(W, A, 'second')
    useDocUiStore.getState().updateDraft(W, A, 'third')
    expect(readCrashCopy(W, A)).toBe('first') // still throttled
    // the store draft is never throttled — it tracks every keystroke
    expect(useDocUiStore.getState().editing?.draft).toBe('third')

    vi.advanceTimersByTime(500)
    expect(readCrashCopy(W, A)).toBe('third') // trailing write wins
  })

  it('updateDraft mirrors blocks WITHOUT a store session too (compose editor)', () => {
    vi.useFakeTimers()
    // no beginEdit: the frontier compose editor has no editing session
    useDocUiStore.getState().updateDraft(W, 'new', 'composed text')
    expect(useDocUiStore.getState().editing).toBeNull()
    vi.advanceTimersByTime(500)
    expect(readCrashCopy(W, 'new')).toBe('composed text')

    // clearing the copy also cancels a pending trailing mirror for that block
    useDocUiStore.getState().updateDraft(W, 'new', 'leading write')
    useDocUiStore.getState().updateDraft(W, 'new', 'trailing, queued')
    clearCrashCopy(W, 'new')
    vi.advanceTimersByTime(500)
    expect(readCrashCopy(W, 'new')).toBeNull()
  })

  it('endEdit clears the crash copy and signals editor-closed', () => {
    useDocUiStore.getState().beginEdit(W, { kind: 'snippet', id: A }, 'x')
    useDocUiStore.getState().updateDraft(W, A, 'draft text')
    expect(readCrashCopy(W, A)).toBe('draft text')

    useDocUiStore.getState().endEdit()
    expect(useDocUiStore.getState().editing).toBeNull()
    expect(readCrashCopy(W, A)).toBeNull()
    expect(signalEditing).toHaveBeenLastCalledWith(W, null)
  })

  it('clearRefsFor drops only refs pointing at the given id', () => {
    useDocUiStore.setState({
      selection: { kind: 'snippet', id: A },
      peekRevision: { snippetId: B, rev: 2 },
    })
    useDocUiStore.getState().clearRefsFor(A)
    expect(useDocUiStore.getState().selection).toBeNull()
    expect(useDocUiStore.getState().peekRevision).toEqual({ snippetId: B, rev: 2 })
  })

  it('clearRefsFor on the edited snippet clears the editing signal AND the crash copy', () => {
    // Regression: snippet.deleted while its editor was open used to drop the editing
    // state directly — leaving the server-side signal set and a crash copy offering to
    // "restore" a draft of a snippet that no longer exists.
    useDocUiStore.getState().beginEdit(W, { kind: 'snippet', id: A }, 'x')
    useDocUiStore.getState().updateDraft(W, A, 'doomed draft')
    expect(readCrashCopy(W, A)).toBe('doomed draft')
    vi.mocked(signalEditing).mockClear()

    useDocUiStore.getState().clearRefsFor(A)

    expect(useDocUiStore.getState().editing).toBeNull()
    expect(readCrashCopy(W, A)).toBeNull()
    expect(signalEditing).toHaveBeenCalledWith(W, null)
  })

  describe('gcCrashCopies (§4.1 stale-key GC)', () => {
    it('drops drafts whose block no longer resolves and returns their texts', () => {
      localStorage.setItem(`cowrite:draft:${W}:${A}`, 'live draft')
      localStorage.setItem(`cowrite:draft:${W}:${B}`, 'orphan draft')

      const dropped = gcCrashCopies(W, new Set([A]))

      expect(dropped).toEqual([{ blockId: B, text: 'orphan draft' }])
      expect(readCrashCopy(W, A)).toBe('live draft')
      expect(readCrashCopy(W, B)).toBeNull()
    })

    it("never collects the compose editor's 'new' draft or the open editor's draft", () => {
      localStorage.setItem(`cowrite:draft:${W}:new`, 'composing')
      localStorage.setItem(`cowrite:draft:${W}:${A}`, 'editing now')
      useDocUiStore.setState({
        editing: { kind: 'snippet', id: A, workId: W, draft: 'editing now' },
      })

      expect(gcCrashCopies(W, new Set())).toEqual([])
      expect(readCrashCopy(W, 'new')).toBe('composing')
      expect(readCrashCopy(W, A)).toBe('editing now')
    })

    it('leaves other works untouched', () => {
      const W2 = '01ARZ3NDEKTSV4RRFFQ69G5FA9'
      localStorage.setItem(`cowrite:draft:${W2}:${B}`, 'other work')
      expect(gcCrashCopies(W, new Set())).toEqual([])
      expect(readCrashCopy(W2, B)).toBe('other work')
    })
  })
})
