import { api } from '@cowrite/shared'
import { NotImplementedError } from '../../storage/service.js'
import type { RouteApp } from './shared.js'

/**
 * Registered-but-stubbed routes (docs/03-api.md §6.2 note): illustration health
 * (Stage 5, 08). The task/run/proposal routes went live with the Stage-3 harness
 * (src/harness/routes.ts); the context-engine routes with 06 (src/context/routes.ts);
 * the consolidation controls with the Stage-4 scheduler (harness/routes.ts). Routes
 * exist NOW — with the shared schemas — so the registry⇄route contract test and the
 * typed client wrapper stay total; handlers 501 until their subsystems land.
 * `POST /tasks/estimate` and section-span routes are M2 — deliberately absent.
 */

function notImplemented(what: string): () => Promise<never> {
  return async () => {
    throw new NotImplementedError(what)
  }
}

export function registerStubRoutes(app: RouteApp): void {
  // ---- illustration health (§3.12; Stage 5 — 08 owns the report) ----
  app.route({
    method: 'GET',
    url: '/api/illustration/health',
    schema: { response: { 200: api.illustrationHealth.res } },
    handler: notImplemented('GET /api/illustration/health'),
  })
}
