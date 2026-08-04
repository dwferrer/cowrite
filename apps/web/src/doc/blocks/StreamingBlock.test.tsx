import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type InteractiveTask, useTaskStore } from '../../state/taskStore.js'
import { testids } from '../../testids.js'
import { useToastStore } from '../../ui/Toast.js'
import { StreamingBlock } from './StreamingBlock.js'

/**
 * StreamingBlock phases (docs/04-frontend.md §8.3): planning shows the tool-note activity
 * line (no fake prose), writing appends the buffered deltas plaintext-ish, retrying/usage
 * ride the status line, cancel hits the cancel route, and a frontier proposal renders the
 * keep-partial card in the block's place.
 */

const W = '01ARZ3NDEKTSV4RRFFQ69G5FA0'
const T1 = '01ARZ3NDEKTSV4RRFFQ69G5FB1'

function interactive(over: Partial<InteractiveTask> = {}): InteractiveTask {
  return {
    taskId: T1,
    runId: T1,
    kind: 'continue',
    stage: 'planning',
    target: { kind: 'frontier' },
    instruction: null,
    buffers: new Map(),
    toolNotes: [],
    startedAt: Date.now(),
    retrying: null,
    usage: null,
    conflictArtifact: null,
    ...over,
  }
}

function renderBlock() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={qc}>
      <StreamingBlock workId={W} />
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

describe('StreamingBlock', () => {
  it('renders nothing without an interactive frontier task or proposal', () => {
    renderBlock()
    expect(screen.queryByTestId(testids.streamingBlock)).toBeNull()
  })

  it('renders nothing for a snippet-targeted (quick-edit) task — no mid-document streaming', () => {
    useTaskStore.setState({
      interactive: interactive({ kind: 'quick-edit', target: { kind: 'snippet', id: T1 } }),
    })
    renderBlock()
    expect(screen.queryByTestId(testids.streamingBlock)).toBeNull()
  })

  it('planning phase shows the latest tool note, never prose', () => {
    useTaskStore.setState({
      interactive: interactive({
        toolNotes: ['opened Chapter 7', 'searched "storm glass"'],
      }),
    })
    renderBlock()
    const activity = screen.getByTestId(testids.streamingPlanning)
    expect(activity.textContent).toContain('planning')
    expect(activity.textContent).toContain('searched "storm glass"')
    expect(screen.queryByTestId(testids.streamingText)).toBeNull()
  })

  it('writing phase renders the frontier buffer as plain text with the caret', () => {
    useTaskStore.setState({
      interactive: interactive({
        stage: 'writing',
        buffers: new Map([['frontier', 'Mara pressed her palm against the storm glass']]),
      }),
    })
    renderBlock()
    const text = screen.getByTestId(testids.streamingText)
    expect(text.textContent).toContain('Mara pressed her palm against the storm glass')
    expect(screen.queryByTestId(testids.streamingPlanning)).toBeNull()
  })

  it('shows the instruction header for instructed-continue', () => {
    useTaskStore.setState({
      interactive: interactive({
        kind: 'instructed-continue',
        instruction: 'make the storm arrive early',
      }),
    })
    renderBlock()
    expect(screen.getByTestId(testids.streamingBlock).textContent).toContain(
      'make the storm arrive early',
    )
  })

  it('surfaces retrying and usage on the status line', () => {
    useTaskStore.setState({
      interactive: interactive({
        stage: 'writing',
        retrying: { attempt: 2, reason: 'output_invalid' },
        usage: { promptTokens: 6412, completionTokens: 388, estimated: false, costUsd: null },
      }),
    })
    renderBlock()
    expect(screen.getByTestId(testids.streamingRetrying).textContent).toContain('attempt 2')
    expect(screen.getByTestId(testids.streamingUsage).textContent).toContain('6,412 in / 388 out')
  })

  it('cancel posts to the cancel route', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      status: 202,
      json: () =>
        Promise.resolve({
          id: T1,
          workId: W,
          spec: { kind: 'continue' },
          lane: 'interactive',
          status: 'cancelled',
          queuedAt: '2026-08-02T00:00:00.000Z',
          startedAt: '2026-08-02T00:00:00.000Z',
          endedAt: null,
          error: null,
        }),
    }))
    vi.stubGlobal('fetch', fetchMock)
    useTaskStore.setState({ interactive: interactive({ stage: 'writing' }) })
    renderBlock()

    fireEvent.click(screen.getByTestId(testids.streamingCancel))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const url = String(fetchMock.mock.calls[0]?.[0])
    expect(url).toBe(`/api/works/${W}/tasks/${T1}/cancel`)
  })

  it('a frontier proposal renders the keep-partial card in the block’s place', () => {
    useTaskStore.setState({
      proposal: {
        taskId: T1,
        kind: 'continue',
        target: { kind: 'frontier' },
        text: 'The storm arrived early after all.',
        reason: 'failed',
        message: 'upstream timeout',
        retryable: true,
      },
    })
    renderBlock()
    const card = screen.getByTestId(testids.keepPartial)
    expect(card.textContent).toContain('upstream timeout')
    expect(card.textContent).toContain('The storm arrived early after all.')
    expect(screen.getByTestId(testids.keepPartialApply).textContent).toContain(
      'Keep partial as snippet',
    )
  })
})
