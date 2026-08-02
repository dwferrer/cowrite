import { type AppConfig, api } from '@cowrite/shared'
import Fastify, { type FastifyPluginAsync } from 'fastify'
import { registerEventsRoute } from '../events/route.js'
import { registerErrorHandler } from './errors.js'
import { registerHostGuard } from './hostGuard.js'
import { defaultWebDist, registerStatic } from './static.js'
import type { WorkRegistry } from './workRegistry.js'
import { useZod, type ZodApp } from './zod.js'

/**
 * `buildApp(deps)` — the pure, injectable Fastify composition (docs/03-api.md §5): Zod
 * validator + serializer compilers, the §7 global error handler, the §5.4 host guard,
 * body parsers (2 MB JSON, 10 MB raw `image/png`), `X-Content-Type-Options: nosniff`,
 * the health route, the per-work SSE stream, injected subsystem route plugins (config,
 * resources, tasks — each owns its registration), and static web serving with the SPA
 * fallback. No CORS, no compression, no auth, no rate limiting (§5.3 non-goals).
 */

export const JSON_BODY_LIMIT = 2 * 1024 * 1024
export const PNG_BODY_LIMIT = 10 * 1024 * 1024

/** The slice of the config subsystem's ConfigService that the HTTP core needs. */
export interface ConfigLike {
  current(): AppConfig
}

export interface BuildAppDeps {
  config: ConfigLike
  works: WorkRegistry
  version: string
  /**
   * Route plugins owned by other subsystems (config routes §3.12, resource routes §3.1–
   * §3.11) — the composition root (index.ts / deps.ts) injects them so this module never
   * hard-depends on files it does not own.
   */
  plugins?: FastifyPluginAsync[]
  /** Web dist override: undefined = the real apps/web/dist, null = force-missing (tests). */
  webDist?: string | null
}

export function buildApp(deps: BuildAppDeps): ZodApp {
  const app = useZod(Fastify({ logger: false, bodyLimit: JSON_BODY_LIMIT }))

  registerErrorHandler(app)
  registerHostGuard(app, () => {
    const { host, allowedHosts } = deps.config.current().server
    return { host, allowedHosts }
  })

  app.addHook('onSend', (req, reply, payload, done) => {
    reply.header('x-content-type-options', 'nosniff')
    // API responses are live state and must never be served from an HTTP cache. Routes
    // that opt into their own policy keep it: images set `immutable` (they are content-
    // addressed behind ?v=), and the hijacked SSE stream writes its own head.
    if (req.url.startsWith('/api/') && reply.getHeader('cache-control') === undefined) {
      reply.header('cache-control', 'no-store')
    }
    done(null, payload)
  })

  // Raw PNG uploads (§3.5, §3.10) — parsed as a buffer with their own 10 MB cap.
  app.addContentTypeParser(
    'image/png',
    { parseAs: 'buffer', bodyLimit: PNG_BODY_LIMIT },
    (_req, body, done) => {
      done(null, body)
    },
  )

  const startedAt = Date.now()
  app.route({
    method: 'GET',
    url: '/api/health',
    schema: { response: { 200: api.health.res } },
    handler: async () => ({
      ok: true as const,
      version: deps.version,
      uptime: (Date.now() - startedAt) / 1000,
    }),
  })

  registerEventsRoute(app, deps.works)

  for (const plugin of deps.plugins ?? []) {
    app.register(plugin)
  }

  registerStatic(app, deps.webDist === undefined ? defaultWebDist() : deps.webDist)

  return app
}
