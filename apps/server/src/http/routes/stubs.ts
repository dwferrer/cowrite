import { api } from '@cowrite/shared'
import { NotImplementedError } from '../../storage/service.js'
import type { RouteApp } from './shared.js'

/**
 * Registered-but-stubbed routes (docs/03-api.md §6.2 note): consolidation controls
 * (Stage 4) and illustration health (Stage 5, 08). The task/run/proposal routes went
 * live with the Stage-3 harness (src/harness/routes.ts); the context-engine routes with
 * 06 (src/context/routes.ts). Routes exist NOW — with the shared schemas — so the
 * registry⇄route contract test and the typed client wrapper stay total; handlers 501
 * until their subsystems land. `POST /tasks/estimate` and section-span routes are M2 —
 * deliberately absent.
 */

function notImplemented(what: string): () => Promise<never> {
  return async () => {
    throw new NotImplementedError(what)
  }
}

export function registerStubRoutes(app: RouteApp): void {
  // ---- consolidation controls (§3.8; Stage 4) ----
  app.route({
    method: 'POST',
    url: '/api/works/:w/consolidate',
    schema: { response: { 202: api.consolidateNow.res } },
    handler: notImplemented('POST /consolidate'),
  })
  app.route({
    method: 'POST',
    url: '/api/works/:w/consolidations/:undoToken/undo',
    handler: notImplemented('POST /consolidations/:undoToken/undo'),
  })

  // ---- illustration health (§3.12; Stage 5 — 08 owns the report) ----
  app.route({
    method: 'GET',
    url: '/api/illustration/health',
    schema: { response: { 200: api.illustrationHealth.res } },
    handler: notImplemented('GET /api/illustration/health'),
  })
}
