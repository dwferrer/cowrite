import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fastifyStatic from '@fastify/static'
import type { FastifyInstance } from 'fastify'
import { errorBody } from './errors.js'

/**
 * Static web-app serving (docs/03-api.md §5.3, §10.1): `apps/web/dist` behind
 * `@fastify/static` with `wildcard: false` and an explicit SPA fallback for non-`/api`
 * GETs (deep links like `/w/:id/runs/:rid` must resolve to `index.html`). `index.html`
 * is served `no-cache`; hashed Vite assets (under `assets/`) are `immutable`. When the
 * dist is missing (fresh clone, no build) the server stays fully live for the API and
 * serves a self-contained fallback page with build instructions instead — a
 * dev-friendliness measure, never a crash.
 */

export function defaultWebDist(): string {
  // src/http/ → src → server → apps, then into web/dist
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'web', 'dist')
}

const FALLBACK_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cowrite — web app not built</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 4rem auto; padding: 0 1rem; }
  code { background: #eee; padding: 0.15rem 0.35rem; border-radius: 4px; }
</style>
</head>
<body>
<h1>Cowrite</h1>
<p>The server is running, but the web app has not been built yet.</p>
<p>Run <code>pnpm build</code> in the repository root, then restart (or just reload this page
after the build finishes).</p>
<p>The API is fully live in the meantime — <a href="/api/health">/api/health</a>.</p>
</body>
</html>
`

/**
 * Register static serving + the app-wide not-found handler (API 404 envelope / SPA
 * fallback / missing-dist page). Must be called on the ROOT instance — it owns
 * `setNotFoundHandler`. `webDist: null` forces missing-dist mode (tests).
 */
export function registerStatic(app: FastifyInstance, webDist: string | null): void {
  const hasDist = webDist !== null && existsSync(path.join(webDist, 'index.html'))

  if (hasDist) {
    app.register(fastifyStatic, {
      root: webDist,
      wildcard: false,
      index: 'index.html',
      cacheControl: false,
      setHeaders: (res, filePath) => {
        const parts = filePath.split(/[\\/]/)
        if (parts.includes('assets') && path.basename(filePath) !== 'index.html') {
          res.setHeader('cache-control', 'public, max-age=31536000, immutable')
        } else {
          res.setHeader('cache-control', 'no-cache')
        }
      },
    })
  }

  app.setNotFoundHandler((req, reply) => {
    const isApi = req.url === '/api' || req.url.startsWith('/api/')
    if (isApi || (req.method !== 'GET' && req.method !== 'HEAD')) {
      return reply.status(404).send(errorBody('not_found', `no route ${req.method} ${req.url}`))
    }
    if (hasDist) {
      // SPA fallback; setHeaders above serves index.html no-cache.
      return reply.sendFile('index.html')
    }
    return reply
      .status(200)
      .header('cache-control', 'no-cache')
      .type('text/html; charset=utf-8')
      .send(FALLBACK_PAGE)
  })
}
