import type { WorldEntryDto } from '@cowrite/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTaskStore } from '../../state/taskStore.js'
import { testids } from '../../testids.js'
import { EntryImage } from './EntryImage.js'

/**
 * World-entry image generation (docs/08-illustration.md §5, §8; docs/04-frontend.md §9.3):
 * Generate/Regenerate (+ guidance) launch `world-image`, and the shimmer overlay reflects the
 * task's `task.progress` phase.
 */

const W = '01ARZ3NDEKTSV4RRFFQ69G5FA0'
const E = '01ARZ3NDEKTSV4RRFFQ69G5FA1'
const T1 = '01ARZ3NDEKTSV4RRFFQ69G5FA2'

function makeEntry(over: Partial<WorldEntryDto> = {}): WorldEntryDto {
  return {
    id: E,
    name: 'Mara Voss',
    keys: ['Mara'],
    body: 'A weathered woman in her forties.',
    bodyHash: `xxh64:${'a'.repeat(16)}`,
    shortSummary: null,
    hasImage: false,
    imageVersion: null,
    updatedAt: '2026-08-01T12:00:00.000Z',
    ...over,
  }
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

function renderImage(entry: WorldEntryDto) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <EntryImage workId={W} entry={entry} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  useTaskStore.getState().reset()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('EntryImage', () => {
  it('no image yet: "Generate" opens a guidance box and posts world-image', async () => {
    const fetchMock = stubFetch((url) =>
      url === `/api/works/${W}/tasks`
        ? {
            status: 202,
            body: {
              id: T1,
              workId: W,
              spec: { kind: 'world-image', entryId: E, guidance: 'storm-lantern in hand' },
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
    renderImage(makeEntry())
    expect(screen.queryByTestId(testids.worldImage)).toBeNull()

    fireEvent.click(screen.getByTestId(testids.worldImageGenerate))
    const input = await screen.findByTestId(testids.worldImageGuidanceInput)
    fireEvent.change(input, { target: { value: 'storm-lantern in hand' } })
    fireEvent.click(screen.getByTestId(testids.worldImageGuidanceSubmit))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([u]) => String(u) === `/api/works/${W}/tasks`)
      expect(call).toBeDefined()
      const body = JSON.parse((call?.[1] as RequestInit).body as string)
      expect(body).toEqual({
        kind: 'world-image',
        entryId: E,
        guidance: 'storm-lantern in hand',
      })
    })
  })

  it('an existing image offers Regenerate…/Remove and shows the image', () => {
    stubFetch(() => ({ status: 404, body: {} }))
    renderImage(makeEntry({ hasImage: true, imageVersion: 'v1' }))
    expect(screen.getByTestId(testids.worldImage)).toBeTruthy()
    expect(screen.getByText('Regenerate…')).toBeTruthy()
    expect(screen.getByTestId(testids.worldImageDelete)).toBeTruthy()
  })

  it('the shimmer overlay reflects a live world-image task.progress phase', () => {
    stubFetch(() => ({ status: 404, body: {} }))
    useTaskStore.getState().started(
      {
        id: T1,
        workId: W,
        spec: { kind: 'world-image', entryId: E },
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
      { kind: 'entry', id: E },
    )
    useTaskStore
      .getState()
      .progress(T1, { phase: 'critiquing', attempt: 1, maxAttempts: 3, pct: null })
    renderImage(makeEntry())
    expect(screen.getByTestId(testids.illustrationCaption).textContent).toBe('Critiquing…')
  })

  it('Cancel closes the guidance box without submitting', async () => {
    stubFetch(() => ({ status: 404, body: {} }))
    renderImage(makeEntry())
    fireEvent.click(screen.getByTestId(testids.worldImageGenerate))
    await screen.findByTestId(testids.worldImageGuidanceInput)
    fireEvent.click(screen.getByTestId(testids.worldImageGuidanceCancel))
    expect(screen.queryByTestId(testids.worldImageGuidanceInput)).toBeNull()
  })
})
