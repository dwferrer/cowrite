import type { SectionRow } from '@cowrite/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useTaskStore } from '../../state/taskStore.js'
import { testids } from '../../testids.js'
import { hueFromId, NameCard } from './NameCard.js'

/**
 * The name-card image slot (docs/04-frontend.md §5.1, §10): placeholder vs committed image,
 * the shimmer overlay while illustrate-section runs, and the click-to-lightbox affordance.
 */

const W = '01ARZ3NDEKTSV4RRFFQ69G5FA0'
const S1 = '01ARZ3NDEKTSV4RRFFQ69G5FA1'
const T1 = '01ARZ3NDEKTSV4RRFFQ69G5FA2'

function section(over: Partial<SectionRow> = {}): SectionRow {
  return {
    id: S1,
    parentId: null,
    kind: 'chapter',
    orderKey: 'a0',
    title: 'The Ferry',
    titleSource: 'agent',
    isLeaf: true,
    wordCount: 1_000,
    contentHash: 'c'.repeat(64),
    shortSummary: 'The ferry departs at dawn. It never returns.',
    longSummary: 'long.',
    illustration: null,
    stale: { short: false, long: false, illustration: false },
    ...over,
  }
}

function renderCard(over: Partial<SectionRow> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <NameCard workId={W} section={section(over)} ordinal={3} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  useTaskStore.getState().reset()
})

afterEach(() => cleanup())

describe('NameCard', () => {
  it('renders the deterministic placeholder with initials when there is no illustration', () => {
    renderCard()
    const placeholder = screen.getByTestId(testids.illustrationPlaceholder)
    expect(placeholder.textContent).toBe('Th')
    expect(screen.queryByTestId(testids.illustrationImage)).toBeNull()
  })

  it('hueFromId is deterministic per section id', () => {
    expect(hueFromId(S1)).toBe(hueFromId(S1))
  })

  it('renders the committed image with the version cache-buster', () => {
    renderCard({ illustration: { version: 'abc123', width: 1024, height: 683 } })
    const img = screen.getByTestId(testids.illustrationImage) as HTMLImageElement
    expect(img.src).toContain(`/api/works/${W}/sections/${S1}/illustration?v=abc123`)
  })

  it('shows the shimmer caption while illustrate-section runs against this section', () => {
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
      .progress(T1, { phase: 'composing', attempt: 1, maxAttempts: 3, pct: null })
    renderCard()
    expect(screen.getByTestId(testids.illustrationCaption).textContent).toBe('Composing prompt')
  })

  it('clicking a committed image opens the lightbox', () => {
    renderCard({ illustration: { version: 'abc123', width: 1024, height: 683 } })
    fireEvent.click(screen.getByTestId(testids.illustrationImage))
    expect(screen.getByTestId(testids.illustrationLightbox)).toBeTruthy()
    fireEvent.click(screen.getByTestId(testids.illustrationLightboxClose))
    expect(screen.queryByTestId(testids.illustrationLightbox)).toBeNull()
  })
})
