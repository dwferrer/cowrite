import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AppConfig, ConfigWriteRes, ProbeResult, PublicConfig } from '@cowrite/shared'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../http/app.js'
import { registerErrorHandler } from '../http/errors.js'
import type { WorkRegistry } from '../http/workRegistry.js'
import { loadConfig } from './load.js'
import { configRoutes } from './routes.js'
import { ConfigService } from './service.js'

let dir: string
let home: string
let configPath: string
let app: FastifyInstance

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cowrite-cfgroutes-'))
  home = path.join(dir, 'home')
  await fsp.mkdir(home, { recursive: true })
  configPath = path.join(dir, 'config.jsonc')
})

afterEach(async () => {
  if (app) await app.close()
  await fsp.rm(dir, { recursive: true, force: true })
})

async function makeService(fileText: string): Promise<ConfigService> {
  await fsp.writeFile(configPath, fileText, 'utf8')
  const env = { COWRITE_CONFIG: configPath }
  const loaded = await loadConfig({ env, homedir: home })
  if (!loaded.ok) throw new Error('load failed')
  return new ConfigService(loaded, { env, homedir: home })
}

async function buildTestApp(fileText: string, fetchImpl?: typeof fetch): Promise<FastifyInstance> {
  const service = await makeService(fileText)
  app = Fastify({ logger: false })
  // The PRODUCTION §7 error handler — a stand-in here once masked a duplicate-AppError
  // class whose instances the real handler's `instanceof` check never matched (⇒ 500s).
  registerErrorHandler(app)
  await app.register(configRoutes, { service, probeDeps: fetchImpl ? { fetchImpl } : undefined })
  return app
}

const FILE = `{
  "models": {
    "high": { "baseUrl": "http://h.example/v1", "apiKey": "sk-route", "model": "big" }
  }
}`

describe('config routes', () => {
  it('GET /api/config returns a redacted PublicConfig', async () => {
    const app = await buildTestApp(FILE)
    const res = await app.inject({ method: 'GET', url: '/api/config' })
    expect(res.statusCode).toBe(200)
    expect(res.body).not.toContain('sk-route')
    const pub = PublicConfig.parse(res.json())
    expect(pub.models.high?.apiKey).toEqual({ set: true })
    expect(pub.setup.highConfigured).toBe(true)
  })

  it('PUT /api/config full-replaces, persists, and returns ConfigWriteRes', async () => {
    const app = await buildTestApp(FILE)
    const current = PublicConfig.parse(
      (await app.inject({ method: 'GET', url: '/api/config' })).json(),
    )
    const body = {
      ...current,
      models: { high: { ...current.models.high, apiKey: null }, low: null },
      server: { ...current.server, port: 4400 },
    }
    const res = await app.inject({ method: 'PUT', url: '/api/config', payload: body })
    expect(res.statusCode).toBe(200)
    const parsed = ConfigWriteRes.parse(res.json())
    expect(parsed.restartRequired).toEqual(['server.port'])
    expect(parsed.config.server.port).toBe(4400)
    expect(parsed.config.models.high?.apiKey).toEqual({ set: true }) // null kept the stored key
    expect(await fsp.readFile(configPath, 'utf8')).toContain('sk-route')
  })

  it('PUT with an invalid body maps to the 400 validation envelope', async () => {
    const app = await buildTestApp(FILE)
    const res = await app.inject({
      method: 'PUT',
      url: '/api/config',
      payload: { server: { port: 'not-a-port' } },
    })
    expect(res.statusCode).toBe(400)
    const body = res.json() as { error: { code: string; details?: { issues?: unknown[] } } }
    expect(body.error.code).toBe('validation')
    expect(Array.isArray(body.error.details?.issues)).toBe(true)
  })

  it('POST /api/config/test probes with the candidate and returns ProbeResult', async () => {
    const urls: string[] = []
    const fetchImpl = (async (input: string | URL | Request) => {
      urls.push(String(input))
      return new Response(JSON.stringify({ data: [{ id: 'big' }] }), { status: 200 })
    }) as typeof fetch
    const app = await buildTestApp(FILE, fetchImpl)
    const res = await app.inject({
      method: 'POST',
      url: '/api/config/test',
      payload: {
        target: 'high',
        candidate: {
          models: { high: { baseUrl: 'http://cand.example/v1', apiKey: null, model: 'big' } },
        },
      },
    })
    expect(res.statusCode).toBe(200)
    const probe = ProbeResult.parse(res.json())
    expect(probe.ok).toBe(true)
    // keyed probes fire /models AND the 1-token auth check (public listings prove nothing)
    expect(urls).toEqual([
      'http://cand.example/v1/models',
      'http://cand.example/v1/chat/completions',
    ])
  })

  it('a candidate that explicitly clears a lane gets config_missing, not the stored probe', async () => {
    const urls: string[] = []
    const fetchImpl = (async (input: string | URL | Request) => {
      urls.push(String(input))
      return new Response(JSON.stringify({ data: [{ id: 'big' }] }), { status: 200 })
    }) as typeof fetch
    const app = await buildTestApp(FILE, fetchImpl)
    const res = await app.inject({
      method: 'POST',
      url: '/api/config/test',
      payload: { target: 'high', candidate: { models: { high: null } } },
    })
    expect(res.statusCode).toBe(200)
    expect(ProbeResult.parse(res.json())).toMatchObject({ ok: false, code: 'config_missing' })
    expect(urls).toEqual([]) // nothing was probed
  })

  it('a failed probe is still a 200 ProbeResult, not an error envelope', async () => {
    const fetchImpl = (async () => new Response('no', { status: 401 })) as typeof fetch
    const app = await buildTestApp(FILE, fetchImpl)
    const res = await app.inject({
      method: 'POST',
      url: '/api/config/test',
      payload: { target: 'high' },
    })
    expect(res.statusCode).toBe(200)
    expect(ProbeResult.parse(res.json())).toMatchObject({ ok: false, code: 'auth' })
  })

  it('POST /api/config/reload re-reads the file from disk', async () => {
    const app = await buildTestApp(FILE)
    await fsp.writeFile(configPath, '{ "server": { "port": 4500 } }', 'utf8')
    const res = await app.inject({ method: 'POST', url: '/api/config/reload' })
    expect(res.statusCode).toBe(200)
    const parsed = ConfigWriteRes.parse(res.json())
    expect(parsed.config.server.port).toBe(4500)
    expect(parsed.restartRequired).toEqual(['server.port'])
  })

  it('reload of an invalid file maps to the validation envelope', async () => {
    const app = await buildTestApp(FILE)
    await fsp.writeFile(configPath, '{ "server": { "port": "nope" } }', 'utf8')
    const res = await app.inject({ method: 'POST', url: '/api/config/reload' })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { error: { code: string } }).error.code).toBe('validation')
  })
})

describe('config routes through the full production app', () => {
  it('PUT /api/config with an invalid body is the 400 validation envelope via buildApp', async () => {
    const service = await makeService(FILE)
    const full = buildApp({
      config: { current: () => AppConfig.parse({}) },
      works: {} as WorkRegistry,
      version: 'test',
      webDist: null,
      plugins: [
        async (instance) => {
          await instance.register(configRoutes, { service })
        },
      ],
    })
    try {
      const res = await full.inject({
        method: 'PUT',
        url: '/api/config',
        payload: { server: { port: 'not-a-port' } },
      })
      // Regression: with a duplicate local AppError class this surfaced as 500 'internal'.
      expect(res.statusCode).toBe(400)
      const body = res.json() as { error: { code: string; details?: { issues?: unknown[] } } }
      expect(body.error.code).toBe('validation')
      expect(Array.isArray(body.error.details?.issues)).toBe(true)
    } finally {
      await full.close()
    }
  })
})
