import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { qk } from '../api/queries.js'
import { type BackgroundTask, useTaskStore } from '../state/taskStore.js'
import { testids } from '../testids.js'
import { BackgroundActivity, backgroundTaskLabel } from './BackgroundActivity.js'

/**
 * The background-lane pulse dot + popover (docs/04-frontend.md §4.4, Stage 4): invisible
 * while the lane is idle, a quiet dot while enrichment/boundary tasks run, and the
 * popover names each task with its target and queue/progress state.
 */

const W = '01ARZ3NDEKTSV4RRFFQ69G5FA0'
const S1 = '01ARZ3NDEKTSV4RRFFQ69G5FA1'
const T1 = '01ARZ3NDEKTSV4RRFFQ69G5FB1'
const T2 = '01ARZ3NDEKTSV4RRFFQ69G5FB2'

function renderActivity(sections: Array<{ id: string; title: string | null }> = []) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  if (sections.length > 0) qc.setQueryData(qk.sections(W), sections)
  return render(
    <QueryClientProvider client={qc}>
      <BackgroundActivity workId={W} />
    </QueryClientProvider>,
  )
}

function bg(over: Partial<BackgroundTask> = {}): BackgroundTask {
  return { kind: 'enrich-section', target: { kind: 'section', id: S1 }, ...over }
}

beforeEach(() => {
  useTaskStore.getState().reset()
})

afterEach(() => {
  cleanup()
})

describe('backgroundTaskLabel', () => {
  const title = (id: string) => (id === S1 ? 'The Ferry' : null)

  it('names section targets by their title', () => {
    expect(backgroundTaskLabel(bg(), title)).toBe('enrich-section · The Ferry — running')
  })

  it('shows queue position while queued (background lanes queue; interactive never does)', () => {
    expect(backgroundTaskLabel(bg({ queuedPosition: 1 }), title)).toBe(
      'enrich-section · The Ferry — queued #2',
    )
  })

  it('shows the progress phase and pct when present', () => {
    expect(backgroundTaskLabel(bg({ phase: 'generating', pct: 64 }), title)).toBe(
      'enrich-section · The Ferry — generating 64%',
    )
  })

  it('falls back for frontier targets and unknown sections', () => {
    expect(
      backgroundTaskLabel(bg({ kind: 'propose-boundaries', target: { kind: 'frontier' } }), title),
    ).toBe('propose-boundaries · frontier — running')
  })
})

describe('BackgroundActivity', () => {
  it('renders nothing while the background map is empty', () => {
    renderActivity()
    expect(screen.queryByTestId(testids.backgroundDot)).toBeNull()
  })

  it('shows the pulse dot and lists running tasks in the popover', () => {
    useTaskStore.setState({
      background: new Map([
        [T1, bg()],
        [T2, bg({ kind: 'propose-boundaries', target: { kind: 'frontier' } })],
      ]),
    })
    renderActivity([{ id: S1, title: 'The Ferry' }])

    const dot = screen.getByTestId(testids.backgroundDot)
    expect(dot.getAttribute('aria-label')).toBe('2 background tasks running')
    expect(screen.queryByTestId(testids.backgroundPopover)).toBeNull()

    fireEvent.click(dot)
    const rows = screen.getAllByTestId(testids.backgroundTaskRow)
    expect(rows.map((r) => r.textContent)).toEqual([
      'enrich-section · The Ferry — running',
      'propose-boundaries · frontier — running',
    ])
  })

  it('disappears when the last background task ends', () => {
    useTaskStore.setState({ background: new Map([[T1, bg()]]) })
    renderActivity()
    expect(screen.getByTestId(testids.backgroundDot)).toBeTruthy()

    act(() => useTaskStore.getState().completed(T1))
    expect(screen.queryByTestId(testids.backgroundDot)).toBeNull()
  })
})
