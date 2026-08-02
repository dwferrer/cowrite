import type { SnippetDto } from '@cowrite/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { qk, useSnippets } from '../api/queries.js'
import { SnippetBlock } from '../doc/blocks/SnippetBlock.js'
import { readCrashCopy, useDocUiStore } from '../state/docUiStore.js'
import { testids } from '../testids.js'

/**
 * Editor key handling, the editing signal, and the 409 conflict flow (04 §7.1) — driven
 * through SnippetBlock so the docUiStore beginEdit/endEdit signal wiring is exercised for
 * real (the signal POSTs ride the stubbed fetch).
 */

const W = 'W1'
const SID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

const snippet: SnippetDto = {
  id: SID,
  orderKey: 'a1',
  text: 'Original text.',
  rev: 1,
  authorship: 'user',
  originRunId: null,
  updatedAt: '2026-08-01T12:00:00.000Z',
  revisionCount: 1,
}

type FetchCall = { url: string; init?: RequestInit }

function setupFetch(
  patchResponses: Array<{ status: number; body: unknown }>,
  snippetsList: () => SnippetDto[],
) {
  const calls: FetchCall[] = []
  let patchIndex = 0
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, ...(init ? { init } : {}) })
    if (url.endsWith('/editing')) {
      return { ok: true, status: 204, json: () => Promise.resolve({}) }
    }
    if (init?.method === 'PATCH') {
      const res = patchResponses[Math.min(patchIndex, patchResponses.length - 1)]
      patchIndex += 1
      if (!res) throw new Error('no patch response scripted')
      return {
        ok: res.status < 400,
        status: res.status,
        json: () => Promise.resolve(res.body),
      }
    }
    // GET snippets refetch after conflict rollback
    return { ok: true, status: 200, json: () => Promise.resolve(snippetsList()) }
  })
  vi.stubGlobal('fetch', fetchMock)
  return { fetchMock, calls }
}

/** Keeps the snippets query active so conflict-rollback invalidation actually refetches. */
function SnippetsObserver() {
  useSnippets(W)
  return null
}

function renderBlock() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  })
  qc.setQueryData(qk.snippets(W), [snippet])
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/w/${W}`]}>
        <SnippetsObserver />
        <SnippetBlock workId={W} snippet={snippet} matcher={null} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return qc
}

const editingCalls = (calls: FetchCall[]) =>
  calls
    .filter((c) => c.url.endsWith('/editing'))
    .map((c) => JSON.parse(String(c.init?.body)) as { snippetId: string | null })

beforeEach(() => {
  useDocUiStore.setState({ selection: null, editing: null, peekRevision: null, followBottom: true })
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('SnippetEditor via SnippetBlock', () => {
  it('double-click opens the editor and fires the editing signal', async () => {
    const { calls } = setupFetch([], () => [snippet])
    renderBlock()
    fireEvent.doubleClick(screen.getByTestId(testids.snippetBlock))
    expect(await screen.findByTestId(testids.snippetEditor)).toBeDefined()
    await waitFor(() => {
      expect(editingCalls(calls)).toEqual([{ snippetId: SID }])
    })
    // opening the editor cleared any selection
    expect(useDocUiStore.getState().selection).toBeNull()
  })

  it('Enter does not save; Ctrl-Enter saves once with baseRev and closes + signals null', async () => {
    const saved: SnippetDto = { ...snippet, text: 'Edited.', rev: 2, revisionCount: 2 }
    const { calls, fetchMock } = setupFetch([{ status: 200, body: saved }], () => [saved])
    renderBlock()
    fireEvent.doubleClick(screen.getByTestId(testids.snippetBlock))
    const textarea = (await screen.findByTestId(testids.snippetEditor)).querySelector(
      'textarea',
    ) as HTMLTextAreaElement

    fireEvent.change(textarea, { target: { value: 'Edited.' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit)?.method === 'PATCH')).toBe(false)

    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true })
    await waitFor(() => {
      expect(screen.queryByTestId(testids.snippetEditor)).toBeNull()
    })
    const patches = calls.filter((c) => c.init?.method === 'PATCH')
    expect(patches).toHaveLength(1)
    expect(JSON.parse(String(patches[0]?.init?.body))).toEqual({ text: 'Edited.', baseRev: 1 })
    await waitFor(() => {
      expect(editingCalls(calls)).toEqual([{ snippetId: SID }, { snippetId: null }])
    })
  })

  it('409 keeps the editor open with the draft and "Keep mine" retries against the fresh rev', async () => {
    const theirs: SnippetDto = { ...snippet, text: 'Their text.', rev: 2, revisionCount: 2 }
    const mine: SnippetDto = { ...theirs, text: 'My edit.', rev: 3, revisionCount: 3 }
    const { calls } = setupFetch(
      [
        { status: 409, body: { error: { code: 'conflict', message: 'stale baseRev' } } },
        { status: 200, body: mine },
      ],
      () => [theirs],
    )
    const qc = renderBlock()
    fireEvent.doubleClick(screen.getByTestId(testids.snippetBlock))
    const textarea = (await screen.findByTestId(testids.snippetEditor)).querySelector(
      'textarea',
    ) as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'My edit.' } })
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true })

    // conflict banner appears; the editor stays open and the draft is intact
    expect(await screen.findByTestId(testids.snippetConflict)).toBeDefined()
    expect(screen.getByTestId(testids.snippetEditor)).toBeDefined()
    expect((screen.getByLabelText('Edit text') as HTMLTextAreaElement).value).toBe('My edit.')

    // wait for the rollback-triggered refetch to land the fresh rev in the cache
    await waitFor(() => {
      const list = qc.getQueryData<SnippetDto[]>(qk.snippets(W))
      expect(list?.[0]?.rev).toBe(2)
    })

    fireEvent.click(screen.getByTestId(testids.snippetConflictMine))
    await waitFor(() => {
      expect(screen.queryByTestId(testids.snippetEditor)).toBeNull()
    })
    const patches = calls.filter((c) => c.init?.method === 'PATCH')
    expect(patches).toHaveLength(2)
    expect(JSON.parse(String(patches[1]?.init?.body))).toEqual({ text: 'My edit.', baseRev: 2 })
  })

  it('Esc on a dirty draft asks to discard; discarding closes and signals null', async () => {
    const { calls } = setupFetch([], () => [snippet])
    renderBlock()
    fireEvent.doubleClick(screen.getByTestId(testids.snippetBlock))
    const textarea = (await screen.findByTestId(testids.snippetEditor)).querySelector(
      'textarea',
    ) as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'Changed.' } })
    fireEvent.keyDown(textarea, { key: 'Escape' })

    const confirm = await screen.findByTestId(testids.editorDiscardConfirm)
    expect(confirm.textContent).toContain('Discard changes?')
    fireEvent.click(screen.getByText('Discard'))
    await waitFor(() => {
      expect(screen.queryByTestId(testids.snippetEditor)).toBeNull()
    })
    await waitFor(() => {
      expect(editingCalls(calls)).toEqual([{ snippetId: SID }, { snippetId: null }])
    })
  })

  it('Esc on a clean draft closes immediately', async () => {
    setupFetch([], () => [snippet])
    renderBlock()
    fireEvent.doubleClick(screen.getByTestId(testids.snippetBlock))
    const textarea = (await screen.findByTestId(testids.snippetEditor)).querySelector(
      'textarea',
    ) as HTMLTextAreaElement
    fireEvent.keyDown(textarea, { key: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByTestId(testids.snippetEditor)).toBeNull()
    })
  })

  it('continuous typing keeps the crash copy fresh within the throttle window', () => {
    // Regression (C3): the editor used to run its own trailing 500 ms debounce, so a
    // user who never paused typing never got a crash copy at all. Routing through
    // docUiStore.updateDraft (leading throttle) mirrors the first keystroke at once
    // and refreshes at least every 500 ms while typing continues.
    vi.useFakeTimers()
    try {
      setupFetch([], () => [snippet])
      renderBlock()
      fireEvent.doubleClick(screen.getByTestId(testids.snippetBlock))
      const textarea = screen
        .getByTestId(testids.snippetEditor)
        .querySelector('textarea') as HTMLTextAreaElement

      fireEvent.change(textarea, { target: { value: 'First keystroke.' } })
      expect(readCrashCopy(W, SID)).toBe('First keystroke.') // leading write, no pause needed

      fireEvent.change(textarea, { target: { value: 'First keystroke. More' } })
      fireEvent.change(textarea, { target: { value: 'First keystroke. More typing' } })
      vi.advanceTimersByTime(500) // typing never pauses — the trailing write still lands
      expect(readCrashCopy(W, SID)).toBe('First keystroke. More typing')

      // and the store draft tracked every keystroke un-throttled
      expect(useDocUiStore.getState().editing?.draft).toBe('First keystroke. More typing')
    } finally {
      vi.useRealTimers()
    }
  })
})
