import type { RunEvent } from '@cowrite/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { qk } from '../api/queries.js'
import { useDocUiStore } from '../state/docUiStore.js'
import { testids } from '../testids.js'
import { RunViewer } from './RunViewer.js'

/**
 * Provenance viewer render from a fixture run (docs/04-frontend.md §7.4): meta header,
 * prompt region breakdown from the ContextSnapshot, raw prompt text from message events,
 * tool-call steps, output, and artifact links back into the document.
 */

const W = '01ARZ3NDEKTSV4RRFFQ69G5FA0'
const R1 = '01ARZ3NDEKTSV4RRFFQ69G5FC1'
const SID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

const fixtureRun: RunEvent[] = [
  {
    type: 'meta',
    runId: R1,
    kind: 'continue',
    lane: 'high',
    model: 'mock-gpt-high',
    spec: { kind: 'continue' },
    params: { promptsHash: 'xxh64:abcd1234abcd1234', temperature: 0.8 },
    contextSnapshot: {
      regions: [
        { name: 'instructions', tokens: 412 },
        { name: 'world-info', tokens: 1800 },
        { name: 'global-context', tokens: 2900 },
      ],
      items: [{ id: SID, kind: 'snippet', fidelity: 'full', tokens: 220, source: 'default' }],
    },
    startedAt: '2026-08-02T00:00:00.000Z',
  },
  { type: 'message', role: 'system', text: 'You are a co-writer…' },
  { type: 'message', role: 'user', text: 'Continue the story.' },
  { type: 'stage', stage: 'planning', round: 1 },
  {
    type: 'toolCall',
    name: 'context_expand',
    input: { id: SID, fidelity: 'full' },
    output: 'Chapter 7 — The Ferry (full, 1043 tok)',
    durationMs: 12.4,
  },
  { type: 'stage', stage: 'writing', round: 1 },
  { type: 'output', text: 'Mara pressed her palm ', attempt: 1 },
  { type: 'output', text: 'against the storm glass…', attempt: 1 },
  {
    type: 'usage',
    promptTokens: 6412,
    completionTokens: 388,
    estimated: false,
    call: 'writing',
  },
  {
    type: 'result',
    status: 'ok',
    usageTotal: { promptTokens: 6412, completionTokens: 388, estimated: false },
    partialText: null,
    artifacts: [{ kind: 'snippet', snippetId: SID, rev: 1, state: 'committed' }],
    endedAt: '2026-08-02T00:00:13.200Z',
  },
]

function renderViewer(onClose = vi.fn()) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  })
  qc.setQueryData(qk.run(W, R1), fixtureRun)
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/w/${W}/runs/${R1}`]}>
        <RunViewer workId={W} runId={R1} onClose={onClose} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return onClose
}

beforeEach(() => {
  useDocUiStore.setState({ selection: null, editing: null, peekRevision: null, followBottom: true })
})

afterEach(() => cleanup())

describe('RunViewer', () => {
  it('renders the meta header: kind, lane, model, promptsHash, usage, duration, status', () => {
    renderViewer()
    const header = screen.getByTestId(testids.runViewerHeader)
    expect(header.textContent).toContain('continue')
    expect(header.textContent).toContain('high model')
    expect(header.textContent).toContain('mock-gpt-high')
    expect(header.textContent).toContain('xxh64:abcd1234abcd1234')
    expect(header.textContent).toContain('6,412 in / 388 out')
    expect(header.textContent).toContain('13.2 s')
    expect(header.textContent).toContain('ok')
  })

  it('renders the prompt region breakdown with token counts', () => {
    renderViewer()
    const regions = screen.getAllByTestId(testids.runRegion)
    expect(regions).toHaveLength(3)
    expect(regions[0]?.textContent).toContain('instructions')
    expect(regions[0]?.textContent).toContain('412 tok')
    expect(regions[2]?.textContent).toContain('global-context')
    expect(regions[2]?.textContent).toContain('2,900 tok')
  })

  it('exposes the full prompt text from message events', () => {
    renderViewer()
    const messages = screen.getAllByTestId(testids.runPromptMessage)
    expect(messages).toHaveLength(2)
    expect(messages[0]?.textContent).toContain('You are a co-writer…')
    expect(messages[1]?.textContent).toContain('Continue the story.')
  })

  it('renders tool calls as timeline steps and the streamed output joined', () => {
    renderViewer()
    const tool = screen.getByTestId(testids.runToolCall)
    expect(tool.textContent).toContain('context_expand')
    expect(tool.textContent).toContain('Chapter 7 — The Ferry')
    expect(screen.getByTestId(testids.runOutput).textContent).toContain(
      'Mara pressed her palm against the storm glass…',
    )
  })

  it('artifacts link back into the document: jump selects the snippet and closes', () => {
    const onClose = renderViewer()
    const artifact = screen.getByTestId(testids.runArtifact)
    expect(artifact.textContent).toContain('snippet')
    expect(artifact.textContent).toContain('rev 1')

    fireEvent.click(screen.getByText('jump to snippet'))
    expect(useDocUiStore.getState().selection).toEqual({ kind: 'snippet', id: SID })
    expect(onClose).toHaveBeenCalled()
  })

  it('Esc and the close button both close the modal', () => {
    const onClose = renderViewer()
    fireEvent.click(screen.getByTestId(testids.runViewerClose))
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
