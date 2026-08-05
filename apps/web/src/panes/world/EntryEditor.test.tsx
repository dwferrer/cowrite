import type { WorldEntryDto } from '@cowrite/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { qk } from '../../api/queries.js'
import { testids } from '../../testids.js'
import { EntryEditor } from './EntryEditor.js'

/**
 * Two-writer world-body editing (03 §3.5, 04 §9.3): every body-replacing PATCH carries
 * `baseHash: entry.bodyHash`; a stale hash 409s into the conflict banner, where both
 * 'Take theirs' and 'Keep mine' converge — 'Keep mine' resubmits against the 409's
 * REFETCHED currentHash, never the stale one.
 */

const W = '01ARZ3NDEKTSV4RRFFQ69G5FA0'
const E = '01ARZ3NDEKTSV4RRFFQ69G5FA1'
const HASH_A = `xxh64:${'a'.repeat(16)}`
const HASH_SRV = `xxh64:${'c'.repeat(16)}`
const HASH_DONE = `xxh64:${'d'.repeat(16)}`

function makeEntry(over: Partial<WorldEntryDto> = {}): WorldEntryDto {
  return {
    id: E,
    name: 'Mara Voss',
    keys: ['Mara'],
    body: 'Original body.',
    bodyHash: HASH_A,
    shortSummary: null,
    hasImage: false,
    imageVersion: null,
    updatedAt: '2026-08-01T12:00:00.000Z',
    ...over,
  }
}

interface PatchCall {
  body?: string
  baseHash?: string
  [key: string]: unknown
}

type PatchResponder = (body: PatchCall, call: number) => { status: number; body: unknown }

function renderEditor(onPatch: PatchResponder) {
  const patchCalls: PatchCall[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== 'PATCH') throw new Error(`unexpected ${init?.method ?? 'GET'}`)
      const body = JSON.parse(String(init.body)) as PatchCall
      patchCalls.push(body)
      const res = onPatch(body, patchCalls.length)
      return {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        json: () => Promise.resolve(res.body),
      }
    }),
  )
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const entry = makeEntry()
  qc.setQueryData(qk.world(W), [entry])
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <EntryEditor workId={W} entry={entry} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { qc, patchCalls }
}

const conflict409 = {
  status: 409,
  body: {
    error: {
      code: 'conflict',
      message: 'world entry body changed under you (stale baseHash)',
      details: { currentHash: HASH_SRV, currentText: 'Theirs body.' },
    },
  },
}

const saved200 = (body: string) => ({
  status: 200,
  body: JSON.parse(
    JSON.stringify(makeEntry({ body, bodyHash: HASH_DONE, updatedAt: '2026-08-01T13:00:00.000Z' })),
  ) as unknown,
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('EntryEditor two-writer body conflict', () => {
  it('sends baseHash on every body save; a 409 raises the conflict banner', async () => {
    const { patchCalls } = renderEditor(() => conflict409)
    fireEvent.change(screen.getByTestId(testids.worldBodyText), {
      target: { value: 'My edit.' },
    })
    fireEvent.click(screen.getByTestId(testids.worldBodySave))

    await screen.findByTestId(testids.worldConflict)
    expect(patchCalls).toHaveLength(1)
    expect(patchCalls[0]).toMatchObject({ body: 'My edit.', baseHash: HASH_A })
  })

  it("'Take theirs' adopts the 409's server text and clears the banner", async () => {
    const { patchCalls } = renderEditor(() => conflict409)
    fireEvent.change(screen.getByTestId(testids.worldBodyText), {
      target: { value: 'My edit.' },
    })
    fireEvent.click(screen.getByTestId(testids.worldBodySave))
    await screen.findByTestId(testids.worldConflict)

    fireEvent.click(screen.getByTestId(testids.worldConflictTheirs))

    expect(screen.queryByTestId(testids.worldConflict)).toBeNull()
    expect((screen.getByTestId(testids.worldBodyText) as HTMLTextAreaElement).value).toBe(
      'Theirs body.',
    )
    expect(patchCalls).toHaveLength(1) // no resubmit
  })

  it("'Keep mine' resubmits against the REFETCHED hash and converges in one retry", async () => {
    // Regression: resubmitting with the stale entry.bodyHash would 409 forever.
    const { qc, patchCalls } = renderEditor((_body, call) =>
      call === 1 ? conflict409 : saved200('My edit.'),
    )
    fireEvent.change(screen.getByTestId(testids.worldBodyText), {
      target: { value: 'My edit.' },
    })
    fireEvent.click(screen.getByTestId(testids.worldBodySave))
    await screen.findByTestId(testids.worldConflict)

    fireEvent.click(screen.getByTestId(testids.worldConflictMine))

    await waitFor(() => {
      expect(patchCalls).toHaveLength(2) // exactly one retry
    })
    expect(patchCalls[1]).toMatchObject({ body: 'My edit.', baseHash: HASH_SRV })
    expect(screen.queryByTestId(testids.worldConflict)).toBeNull()
    await waitFor(() => {
      const cached = qc.getQueryData<WorldEntryDto[]>(qk.world(W))
      expect(cached?.[0]?.body).toBe('My edit.')
      expect(cached?.[0]?.bodyHash).toBe(HASH_DONE)
    })
  })
})
