import type { SectionRow } from '@cowrite/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { qk } from '../../api/queries.js'
import { useTaskStore } from '../../state/taskStore.js'
import { testids } from '../../testids.js'
import { SectionBlock } from './SectionBlock.js'

/**
 * The section illustration box (docs/04-frontend.md §5.5, §10): full fold floats a 320px
 * box, long/short show a 96px thumbnail, both reserve the box during generation (no
 * committed image yet) and open the lightbox on click.
 */

const W = '01ARZ3NDEKTSV4RRFFQ69G5FA0'
const S1 = '01ARZ3NDEKTSV4RRFFQ69G5FA1'
const T1 = '01ARZ3NDEKTSV4RRFFQ69G5FA2'

function section(over: Partial<SectionRow> = {}): SectionRow {
  return {
    id: S1,
    parentId: null,
    kind: 'scene',
    orderKey: 'a0',
    title: 'The Ferry',
    titleSource: 'agent',
    isLeaf: true,
    wordCount: 400,
    contentHash: 'c'.repeat(64),
    shortSummary: 'short.',
    longSummary: 'long.',
    illustration: null,
    stale: { short: false, long: false, illustration: false },
    ...over,
  }
}

function renderBlock(over: Partial<SectionRow>, fold: 'full' | 'long' | 'short' = 'long') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  if (fold === 'full') {
    qc.setQueryData(qk.sectionText(W, S1), { markdown: 'Prose text.', contentHash: 'c'.repeat(64) })
  }
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <SectionBlock workId={W} section={section(over)} fold={fold} matcher={null} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  useTaskStore.getState().reset()
})

afterEach(() => cleanup())

describe('SectionBlock illustration box', () => {
  it('renders nothing when there is no illustration, no run, no failure', () => {
    renderBlock({})
    expect(screen.queryByTestId(testids.illustrationImage)).toBeNull()
    expect(screen.queryByTestId(testids.illustrationShimmer)).toBeNull()
  })

  it('long/short shows the 96px thumbnail with the version cache-buster', () => {
    renderBlock({ illustration: { version: 'v9', width: 1024, height: 683 } }, 'long')
    const img = screen.getByTestId(testids.illustrationImage) as HTMLImageElement
    expect(img.src).toContain(`/api/works/${W}/sections/${S1}/illustration?v=v9`)
    expect(img.closest('.section-illustration--thumb')).toBeTruthy()
  })

  it('full fold floats the box without the thumb modifier', () => {
    renderBlock({ illustration: { version: 'v9', width: 1024, height: 683 } }, 'full')
    const img = screen.getByTestId(testids.illustrationImage)
    expect(img.closest('.section-illustration--thumb')).toBeNull()
    expect(img.closest('.section-illustration')).toBeTruthy()
  })

  it('the box still reserves space and shimmers while a run targets this section — no committed image yet', () => {
    useTaskStore.getState().started(
      {
        id: T1,
        workId: W,
        spec: { kind: 'illustrate-section', sectionId: S1 },
        lane: 'illustration',
        status: 'running',
        queuedAt: 'now',
        startedAt: 'now',
        endedAt: null,
        error: null,
        partialText: null,
        unresolvedProposal: null,
      },
      'illustration',
      { kind: 'section', id: S1 },
    )
    useTaskStore
      .getState()
      .progress(T1, { phase: 'generating', attempt: 1, maxAttempts: 3, pct: 40 })
    renderBlock({})
    expect(screen.queryByTestId(testids.illustrationImage)).toBeNull()
    expect(screen.getByTestId(testids.illustrationCaption).textContent).toBe(
      'Generating (attempt 1/3, 40%)',
    )
  })

  it('clicking the image opens the lightbox', () => {
    renderBlock({ illustration: { version: 'v9', width: 1024, height: 683 } }, 'long')
    fireEvent.click(screen.getByTestId(testids.illustrationImage))
    expect(screen.getByTestId(testids.illustrationLightbox)).toBeTruthy()
  })
})
