import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AppConfig, api, type RouteDef } from '@cowrite/shared'
import type { FastifySchema, HTTPMethods } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../app.js'
import { configRoutes } from '../../config/routes.js'
import type { ConfigService } from '../../config/service.js'
import { createStorage } from '../../storage/service.js'
import { WorkRegistry } from '../workRegistry.js'
import type { ZodApp } from '../zod.js'
import { resourceRoutes } from './index.js'

/**
 * The drift fence (docs/03-api.md §5.2, §12): walk Fastify's route table and assert it
 * matches the shared route registry in BOTH directions — every registered /api route has
 * a registry entry with identity-equal schemas, and every registry entry has a
 * registered route. Patterns are compared with param names normalized (`:w` vs `:s` is
 * spelling, not structure).
 */

/** Registry entries whose routes are deliberately absent in Stage 2 (M2 scope). */
const M2_UNREGISTERED = new Set<keyof typeof api>(['estimateTask'])

/** Registered synchronously inside buildApp — before a test can hook onRoute — so their
 *  presence is asserted via hasRoute below. health's schema IS api.health.res by
 *  construction (app.ts); events is raw SSE with no schemas. */
const BUILDAPP_OWNED = new Set<keyof typeof api>(['health', 'events'])

/** The config plugin validates bodies manually with the shared schemas (config/routes.ts
 *  header) — existence is contract-checked here; schema identity is its own concern. */
const MANUAL_PARSE = new Set<keyof typeof api>([
  'getConfig',
  'putConfig',
  'testConfig',
  'reloadConfig',
])

function normalizeRoutePattern(url: string): string {
  return url
    .split('/')
    .map((seg) => (seg.startsWith(':') ? ':_' : seg))
    .join('/')
}

function registryPattern(def: RouteDef): string {
  const raw = (def.path as (...ids: string[]) => string)('__p0__', '__p1__', '__p2__')
  return raw
    .split('/')
    .map((seg) => (seg.startsWith('__p') ? ':_' : seg))
    .join('/')
}

interface CollectedRoute {
  method: string
  url: string
  pattern: string
  schema: FastifySchema | undefined
}

let dataDir: string
let works: WorkRegistry
let app: ZodApp
const collected: CollectedRoute[] = []

beforeAll(async () => {
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cowrite-contract-'))
  const storage = createStorage(dataDir)
  works = new WorkRegistry(storage)
  app = buildApp({
    config: { current: () => AppConfig.parse({}) },
    works,
    version: '0.0.1-test',
    webDist: null,
    plugins: [
      resourceRoutes({ works, storage }),
      // The config plugin, registered exactly as the composition root would; its service
      // is never invoked here — this test only walks the route table.
      async (instance) => configRoutes(instance, { service: {} as unknown as ConfigService }),
    ],
  })
  app.addHook('onRoute', (route) => {
    const methods: HTTPMethods[] = Array.isArray(route.method) ? route.method : [route.method]
    for (const method of methods) {
      if (method === 'HEAD' || method === 'OPTIONS') continue
      if (!route.url.startsWith('/api')) continue
      collected.push({
        method,
        url: route.url,
        pattern: normalizeRoutePattern(route.url),
        schema: route.schema,
      })
    }
  })
  await app.ready()
})

afterAll(async () => {
  await works.closeAll()
  await app.close()
  await fsp.rm(dataDir, { recursive: true, force: true })
})

const entries = Object.entries(api) as Array<[keyof typeof api, RouteDef]>

describe('registry ⇄ route table', () => {
  it('registers a route for every registry entry (minus the M2 skips)', () => {
    for (const [name, def] of entries) {
      if (M2_UNREGISTERED.has(name)) continue
      if (BUILDAPP_OWNED.has(name)) continue
      const match = collected.find(
        (r) => r.method === def.method && r.pattern === registryPattern(def),
      )
      expect(
        match,
        `registry entry '${name}' (${def.method} ${registryPattern(def)})`,
      ).toBeDefined()
    }
  })

  it('buildApp itself registers health and the SSE stream', () => {
    expect(app.hasRoute({ method: 'GET', url: '/api/health' })).toBe(true)
    expect(app.hasRoute({ method: 'GET', url: '/api/works/:w/events' })).toBe(true)
  })

  it('every registered /api route corresponds to exactly one registry entry', () => {
    const byPattern = new Map<string, keyof typeof api>()
    for (const [name, def] of entries) {
      const key = `${def.method} ${registryPattern(def)}`
      expect(byPattern.has(key), `duplicate registry pattern ${key}`).toBe(false)
      byPattern.set(key, name)
    }
    for (const route of collected) {
      const name = byPattern.get(`${route.method} ${route.pattern}`)
      expect(name, `route ${route.method} ${route.url} has no registry entry`).toBeDefined()
    }
  })

  it('route schemas are identity-equal to the shared registry exports', () => {
    const byPattern = new Map(
      entries.map(([name, def]) => [`${def.method} ${registryPattern(def)}`, { name, def }]),
    )
    let checked = 0
    for (const route of collected) {
      const entry = byPattern.get(`${route.method} ${route.pattern}`)
      if (entry === undefined) continue // covered by the direction test above
      if (MANUAL_PARSE.has(entry.name)) continue
      const { def, name } = entry
      if (def.body !== undefined) {
        expect(route.schema?.body, `body schema of '${name}'`).toBe(def.body)
        checked++
      }
      if (def.query !== undefined) {
        expect(route.schema?.querystring, `query schema of '${name}'`).toBe(def.query)
        checked++
      }
      if (def.res !== undefined) {
        const status = def.status ?? 200
        const responses = route.schema?.response as Record<number, unknown> | undefined
        expect(responses?.[status], `response schema of '${name}' (status ${status})`).toBe(def.res)
        checked++
      }
    }
    // sanity: the identity walk actually covered a meaningful slice of the surface
    expect(checked).toBeGreaterThan(30)
  })

  it('the M2 skip list stays honest: estimateTask has NO registered route', () => {
    const def = api.estimateTask
    const match = collected.find(
      (r) => r.method === def.method && r.pattern === registryPattern(def),
    )
    expect(match).toBeUndefined()
  })
})
