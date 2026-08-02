import { ApiErrorBody, AppConfig } from '@cowrite/shared'
import type { FastifyPluginAsync } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from './app.js'
import type { WorkRegistry } from './workRegistry.js'
import type { ZodApp } from './zod.js'

/** Host-header allowlist + Origin check matrix (docs/03-api.md §5.4, §12). */

const echoRoutes: FastifyPluginAsync = async (app) => {
  app.post('/api/echo', async () => ({ ok: true }))
}

function appWith(server: { host?: string; allowedHosts?: string[] }): ZodApp {
  const config = AppConfig.parse({ server })
  // the guard matrix never touches works — an empty registry stub is enough
  const works = {} as WorkRegistry
  return buildApp({
    config: { current: () => config },
    works,
    version: 'test',
    webDist: null,
    plugins: [echoRoutes],
  })
}

let app: ZodApp

beforeEach(() => {
  app = appWith({ allowedHosts: ['cowrite.lan'] })
})

afterEach(async () => {
  await app.close()
})

describe('Host header allowlist', () => {
  it.each([
    ['127.0.0.1:2697'],
    ['localhost:2697'],
    ['LOCALHOST:2697'],
    ['[::1]:2697'],
    ['cowrite.lan'],
  ])('allows %s', async (host) => {
    const res = await app.inject({ method: 'GET', url: '/api/health', headers: { host } })
    expect(res.statusCode).toBe(200)
  })

  it.each([
    ['evil.example:2697'],
    ['127.0.0.2:2697'],
    ['0.0.0.0:2697'],
  ])('rejects %s with 403 forbidden_host', async (host) => {
    const res = await app.inject({ method: 'GET', url: '/api/health', headers: { host } })
    expect(res.statusCode).toBe(403)
    expect(ApiErrorBody.parse(res.json()).error.code).toBe('forbidden_host')
  })

  it('allows a specific non-loopback server.host but never a wildcard bind address', async () => {
    const lanApp = appWith({ host: '192.168.1.50' })
    const ok = await lanApp.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: '192.168.1.50:2697' },
    })
    expect(ok.statusCode).toBe(200)
    await lanApp.close()

    const wildcardApp = appWith({ host: '0.0.0.0' })
    const rejected = await wildcardApp.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: '0.0.0.0:2697' },
    })
    expect(rejected.statusCode).toBe(403)
    await wildcardApp.close()
  })
})

describe('Origin check on non-GET', () => {
  it('passes the dev-mode Origin http://localhost:5173', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/echo',
      headers: { host: '127.0.0.1:2697', origin: 'http://localhost:5173' },
      payload: {},
    })
    expect(res.statusCode).toBe(200)
  })

  it('rejects a foreign Origin on POST with 403 forbidden_host', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/echo',
      headers: { host: '127.0.0.1:2697', origin: 'https://evil.example' },
      payload: {},
    })
    expect(res.statusCode).toBe(403)
    expect(ApiErrorBody.parse(res.json()).error.code).toBe('forbidden_host')
  })

  it('rejects Origin: null on POST', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/echo',
      headers: { host: '127.0.0.1:2697', origin: 'null' },
      payload: {},
    })
    expect(res.statusCode).toBe(403)
  })

  it('allows an allowedHosts Origin on POST', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/echo',
      headers: { host: '127.0.0.1:2697', origin: 'http://cowrite.lan:2697' },
      payload: {},
    })
    expect(res.statusCode).toBe(200)
  })

  it('leaves GET requests with a foreign Origin alone (SSE and reads are unaffected)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: '127.0.0.1:2697', origin: 'https://evil.example' },
    })
    expect(res.statusCode).toBe(200)
  })

  it('allows a plain non-GET without any Origin header', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/echo',
      headers: { host: '127.0.0.1:2697' },
      payload: {},
    })
    expect(res.statusCode).toBe(200)
  })
})
