import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { testids } from '../testids.js'
import { WorksList } from './WorksList.js'

const W1 = '01ARZ3NDEKTSV4RRFFQ69G5FA1'
const W2 = '01ARZ3NDEKTSV4RRFFQ69G5FA2'

const works = [
  {
    id: W1,
    title: 'The Storm Glass',
    slug: 'the-storm-glass',
    wordCount: 8_421,
    snippetCount: 6,
    sectionCount: 3,
    updatedAt: '2026-08-01T12:00:00.000Z',
  },
  {
    id: W2,
    title: 'Untitled Draft',
    slug: 'untitled-draft',
    wordCount: null, // cheap-list semantics: not computed, never zero
    snippetCount: null,
    sectionCount: null,
    updatedAt: '2026-07-30T09:30:00.000Z',
  },
]

const createdWork = {
  ...works[0],
  id: '01ARZ3NDEKTSV4RRFFQ69G5FA3',
  title: 'New Story',
  slug: 'new-story',
  settings: {
    consolidation: {
      activeWindowSnippets: 6,
      activeWindowWords: 3000,
      maxFrontierSnippets: 18,
      maxFrontierWords: 9000,
      debounceMs: 30_000,
      undoGraceMs: 300_000,
      mode: 'auto',
    },
    illustrationStaleWordDeltaPct: 15,
    contextOverrides: {},
  },
  levelScheme: ['chapter'],
  readonly: false,
}

function renderWorksList(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('fetch', fetchMock)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter(
    [
      { path: '/', element: <WorksList /> },
      { path: '/w/:workId', element: <div /> }, // navigation asserted via router state
    ],
    { initialEntries: ['/'] },
  )
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return router
}

afterEach(() => {
  cleanup() // no vitest globals ⇒ testing-library auto-cleanup is off
  vi.unstubAllGlobals()
})

describe('WorksList', () => {
  it('renders titles, counts when present, and updatedAt', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(works),
    })
    renderWorksList(fetchMock)

    expect(await screen.findByText('The Storm Glass')).toBeDefined()
    expect(screen.getByText('Untitled Draft')).toBeDefined()

    const rows = screen.getAllByTestId(testids.worksRow)
    expect(rows).toHaveLength(2)
    // counts present on the first work…
    expect(rows[0]?.textContent).toContain('words')
    expect(rows[0]?.textContent).toContain('3 sections')
    expect(rows[0]?.textContent).toContain('6 snippets')
    // …and absent (null = not computed) on the second
    expect(rows[1]?.textContent).not.toContain('words')
    expect(rows[1]?.textContent).not.toContain('sections')
  })

  it('creates a work and navigates to it', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/works' && init?.method === 'POST') {
        return { ok: true, status: 201, json: () => Promise.resolve(createdWork) }
      }
      return { ok: true, status: 200, json: () => Promise.resolve([]) }
    })
    const router = renderWorksList(fetchMock)

    const input = await screen.findByTestId(testids.worksCreateInput)
    const button = screen.getByTestId(testids.worksCreateButton)
    expect((button as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(input, { target: { value: 'New Story' } })
    expect((button as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(button)

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/w/${createdWork.id}`)
    })
    const postCall = fetchMock.mock.calls.find((c) => (c[1] as RequestInit)?.method === 'POST')
    expect(postCall).toBeDefined()
    expect(JSON.parse((postCall?.[1] as RequestInit).body as string)).toEqual({
      title: 'New Story',
    })
  })
})
