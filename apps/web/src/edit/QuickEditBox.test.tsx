import type { SnippetDto } from '@cowrite/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { qk } from '../api/queries.js'
import { SnippetBlock } from '../doc/blocks/SnippetBlock.js'
import { useDocUiStore } from '../state/docUiStore.js'
import { type InteractiveTask, useTaskStore } from '../state/taskStore.js'
import { testids } from '../testids.js'
import { useToastStore } from '../ui/Toast.js'
import { QuickEditBox } from './QuickEditBox.js'

/**
 * Quick-edit flow (docs/04-frontend.md §7.2, §8.3, §8.4): the instruction box launches a
 * quick-edit task targeting exactly this snippet; while it runs the target shows the
 * "being rewritten" shimmer (no mid-document token streaming); a conflict surfaces the
 * apply-anyway/discard card wired to the proposal routes.
 */

const W = '01ARZ3NDEKTSV4RRFFQ69G5FA0'
const SID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const T1 = '01ARZ3NDEKTSV4RRFFQ69G5FB1'

const snippet: SnippetDto = {
  id: SID,
  orderKey: 'a1',
  text: 'Original passage.',
  rev: 2,
  authorship: 'agent',
  originRunId: null,
  updatedAt: '2026-08-01T12:00:00.000Z',
  revisionCount: 2,
}

function interactiveOn(target: { kind: 'snippet'; id: string }): InteractiveTask {
  return {
    taskId: T1,
    runId: T1,
    kind: 'quick-edit',
    stage: 'writing',
    target,
    instruction: 'tighten it',
    buffers: new Map(),
    toolNotes: [],
    startedAt: Date.now(),
    retrying: null,
    usage: null,
    conflictArtifact: null,
  }
}

function makeClient(): QueryClient {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  })
  qc.setQueryData(qk.snippets(W), [snippet])
  qc.setQueryData(qk.revisions(W, SID), [])
  return qc
}

function wrap(ui: React.ReactNode, qc = makeClient()) {
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/w/${W}`]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  )
}

function stubFetch(status = 202, body: unknown = queuedTask()) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
  }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function queuedTask() {
  return {
    id: T1,
    workId: W,
    spec: { kind: 'continue' },
    lane: 'interactive',
    status: 'queued',
    queuedAt: '2026-08-02T00:00:00.000Z',
    startedAt: null,
    endedAt: null,
    error: null,
  }
}

beforeEach(() => {
  useTaskStore.getState().reset()
  useToastStore.setState({ toasts: [] })
  useDocUiStore.setState({ selection: null, editing: null, peekRevision: null, followBottom: true })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('QuickEditBox', () => {
  it('submits a quick-edit task targeting exactly this snippet', async () => {
    const fetchMock = stubFetch()
    wrap(<QuickEditBox workId={W} snippet={snippet} />)

    fireEvent.change(screen.getByTestId(testids.quickEditInput), {
      target: { value: 'make it rain' },
    })
    fireEvent.click(screen.getByTestId(testids.quickEditSubmit))

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(String(url)).toBe(`/api/works/${W}/tasks`)
    const body = JSON.parse(String(init.body))
    expect(body).toEqual({
      kind: 'quick-edit',
      instruction: 'make it rain',
      target: { type: 'snippet', snippetId: SID, baseRev: 2 },
      selection: { text: snippet.text, start: 0, end: snippet.text.length },
    })
  })

  it('Ctrl-Enter in the input launches too', async () => {
    const fetchMock = stubFetch()
    wrap(<QuickEditBox workId={W} snippet={snippet} />)
    const input = screen.getByTestId(testids.quickEditInput)
    fireEvent.change(input, { target: { value: 'shorter' } })
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
  })

  it('disables while the interactive slot is occupied', () => {
    useTaskStore.setState({ interactive: interactiveOn({ kind: 'snippet', id: SID }) })
    wrap(<QuickEditBox workId={W} snippet={snippet} />)
    expect(screen.getByTestId(testids.quickEditInput)).toHaveProperty('disabled', true)
  })

  it('a config_missing 409 toasts with a settings link, never a bare error', async () => {
    stubFetch(409, {
      error: { code: 'config_missing', message: 'no models configured' },
    })
    wrap(<QuickEditBox workId={W} snippet={snippet} />)
    fireEvent.change(screen.getByTestId(testids.quickEditInput), {
      target: { value: 'anything' },
    })
    fireEvent.click(screen.getByTestId(testids.quickEditSubmit))

    await waitFor(() => {
      const toasts = useToastStore.getState().toasts
      expect(toasts).toHaveLength(1)
      expect(toasts[0]?.action?.label).toBe('Open Settings')
    })
  })
})

describe('SnippetBlock shimmer + conflict flow', () => {
  it('shows the being-rewritten shimmer while a quick-edit targets the snippet', () => {
    useTaskStore.setState({ interactive: interactiveOn({ kind: 'snippet', id: SID }) })
    useDocUiStore.setState({ selection: { kind: 'snippet', id: SID } })
    wrap(<SnippetBlock workId={W} snippet={snippet} matcher={null} />)

    const shimmer = screen.getByTestId(testids.snippetRewriting)
    expect(shimmer.textContent).toContain('being rewritten')
    expect(shimmer.textContent).toContain('writing')
    // no mid-document token streaming, and no second quick-edit while one runs
    expect(screen.queryByTestId(testids.streamingText)).toBeNull()
    expect(screen.queryByTestId(testids.quickEditBox)).toBeNull()
  })

  it('no shimmer when the interactive task targets something else', () => {
    useTaskStore.setState({
      interactive: interactiveOn({ kind: 'snippet', id: '01ARZ3NDEKTSV4RRFFQ69G5FB9' }),
    })
    wrap(<SnippetBlock workId={W} snippet={snippet} matcher={null} />)
    expect(screen.queryByTestId(testids.snippetRewriting)).toBeNull()
  })

  it('a conflict proposal renders apply-anyway/discard wired to the proposal routes', async () => {
    const fetchMock = stubFetch(200, {})
    useTaskStore.setState({
      proposal: {
        taskId: T1,
        kind: 'quick-edit',
        target: { kind: 'snippet', id: SID },
        text: 'the rewritten passage',
        reason: 'conflict',
        message: null,
        retryable: false,
      },
    })
    wrap(<SnippetBlock workId={W} snippet={snippet} matcher={null} />)

    const card = screen.getByTestId(testids.keepPartial)
    expect(card.textContent).toContain('Text changed while editing')
    expect(card.textContent).toContain('the rewritten passage')

    fireEvent.click(screen.getByTestId(testids.keepPartialApply))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`/api/works/${W}/tasks/${T1}/proposal/apply`)
    await waitFor(() => expect(useTaskStore.getState().proposal).toBeNull())
  })

  it('discard hits the discard route and clears the offer', async () => {
    const fetchMock = stubFetch(204, undefined)
    useTaskStore.setState({
      proposal: {
        taskId: T1,
        kind: 'quick-edit',
        target: { kind: 'snippet', id: SID },
        text: 'the rewritten passage',
        reason: 'conflict',
        message: null,
        retryable: false,
      },
    })
    wrap(<SnippetBlock workId={W} snippet={snippet} matcher={null} />)

    fireEvent.click(screen.getByTestId(testids.keepPartialDiscard))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `/api/works/${W}/tasks/${T1}/proposal/discard`,
    )
    await waitFor(() => expect(useTaskStore.getState().proposal).toBeNull())
  })
})
