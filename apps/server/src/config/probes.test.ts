import { AppConfig } from '@cowrite/shared'
import { describe, expect, it } from 'vitest'
import { runProbe } from './probes.js'

/**
 * Probes receive the RAW candidate JSON (never pre-parsed through ConfigUpdate, whose
 * defaults materialize nulls): an omitted section falls back to stored, an explicit null
 * is "cleared ⇒ config_missing".
 */

const stored = AppConfig.parse({
  models: {
    high: { baseUrl: 'http://h.example/v1', apiKey: 'sk-stored', model: 'big' },
  },
  comfyui: { baseUrl: 'http://comfy.example' },
})

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: string | null
}

function mockFetch(responder: (url: string, call: Call) => Response | Promise<Response>): {
  calls: Call[]
  fetchImpl: typeof fetch
} {
  const calls: Call[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const call: Call = {
      url,
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(
        Object.entries((init?.headers as Record<string, string> | undefined) ?? {}).map(
          ([k, v]) => [k.toLowerCase(), v],
        ),
      ),
      body: typeof init?.body === 'string' ? init.body : null,
    }
    calls.push(call)
    return responder(url, call)
  }) as typeof fetch
  return { calls, fetchImpl }
}

const modelsResponse = (): Response =>
  new Response(JSON.stringify({ data: [{ id: 'big' }, { id: 'small' }] }), { status: 200 })

describe('LLM probes', () => {
  it('GETs {baseUrl}/models with the stored bearer key and reports the model list', async () => {
    const { calls, fetchImpl } = mockFetch(() => modelsResponse())
    const result = await runProbe({ target: 'high' as const }, stored, { fetchImpl })
    expect(result).toMatchObject({ ok: true })
    if (!result.ok) return
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    expect(result.detail).toContain('2 models')
    expect(result.detail).toContain("'big' available")
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('http://h.example/v1/models')
    expect(calls[0]?.headers.authorization).toBe('Bearer sk-stored')
  })

  it('candidate merge: apiKey null uses the stored key against the candidate baseUrl', async () => {
    const { calls, fetchImpl } = mockFetch(() => modelsResponse())
    const req = {
      target: 'high' as const,
      candidate: {
        models: { high: { baseUrl: 'http://new.example/v1', apiKey: null, model: 'big' } },
      },
    }
    const result = await runProbe(req, stored, { fetchImpl })
    expect(result.ok).toBe(true)
    expect(calls[0]?.url).toBe('http://new.example/v1/models')
    expect(calls[0]?.headers.authorization).toBe('Bearer sk-stored')
  })

  it('candidate apiKey "" probes keyless — no auth header', async () => {
    const { calls, fetchImpl } = mockFetch(() => modelsResponse())
    const req = {
      target: 'high' as const,
      candidate: {
        models: { high: { baseUrl: 'http://h.example/v1', apiKey: '', model: 'big' } },
      },
    }
    await runProbe(req, stored, { fetchImpl })
    expect(calls[0]?.headers.authorization).toBeUndefined()
  })

  it('a candidate that omits models probes the STORED endpoint', async () => {
    const { calls, fetchImpl } = mockFetch(() => modelsResponse())
    const result = await runProbe({ target: 'high' as const, candidate: {} }, stored, { fetchImpl })
    expect(result.ok).toBe(true)
    expect(calls[0]?.url).toBe('http://h.example/v1/models')
  })

  it('a candidate that explicitly clears the lane probes NOTHING ⇒ config_missing', async () => {
    // Regression: parsing the candidate through ConfigUpdate materialized null defaults,
    // so a cleared card was indistinguishable from an omitted one and the stored endpoint
    // was probed (reporting ok for an unconfigured card).
    const { calls, fetchImpl } = mockFetch(() => modelsResponse())
    const result = await runProbe(
      { target: 'high' as const, candidate: { models: { high: null } } },
      stored,
      { fetchImpl },
    )
    expect(result).toMatchObject({ ok: false, code: 'config_missing' })
    expect(calls).toHaveLength(0)
  })

  it('falls back to a 1-token chat/completions call when /models is 404', async () => {
    const { calls, fetchImpl } = mockFetch((url) =>
      url.endsWith('/models')
        ? new Response('nope', { status: 404 })
        : new Response(JSON.stringify({ choices: [] }), { status: 200 }),
    )
    const result = await runProbe({ target: 'high' as const }, stored, { fetchImpl })
    expect(result).toMatchObject({ ok: true })
    if (!result.ok) return
    expect(result.detail).toContain('chat/completions')
    expect(calls).toHaveLength(2)
    expect(calls[1]?.url).toBe('http://h.example/v1/chat/completions')
    expect(calls[1]?.method).toBe('POST')
    const body = JSON.parse(calls[1]?.body ?? '{}') as { model?: string; max_tokens?: number }
    expect(body.model).toBe('big')
    expect(body.max_tokens).toBe(1)
  })

  it('maps HTTP statuses to failure codes', async () => {
    for (const [status, code] of [
      [401, 'auth'],
      [403, 'auth'],
      [429, 'rate_limited'],
      [500, 'endpoint_unreachable'],
    ] as const) {
      const { fetchImpl } = mockFetch(() => new Response('err', { status }))
      const result = await runProbe({ target: 'high' as const }, stored, { fetchImpl })
      expect(result).toMatchObject({ ok: false, code })
    }
  })

  it('network failure ⇒ endpoint_unreachable; abort ⇒ timeout', async () => {
    const failing = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    const netResult = await runProbe({ target: 'high' as const }, stored, {
      fetchImpl: failing,
    })
    expect(netResult).toMatchObject({ ok: false, code: 'endpoint_unreachable' })

    const aborting = (async () => {
      const err = new Error('operation timed out')
      err.name = 'TimeoutError'
      throw err
    }) as unknown as typeof fetch
    const timeoutResult = await runProbe({ target: 'high' as const }, stored, {
      fetchImpl: aborting,
    })
    expect(timeoutResult).toMatchObject({ ok: false, code: 'timeout' })
  })

  it('an unconfigured lane with no candidate ⇒ config_missing without any fetch', async () => {
    const { calls, fetchImpl } = mockFetch(() => modelsResponse())
    const result = await runProbe({ target: 'low' as const }, stored, { fetchImpl })
    expect(result).toMatchObject({ ok: false, code: 'config_missing' })
    expect(calls).toHaveLength(0)
  })
})

describe('ComfyUI probes', () => {
  it('GETs {baseUrl}/system_stats and reports the version', async () => {
    const { calls, fetchImpl } = mockFetch(
      () => new Response(JSON.stringify({ system: { comfyui_version: '0.3.1' } }), { status: 200 }),
    )
    const result = await runProbe({ target: 'comfyui' as const }, stored, { fetchImpl })
    expect(result).toMatchObject({ ok: true, detail: 'ComfyUI 0.3.1' })
    expect(calls[0]?.url).toBe('http://comfy.example/system_stats')
  })

  it('candidate comfyui overrides stored; an omitted section falls back to stored', async () => {
    const { calls, fetchImpl } = mockFetch(() => new Response('{}', { status: 200 }))
    const req = {
      target: 'comfyui' as const,
      candidate: { comfyui: { baseUrl: 'http://candidate.example' } },
    }
    await runProbe(req, stored, { fetchImpl })
    expect(calls[0]?.url).toBe('http://candidate.example/system_stats')
  })

  it('an explicitly cleared comfyui section ⇒ config_missing without any fetch', async () => {
    const { calls, fetchImpl } = mockFetch(() => new Response('{}', { status: 200 }))
    const result = await runProbe(
      { target: 'comfyui' as const, candidate: { comfyui: null } },
      stored,
      { fetchImpl },
    )
    expect(result).toMatchObject({ ok: false, code: 'config_missing' })
    expect(calls).toHaveLength(0)
  })

  it('unconfigured comfy ⇒ config_missing', async () => {
    const bare = AppConfig.parse({})
    const { fetchImpl } = mockFetch(() => new Response('{}', { status: 200 }))
    const result = await runProbe({ target: 'comfyui' as const }, bare, { fetchImpl })
    expect(result).toMatchObject({ ok: false, code: 'config_missing' })
  })
})
