import type { SectionRow } from '@cowrite/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePanelStore } from '../../state/panelStore.js'
import { testids } from '../../testids.js'
import { SectionHeader, staleTooltip } from './SectionHeader.js'

/**
 * The Stage-4 header surface (docs/04-frontend.md §5.3, §6): the fold widget writes pins
 * to the panel store (anchoring the clicked header first), `auto` clears them, and the
 * staleness badge names exactly what is out of date — illustration staleness deliberately
 * excluded until Stage 5.
 */

const W = '01ARZ3NDEKTSV4RRFFQ69G5FA0'
const S1 = '01ARZ3NDEKTSV4RRFFQ69G5FA1'

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
    shortSummary: 'short.',
    longSummary: 'long.',
    illustration: null,
    stale: { short: false, long: false, illustration: false },
    ...over,
  }
}

function renderHeader(props: Partial<Parameters<typeof SectionHeader>[0]> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <SectionHeader workId={W} section={section()} ordinal={3} depth={0} fold="short" {...props} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  localStorage.clear()
  usePanelStore.setState({ byWork: {} })
})

afterEach(() => {
  cleanup()
})

describe('staleTooltip', () => {
  it('names exactly what is stale', () => {
    expect(staleTooltip({ short: true, long: false, illustration: false })).toContain(
      'short summary',
    )
    expect(staleTooltip({ short: true, long: true, illustration: false })).toBe(
      'Out of date: short summary, long summary — will refresh with enrichment',
    )
  })

  it('returns null when nothing (Stage-4) is stale — illustration staleness is Stage 5', () => {
    expect(staleTooltip({ short: false, long: false, illustration: false })).toBeNull()
    // The illustrate-section pipeline does not exist yet; a badge that nothing will ever
    // clear would be noise (docs/10 Stage 5).
    expect(staleTooltip({ short: false, long: false, illustration: true })).toBeNull()
  })
})

describe('SectionHeader', () => {
  it('renders the title and the staleness badge with its naming tooltip', () => {
    renderHeader({
      section: section({ stale: { short: true, long: false, illustration: false } }),
    })
    expect(screen.getByText('The Ferry')).toBeTruthy()
    const badge = screen.getByTestId(testids.staleBadge)
    expect(badge.getAttribute('title')).toContain('short summary')
  })

  it('shows no badge for illustration-only staleness (Stage-5 skip)', () => {
    renderHeader({
      section: section({ stale: { short: false, long: false, illustration: true } }),
    })
    expect(screen.queryByTestId(testids.staleBadge)).toBeNull()
  })

  it('clicking a fold dot anchors first, then pins the level', () => {
    const onBeforeFoldChange = vi.fn(() => {
      // called BEFORE the store mutates — layout still reflects the old fold
      expect(usePanelStore.getState().byWork[W]?.foldOverrides[S1]).toBeUndefined()
    })
    renderHeader({ onBeforeFoldChange })

    const fullDot = screen
      .getAllByTestId(testids.foldDot)
      .find((el) => el.getAttribute('data-level') === 'full')
    expect(fullDot).toBeTruthy()
    fireEvent.click(fullDot as HTMLElement)

    expect(onBeforeFoldChange).toHaveBeenCalledWith(S1)
    expect(usePanelStore.getState().byWork[W]?.foldOverrides[S1]).toBe('full')
  })

  it('auto clears the pin and the pin glyph', () => {
    usePanelStore.getState().setFold(W, S1, 'name')
    renderHeader({ fold: 'name' })
    expect(document.querySelector('.fold-widget__pin')).toBeTruthy()

    fireEvent.click(screen.getByTestId(testids.foldAuto))
    expect(usePanelStore.getState().byWork[W]?.foldOverrides).toEqual({})
  })

  it('marks the effective fold dot pressed and shows the fold hint when collapsed', () => {
    renderHeader({ fold: 'short' })
    const pressed = screen
      .getAllByTestId(testids.foldDot)
      .filter((el) => el.getAttribute('aria-pressed') === 'true')
    expect(pressed.map((el) => el.getAttribute('data-level'))).toEqual(['short'])
    expect(screen.getByText('(short)')).toBeTruthy()
  })

  it('interior sections carry no fold widget', () => {
    renderHeader({ section: section({ isLeaf: false, kind: 'part' }), fold: 'full' })
    expect(screen.queryByTestId(testids.foldWidget)).toBeNull()
  })
})
