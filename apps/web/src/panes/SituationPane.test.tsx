import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyWorkEvent, useWorkStatusStore } from '../api/events.js'
import { qk } from '../api/queries.js'
import { testids } from '../testids.js'
import { SituationPane } from './SituationPane.js'

/**
 * The situation save controller (04 §9.1): single in-flight save against the acked hash,
 * self-echo suppression by hash, the dirty-guard against refetch rebasing, and one-retry
 * convergence for 'Keep mine'. A foreign `situation.changed` while dirty chips instead of
 * clobbering; while clean it applies silently.
 */

const W = 'W1'
const HASH = `xxh64:${'a'.repeat(16)}`
const HASH_ECHO = `xxh64:${'b'.repeat(16)}`
const HASH_SRV = `xxh64:${'c'.repeat(16)}`
const HASH_DONE = `xxh64:${'d'.repeat(16)}`

const serverSituation = {
  text: 'Server text.',
  updatedAt: '2026-08-01T12:00:00.000Z',
  hash: HASH,
}

interface PutCall {
  text: string
  baseHash: string | null
}

type PutResponder = (body: PutCall, call: number) => { status: number; body: unknown }

/** What GET /situation returns — tests mutate this to simulate the disk changing. */
let diskText = serverSituation.text

function renderPane(onPut?: PutResponder) {
  const putCalls: PutCall[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as PutCall
        putCalls.push(body)
        const res = onPut?.(body, putCalls.length) ?? {
          status: 200,
          body: { updatedAt: '2026-08-01T13:00:00.000Z', hash: HASH_ECHO },
        }
        return {
          ok: res.status >= 200 && res.status < 300,
          status: res.status,
          json: () => Promise.resolve(res.body),
        }
      }
      return {
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ...serverSituation, text: diskText }),
      }
    }),
  )
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  })
  qc.setQueryData(qk.situation(W), serverSituation)
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/w/${W}`]}>
        <SituationPane workId={W} width={320} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { qc, putCalls }
}

function typeDraft(value: string): HTMLTextAreaElement {
  fireEvent.click(screen.getByTestId(testids.situationRendered))
  const textarea = screen.getByTestId(testids.situationText) as HTMLTextAreaElement
  fireEvent.change(textarea, { target: { value } })
  return textarea
}

beforeEach(() => {
  useWorkStatusStore.getState().reset()
  diskText = serverSituation.text
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('SituationPane dirty-skip', () => {
  it('shows the changed-on-disk chip and keeps the draft when dirty', () => {
    const { qc } = renderPane()
    typeDraft('My unsaved draft.')
    expect(useWorkStatusStore.getState().situationDirty).toBe(true)

    act(() => {
      applyWorkEvent(qc, W, {
        type: 'situation.changed',
        text: 'Externally changed.',
        updatedAt: '2026-08-01T13:00:00.000Z',
        hash: HASH_SRV,
      })
    })

    // the chip appears; the draft is untouched; the cache was NOT clobbered
    expect(screen.getByTestId(testids.situationConflictChip).textContent).toContain(
      'changed on disk',
    )
    expect((screen.getByTestId(testids.situationText) as HTMLTextAreaElement).value).toBe(
      'My unsaved draft.',
    )
    expect(qc.getQueryData<typeof serverSituation>(qk.situation(W))?.text).toBe('Server text.')
  })

  it('applies the change silently when the pane is clean (hash rides the event)', async () => {
    const { qc } = renderPane()
    act(() => {
      applyWorkEvent(qc, W, {
        type: 'situation.changed',
        text: 'Externally changed.',
        updatedAt: '2026-08-01T13:00:00.000Z',
        hash: HASH_SRV,
      })
    })
    expect(useWorkStatusStore.getState().situationChangedOnDisk).toBeNull()
    await waitFor(() => {
      expect(qc.getQueryData<typeof serverSituation>(qk.situation(W))?.text).toBe(
        'Externally changed.',
      )
      expect(screen.getByTestId(testids.situationRendered).textContent).toContain(
        'Externally changed.',
      )
    })
    // the acked base moved with it — the next save runs against the fresh hash
    expect(useWorkStatusStore.getState().situationAcked).toEqual({
      text: 'Externally changed.',
      hash: HASH_SRV,
    })
  })

  it('"Take theirs" adopts the disk version and clears the chip without a refetch', async () => {
    const { qc } = renderPane()
    typeDraft('My unsaved draft.')
    act(() => {
      applyWorkEvent(qc, W, {
        type: 'situation.changed',
        text: 'Externally changed.',
        updatedAt: '2026-08-01T13:00:00.000Z',
        hash: HASH_SRV,
      })
    })
    fireEvent.click(screen.getByText('Take theirs'))
    expect(useWorkStatusStore.getState().situationDirty).toBe(false)
    expect(screen.queryByText('changed on disk')).toBeNull()
    // the chip's payload carried the hash — cache and acked state adopt it directly
    expect(qc.getQueryData<typeof serverSituation>(qk.situation(W))?.hash).toBe(HASH_SRV)
    expect(useWorkStatusStore.getState().situationAcked?.hash).toBe(HASH_SRV)
  })
})

describe('SituationPane save controller', () => {
  it('suppresses the echo of its own save — no chip (self-echo by hash)', async () => {
    const { qc, putCalls } = renderPane(() => ({
      status: 200,
      body: { updatedAt: '2026-08-01T13:00:00.000Z', hash: HASH_ECHO },
    }))
    const textarea = typeDraft('My own text.')
    fireEvent.blur(textarea)
    await waitFor(() => {
      expect(putCalls).toHaveLength(1)
      expect(useWorkStatusStore.getState().situationAcked?.hash).toBe(HASH_ECHO)
    })

    // the SSE echo of that very save arrives — it must be a no-op
    act(() => {
      applyWorkEvent(qc, W, {
        type: 'situation.changed',
        text: 'My own text.',
        updatedAt: '2026-08-01T13:00:00.000Z',
        hash: HASH_ECHO,
      })
    })
    expect(useWorkStatusStore.getState().situationChangedOnDisk).toBeNull()
    expect(screen.queryByTestId(testids.situationConflictChip)).toBeNull()
  })

  it("'Mine' converges in ONE retry against the 409's currentHash", async () => {
    // Regression (the old stale-closure loop): 'Mine' used to refetch and resubmit with
    // whatever hash the render closure held — a stale base that 409'd again forever.
    const { putCalls } = renderPane((_body, call) =>
      call === 1
        ? {
            status: 409,
            body: {
              error: {
                code: 'conflict',
                message: 'stale baseHash',
                details: {
                  currentText: 'Theirs on disk.',
                  currentHash: HASH_SRV,
                  updatedAt: '2026-08-01T13:00:00.000Z',
                },
              },
            },
          }
        : { status: 200, body: { updatedAt: '2026-08-01T14:00:00.000Z', hash: HASH_DONE } },
    )
    const textarea = typeDraft('Mine wins.')
    fireEvent.blur(textarea)

    await screen.findByTestId(testids.situationConflict)
    fireEvent.click(screen.getByTestId(testids.situationConflictMine))

    await waitFor(() => {
      expect(putCalls).toHaveLength(2) // exactly one retry
      expect(putCalls[1]).toEqual({ text: 'Mine wins.', baseHash: HASH_SRV })
      expect(useWorkStatusStore.getState().situationDirty).toBe(false)
      expect(useWorkStatusStore.getState().situationAcked).toEqual({
        text: 'Mine wins.',
        hash: HASH_DONE,
      })
    })
    expect(screen.queryByTestId(testids.situationConflict)).toBeNull()
  })

  it("'Theirs' adopts the 409 payload and drops the draft", async () => {
    const { qc, putCalls } = renderPane(() => ({
      status: 409,
      body: {
        error: {
          code: 'conflict',
          message: 'stale baseHash',
          details: {
            currentText: 'Theirs on disk.',
            currentHash: HASH_SRV,
            updatedAt: '2026-08-01T13:00:00.000Z',
          },
        },
      },
    }))
    const textarea = typeDraft('Mine loses.')
    fireEvent.blur(textarea)
    await screen.findByTestId(testids.situationConflict)
    fireEvent.click(screen.getByTestId(testids.situationConflictTheirs))

    expect(putCalls).toHaveLength(1) // no resubmit
    expect(useWorkStatusStore.getState().situationDirty).toBe(false)
    expect(qc.getQueryData<typeof serverSituation>(qk.situation(W))?.text).toBe('Theirs on disk.')
    expect(useWorkStatusStore.getState().situationAcked?.hash).toBe(HASH_SRV)
    expect(screen.getByTestId(testids.situationRendered).textContent).toContain('Theirs on disk.')
  })

  it('a reconnect refetch under a dirty draft cannot rebase the hash (still 409s)', async () => {
    // Regression: a hello/focus refetch used to write a fresh hash into the query cache
    // and the next save silently overwrote the foreign edit. The acked base must ignore
    // refetched data while dirty, so the save still runs against the OLD hash.
    const { qc, putCalls } = renderPane(() => ({
      status: 409,
      body: {
        error: {
          code: 'conflict',
          message: 'stale baseHash',
          details: {
            currentText: 'Foreign edit.',
            currentHash: HASH_SRV,
            updatedAt: '2026-08-01T13:00:00.000Z',
          },
        },
      },
    }))
    const textarea = typeDraft('Dirty draft.')

    // a reconnect-triggered refetch lands fresh (foreign) data in the cache
    act(() => {
      qc.setQueryData(qk.situation(W), {
        text: 'Foreign edit.',
        updatedAt: '2026-08-01T13:00:00.000Z',
        hash: HASH_SRV,
      })
    })
    expect(useWorkStatusStore.getState().situationAcked?.hash).toBe(HASH) // NOT rebased

    fireEvent.blur(textarea)
    await waitFor(() => expect(putCalls).toHaveLength(1))
    expect(putCalls[0]?.baseHash).toBe(HASH) // the old base ⇒ the server 409s, no overwrite
    await screen.findByTestId(testids.situationConflict)
  })
})
