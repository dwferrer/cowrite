import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ApiErrorBody, AppConfig, HealthRes } from '@cowrite/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from './app.js'
import { WorkRegistry } from './http/workRegistry.js'
import type { ZodApp } from './http/zod.js'
import { createStorage } from './storage/service.js'

/** buildApp over real storage in a temp data dir (docs/03-api.md §12 route tests). */

let dataDir: string
let works: WorkRegistry
let app: ZodApp

const testConfig = AppConfig.parse({})

beforeEach(async () => {
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cowrite-app-'))
  works = new WorkRegistry(createStorage(dataDir))
  app = buildApp({
    config: { current: () => testConfig },
    works,
    version: '0.0.1-test',
    webDist: null,
  })
})

afterEach(async () => {
  await works.closeAll()
  await app.close()
  await fsp.rm(dataDir, { recursive: true, force: true })
})

describe('GET /api/health', () => {
  it('returns the shared {ok, version, uptime} shape', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' })
    expect(res.statusCode).toBe(200)
    const body = HealthRes.parse(res.json())
    expect(body.ok).toBe(true)
    expect(body.version).toBe('0.0.1-test')
    expect(body.uptime).toBeGreaterThanOrEqual(0)
  })

  it('sets X-Content-Type-Options: nosniff on responses', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' })
    expect(res.headers['x-content-type-options']).toBe('nosniff')
  })
})

describe('unknown routes', () => {
  it('serves the §7 envelope for unknown /api routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nope' })
    expect(res.statusCode).toBe(404)
    const body = ApiErrorBody.parse(res.json())
    expect(body.error.code).toBe('not_found')
  })

  it('serves the missing-dist fallback page for non-API GETs', async () => {
    const res = await app.inject({ method: 'GET', url: '/w/whatever' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.payload).toContain('pnpm build')
  })
})

describe('GET /api/works/:w/events', () => {
  it('404s with the envelope for an unknown work id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/works/01ARZ3NDEKTSV4RRFFQ69G5FAV/events',
    })
    expect(res.statusCode).toBe(404)
    expect(ApiErrorBody.parse(res.json()).error.code).toBe('not_found')
  })

  it('opens the stream with an SSE hello frame', async () => {
    const created = await works.createWork('Streaming Test')
    const res = await app.inject({
      method: 'GET',
      url: `/api/works/${created.meta.id}/events`,
      payloadAsStream: true,
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/event-stream')

    const stream = res.stream()
    const first = await new Promise<string>((resolve) => {
      stream.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8')))
    })
    expect(first).toContain('event: hello')
    expect(first).toMatch(/id: [0-9A-Z]{26}:0\n/)
    stream.destroy()
  })
})
