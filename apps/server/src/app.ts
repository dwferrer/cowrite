import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { HealthResponse } from '@cowrite/shared'
import fastifyStatic from '@fastify/static'
import Fastify from 'fastify'

const VERSION = '0.0.1'

export function buildApp() {
  const app = Fastify({ logger: false })

  app.get('/api/health', async (): Promise<HealthResponse> => {
    return { status: 'ok', app: 'cowrite', version: VERSION }
  })

  // Serve the built web app when present (production / packaged mode).
  // In development the Vite dev server proxies /api to us instead.
  const webDist = path.resolve(fileURLToPath(import.meta.url), '../../../web/dist')
  if (existsSync(webDist)) {
    app.register(fastifyStatic, { root: webDist })
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) {
        reply.code(404).send({ error: { code: 'not_found', message: 'Unknown API route' } })
      } else {
        reply.sendFile('index.html')
      }
    })
  }

  return app
}
