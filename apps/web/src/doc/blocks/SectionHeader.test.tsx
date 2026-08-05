import type { SectionRow } from '@cowrite/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
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

function renderHeader(
  props: Partial<Parameters<typeof SectionHeader>[0]> = {},
  qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  }),
) {
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <SectionHeader
          workId={W}
          section={section()}
          ordinal={3}
          depth={0}
          fold="short"
          {...props}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function stubFetch(
  handler: (url: string, init?: RequestInit) => { status: number; body: unknown },
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const result = handler(String(input), init)
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      json: () => Promise.resolve(result.body),
    }
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(() => {
  localStorage.clear()
  usePanelStore.setState({ byWork: {} })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
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

describe('SectionHeader illustration menu (08 §5, §8; 04 §10)', () => {
  it('interior sections and readonly headers carry no "⋯" menu', () => {
    renderHeader({ section: section({ isLeaf: false, kind: 'part' }) })
    expect(screen.queryByTestId(testids.sectionMenuButton)).toBeNull()
    cleanup()
    renderHeader({ readonly: true })
    expect(screen.queryByTestId(testids.sectionMenuButton)).toBeNull()
  })

  it('an un-illustrated leaf section offers "Illustrate", which posts illustrate-section', async () => {
    const fetchMock = stubFetch((url) =>
      url === `/api/works/${W}/tasks`
        ? {
            status: 202,
            body: {
              id: 'T1',
              workId: W,
              spec: { kind: 'illustrate-section', sectionId: S1 },
              lane: 'illustration',
              status: 'queued',
              queuedAt: 'now',
              startedAt: null,
              endedAt: null,
              error: null,
              partialText: null,
              unresolvedProposal: null,
            },
          }
        : { status: 404, body: {} },
    )
    renderHeader()
    fireEvent.click(screen.getByTestId(testids.sectionMenuButton))
    expect(screen.queryByTestId(testids.regenerateAction)).toBeNull()
    fireEvent.click(screen.getByTestId(testids.illustrateAction))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([u]) => String(u) === `/api/works/${W}/tasks`)
      expect(call).toBeDefined()
      const body = JSON.parse((call?.[1] as RequestInit).body as string)
      expect(body).toEqual({ kind: 'illustrate-section', sectionId: S1 })
    })
  })

  it('an illustrated section offers Regenerate…, which opens a guidance box and submits it', async () => {
    const fetchMock = stubFetch((url) =>
      url === `/api/works/${W}/tasks`
        ? {
            status: 202,
            body: {
              id: 'T1',
              workId: W,
              spec: { kind: 'illustrate-section', sectionId: S1, guidance: 'dusk light' },
              lane: 'illustration',
              status: 'queued',
              queuedAt: 'now',
              startedAt: null,
              endedAt: null,
              error: null,
              partialText: null,
              unresolvedProposal: null,
            },
          }
        : { status: 404, body: {} },
    )
    renderHeader({
      section: section({
        illustration: { version: 'v1', width: 1024, height: 683 },
      }),
    })
    fireEvent.click(screen.getByTestId(testids.sectionMenuButton))
    expect(screen.queryByTestId(testids.illustrateAction)).toBeNull()
    fireEvent.click(screen.getByTestId(testids.regenerateAction))

    const input = await screen.findByTestId(testids.regenerateGuidanceInput)
    fireEvent.change(input, { target: { value: 'dusk light' } })
    fireEvent.click(screen.getByTestId(testids.regenerateGuidanceSubmit))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([u]) => String(u) === `/api/works/${W}/tasks`)
      expect(call).toBeDefined()
      const body = JSON.parse((call?.[1] as RequestInit).body as string)
      expect(body).toEqual({
        kind: 'illustrate-section',
        sectionId: S1,
        guidance: 'dusk light',
      })
    })
    expect(screen.queryByTestId(testids.regenerateGuidanceBox)).toBeNull()
  })

  it('Escape closes the guidance box without submitting', async () => {
    renderHeader({
      section: section({ illustration: { version: 'v1', width: 1024, height: 683 } }),
    })
    fireEvent.click(screen.getByTestId(testids.sectionMenuButton))
    fireEvent.click(screen.getByTestId(testids.regenerateAction))
    const input = await screen.findByTestId(testids.regenerateGuidanceInput)
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByTestId(testids.regenerateGuidanceBox)).toBeNull()
  })

  it('Remove illustration calls the DELETE route', async () => {
    const fetchMock = stubFetch((url, init) =>
      url === `/api/works/${W}/sections/${S1}/illustration` && init?.method === 'DELETE'
        ? { status: 204, body: undefined }
        : { status: 404, body: {} },
    )
    renderHeader({
      section: section({ illustration: { version: 'v1', width: 1024, height: 683 } }),
    })
    fireEvent.click(screen.getByTestId(testids.sectionMenuButton))
    fireEvent.click(screen.getByTestId(testids.removeIllustrationAction))

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([u, i]) =>
            String(u) === `/api/works/${W}/sections/${S1}/illustration` &&
            (i as RequestInit)?.method === 'DELETE',
        ),
      ).toBe(true)
    })
  })
})
