import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, apiCall, ContractError } from './client.js'

const ULID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

const validWork = {
  id: ULID,
  title: 'The Storm Glass',
  slug: 'the-storm-glass',
  wordCount: 1200,
  snippetCount: 3,
  sectionCount: null,
  updatedAt: '2026-08-02T00:00:00.000Z',
}

function stubFetch(status: number, body?: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => (body === undefined ? Promise.reject(new Error('no body')) : Promise.resolve(body)),
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('apiCall', () => {
  it('parses a valid response against the shared schema', async () => {
    const fetchMock = stubFetch(200, [validWork])
    const works = await apiCall('listWorks', [])
    expect(works).toHaveLength(1)
    expect(works[0]?.title).toBe('The Storm Glass')
    expect(fetchMock).toHaveBeenCalledWith('/api/works', expect.objectContaining({ method: 'GET' }))
  })

  it('rejects with ContractError when a 2xx body fails the schema', async () => {
    stubFetch(200, [{ id: 'not-a-ulid', title: 42 }])
    const error = await apiCall('listWorks', []).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ContractError)
    expect((error as ContractError).route).toBe('listWorks')
    expect((error as ContractError).issues.length).toBeGreaterThan(0)
  })

  it('decodes the error envelope into ApiError', async () => {
    stubFetch(409, { error: { code: 'conflict', message: 'stale baseRev', details: { rev: 4 } } })
    const error = await apiCall('patchSnippet', [ULID, ULID], {
      body: { text: 'x', baseRev: 3 },
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    const apiError = error as ApiError
    expect(apiError.code).toBe('conflict')
    expect(apiError.status).toBe(409)
    expect(apiError.message).toBe('stale baseRev')
    expect(apiError.details).toEqual({ rev: 4 })
  })

  it('falls back to code internal for a non-envelope failure body', async () => {
    stubFetch(500, 'gateway exploded')
    const error = await apiCall('listWorks', []).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).code).toBe('internal')
    expect((error as ApiError).status).toBe(500)
  })

  it('serializes the JSON body and resolves undefined for 204 routes', async () => {
    const fetchMock = stubFetch(204)
    const result = await apiCall('deleteSnippet', [ULID, ULID])
    expect(result).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/works/${ULID}/snippets/${ULID}`,
      expect.objectContaining({ method: 'DELETE' }),
    )

    stubFetch(204)
    await apiCall('setEditing', [ULID], { body: { snippetId: null } })
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ]
    expect(call[0]).toBe(`/api/works/${ULID}/editing`)
    expect(call[1].headers).toEqual({ 'content-type': 'application/json' })
    expect(JSON.parse(call[1].body as string)).toEqual({ snippetId: null })
  })

  it('appends query parameters when given', async () => {
    const fetchMock = stubFetch(200, [])
    await apiCall('listRuns', [ULID], { query: { artifact: `snippet:${ULID}`, limit: 5 } })
    const url = fetchMock.mock.calls[0]?.[0] as string
    expect(url).toBe(`/api/works/${ULID}/runs?artifact=snippet%3A${ULID}&limit=5`)
  })
})
