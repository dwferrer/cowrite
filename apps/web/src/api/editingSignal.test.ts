import { afterEach, describe, expect, it, vi } from 'vitest'
import { signalEditing } from './editingSignal.js'

const ULID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('signalEditing', () => {
  it('POSTs the snippet id fire-and-forget with keepalive', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 })
    vi.stubGlobal('fetch', fetchMock)

    signalEditing(ULID, ULID)

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`/api/works/${ULID}/editing`)
    expect(init.method).toBe('POST')
    expect(init.keepalive).toBe(true)
    expect(JSON.parse(init.body as string)).toEqual({ snippetId: ULID })
  })

  it('retries exactly once on failure, then gives up quietly', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockRejectedValueOnce(new Error('still down'))
    vi.stubGlobal('fetch', fetchMock)

    signalEditing(ULID, null)

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    // both attempts carried the null (editor closed) payload
    for (const call of fetchMock.mock.calls) {
      expect(JSON.parse((call as [string, RequestInit])[1].body as string)).toEqual({
        snippetId: null,
      })
    }
  })

  it('retries when the response is non-2xx', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: true, status: 204 })
    vi.stubGlobal('fetch', fetchMock)

    signalEditing(ULID, ULID)

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
  })
})
