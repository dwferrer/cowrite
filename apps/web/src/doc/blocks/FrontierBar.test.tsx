import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type InteractiveTask, useTaskStore } from '../../state/taskStore.js'
import { testids } from '../../testids.js'
import { useToastStore } from '../../ui/Toast.js'
import { dispatchContinue, FrontierBar } from './FrontierBar.js'

/**
 * Frontier task controls (docs/04-frontend.md §8.1): Continue and Instruct… launch tasks
 * (global Ctrl-Enter rides the same path via `cowrite:continue`), disable while the
 * interactive slot is occupied, and a 409 config_missing produces the settings-linking
 * callout — never a bare error toast.
 */

const W = '01ARZ3NDEKTSV4RRFFQ69G5FA0'
const T1 = '01ARZ3NDEKTSV4RRFFQ69G5FB1'

function interactive(): InteractiveTask {
  return {
    taskId: T1,
    runId: T1,
    kind: 'continue',
    stage: 'writing',
    target: { kind: 'frontier' },
    instruction: null,
    buffers: new Map(),
    toolNotes: [],
    startedAt: Date.now(),
    retrying: null,
    usage: null,
    conflictArtifact: null,
  }
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

function renderBar(props: Partial<Parameters<typeof FrontierBar>[0]> = {}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/w/${W}`]}>
        <FrontierBar workId={W} {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  useTaskStore.getState().reset()
  useToastStore.setState({ toasts: [] })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('FrontierBar task controls', () => {
  it('Continue launches a continue task', async () => {
    const fetchMock = stubFetch()
    renderBar()
    fireEvent.click(screen.getByTestId(testids.frontierContinue))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(String(url)).toBe(`/api/works/${W}/tasks`)
    expect(JSON.parse(String(init.body))).toEqual({ kind: 'continue' })
  })

  it('the global continue event (Ctrl-Enter) rides the same launch path', async () => {
    const fetchMock = stubFetch()
    renderBar()
    dispatchContinue()
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
  })

  it('Instruct… expands to a textarea; Ctrl-Enter launches instructed-continue', async () => {
    const fetchMock = stubFetch()
    renderBar()
    fireEvent.click(screen.getByTestId(testids.frontierInstruct))
    const input = screen.getByTestId(testids.frontierInstructInput)
    fireEvent.change(input, { target: { value: 'make the storm arrive early' } })
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({
      kind: 'instructed-continue',
      instruction: 'make the storm arrive early',
    })
  })

  it('task buttons disable while the interactive slot is occupied; ＋ snippet stays enabled', () => {
    useTaskStore.setState({ interactive: interactive() })
    renderBar()
    expect(screen.getByTestId(testids.frontierContinue)).toHaveProperty('disabled', true)
    expect(screen.getByTestId(testids.frontierInstruct)).toHaveProperty('disabled', true)
    expect(screen.getByTestId(testids.frontierNewSnippet)).toHaveProperty('disabled', false)
  })

  it('the continue event is ignored while the slot is occupied', () => {
    const fetchMock = stubFetch()
    useTaskStore.setState({ interactive: interactive() })
    renderBar()
    dispatchContinue()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('409 config_missing → blocking callout linking /settings, not a bare toast', async () => {
    stubFetch(409, { error: { code: 'config_missing', message: 'no models configured' } })
    renderBar()
    fireEvent.click(screen.getByTestId(testids.frontierContinue))

    await waitFor(() => {
      const toasts = useToastStore.getState().toasts
      expect(toasts).toHaveLength(1)
      expect(toasts[0]?.message).toContain('Settings')
      expect(toasts[0]?.action?.label).toBe('Open Settings')
    })
  })

  it('409 busy surfaces the already-writing message', async () => {
    stubFetch(409, { error: { code: 'busy', message: 'interactive lane occupied' } })
    renderBar()
    fireEvent.click(screen.getByTestId(testids.frontierContinue))
    await waitFor(() => {
      expect(useToastStore.getState().toasts[0]?.message).toContain('already writing')
    })
  })
})
