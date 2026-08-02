import { ApiErrorBody, AppConfig } from '@cowrite/shared'
import type { FastifyPluginAsync } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { SectionNotFoundError } from '../storage/sectionStore.js'
import { NotImplementedError, ReadOnlyError, WorkClosedError } from '../storage/service.js'
import { buildApp } from './app.js'
import { AppError } from './errors.js'
import type { WorkRegistry } from './workRegistry.js'
import type { ZodApp } from './zod.js'

/** Error envelope shapes (docs/03-api.md §7): every non-2xx JSON response is the envelope. */

const throwingRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/api/test/validated',
    { schema: { body: z.object({ n: z.number().int() }) } },
    async () => ({ ok: true }),
  )
  app.get(
    '/api/test/bad-dto',
    { schema: { response: { 200: z.object({ ok: z.literal(true) }) } } },
    // the serializer compiler must catch this off-contract response
    async () => ({ ok: false }) as unknown as { ok: true },
  )
  app.get('/api/test/app-error', async () => {
    throw new AppError('busy', 'interactive lane occupied', { runningTaskId: 'T1' })
  })
  app.get('/api/test/storage-not-found', async () => {
    throw new SectionNotFoundError('01ARZ3NDEKTSV4RRFFQ69G5FAV')
  })
  app.get('/api/test/readonly', async () => {
    throw new ReadOnlyError('some-work')
  })
  app.get('/api/test/closed', async () => {
    throw new WorkClosedError('some-work')
  })
  app.get('/api/test/not-implemented', async () => {
    throw new NotImplementedError('consolidation')
  })
  app.get('/api/test/boom', async () => {
    throw new Error('kaput')
  })
}

let app: ZodApp

beforeEach(() => {
  const config = AppConfig.parse({})
  app = buildApp({
    config: { current: () => config },
    works: {} as WorkRegistry,
    version: 'test',
    webDist: null,
    plugins: [throwingRoutes],
  })
})

afterEach(async () => {
  await app.close()
  vi.restoreAllMocks()
})

describe('the global error handler', () => {
  it('maps Zod validation failures to 400 validation with treeified issues', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/test/validated',
      payload: { n: 'not-a-number' },
    })
    expect(res.statusCode).toBe(400)
    const body = ApiErrorBody.parse(res.json())
    expect(body.error.code).toBe('validation')
    const details = body.error.details as { properties?: Record<string, { errors: string[] }> }
    expect(details.properties?.n?.errors.length).toBeGreaterThan(0)
  })

  it('passes AppError through the closed code→status table with details', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/test/app-error' })
    expect(res.statusCode).toBe(409)
    const body = ApiErrorBody.parse(res.json())
    expect(body.error.code).toBe('busy')
    expect(body.error.details).toEqual({ runningTaskId: 'T1' })
  })

  it('maps storage *NotFoundError to 404 not_found', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/test/storage-not-found' })
    expect(res.statusCode).toBe(404)
    expect(ApiErrorBody.parse(res.json()).error.code).toBe('not_found')
  })

  it('maps ReadOnlyError to 409 readonly', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/test/readonly' })
    expect(res.statusCode).toBe(409)
    expect(ApiErrorBody.parse(res.json()).error.code).toBe('readonly')
  })

  it('maps WorkClosedError to 409 conflict', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/test/closed' })
    expect(res.statusCode).toBe(409)
    expect(ApiErrorBody.parse(res.json()).error.code).toBe('conflict')
  })

  it('maps NotImplementedError to 501 not_implemented', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/test/not-implemented' })
    expect(res.statusCode).toBe(501)
    expect(ApiErrorBody.parse(res.json()).error.code).toBe('not_implemented')
  })

  it('turns unknown errors into 500 internal with a logged logRef ULID', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await app.inject({ method: 'GET', url: '/api/test/boom' })
    expect(res.statusCode).toBe(500)
    const body = ApiErrorBody.parse(res.json())
    expect(body.error.code).toBe('internal')
    const logRef = (body.error.details as { logRef?: string }).logRef
    expect(logRef).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    // the same ref is printed to the console so toast and log line can be matched
    expect(errorSpy.mock.calls.some((call) => String(call[0]).includes(logRef ?? ''))).toBe(true)
  })

  it('fails loudly (500 internal) when a handler returns an off-contract DTO', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await app.inject({ method: 'GET', url: '/api/test/bad-dto' })
    expect(res.statusCode).toBe(500)
    expect(ApiErrorBody.parse(res.json()).error.code).toBe('internal')
    expect(errorSpy).toHaveBeenCalled()
  })

  it('maps an oversized JSON body to 413 payload_too_large', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/test/validated',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ n: 1, pad: 'x'.repeat(2 * 1024 * 1024 + 16) }),
    })
    expect(res.statusCode).toBe(413)
    expect(ApiErrorBody.parse(res.json()).error.code).toBe('payload_too_large')
  })

  it('maps an unparsable JSON body to 400 validation', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/test/validated',
      headers: { 'content-type': 'application/json' },
      payload: '{nope',
    })
    expect(res.statusCode).toBe(400)
    expect(ApiErrorBody.parse(res.json()).error.code).toBe('validation')
  })
})
