import { api } from '@cowrite/shared'
import { NotImplementedError } from '../../storage/service.js'
import type { RouteApp } from './shared.js'

/**
 * Registered-but-stubbed routes (docs/03-api.md §6.2 note): tasks + runs (Stage 3, 05),
 * consolidation controls (Stage 4), context engine (Stage 3/06), illustration health
 * (Stage 5, 08). Routes exist NOW — with the shared schemas — so the registry⇄route
 * contract test and the typed client wrapper stay total; handlers 501 until their
 * subsystems land. Request bodies are still validated (a malformed TaskSpec 400s before
 * the 501). `POST /tasks/estimate` and section-span routes are M2 — deliberately absent.
 */

function notImplemented(what: string): () => Promise<never> {
  return async () => {
    throw new NotImplementedError(what)
  }
}

export function registerStubRoutes(app: RouteApp): void {
  // ---- tasks (§3.7; Stage 3 — the harness owns handler semantics) ----
  app.route({
    method: 'POST',
    url: '/api/works/:w/tasks',
    schema: { body: api.createTask.body, response: { 202: api.createTask.res } },
    handler: notImplemented('POST /tasks'),
  })
  app.route({
    method: 'GET',
    url: '/api/works/:w/tasks',
    schema: { response: { 200: api.listTasks.res } },
    handler: notImplemented('GET /tasks'),
  })
  app.route({
    method: 'GET',
    url: '/api/works/:w/tasks/:t',
    schema: { response: { 200: api.getTask.res } },
    handler: notImplemented('GET /tasks/:t'),
  })
  app.route({
    method: 'POST',
    url: '/api/works/:w/tasks/:t/cancel',
    schema: { response: { 202: api.cancelTask.res } },
    handler: notImplemented('POST /tasks/:t/cancel'),
  })
  app.route({
    method: 'POST',
    url: '/api/works/:w/tasks/:t/proposal/apply',
    schema: { response: { 200: api.applyProposal.res } },
    handler: notImplemented('POST /tasks/:t/proposal/apply'),
  })
  app.route({
    method: 'POST',
    url: '/api/works/:w/tasks/:t/proposal/discard',
    handler: notImplemented('POST /tasks/:t/proposal/discard'),
  })

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

  // ---- runs (§3.9; Stage 3) ----
  app.route({
    method: 'GET',
    url: '/api/works/:w/runs/:r',
    schema: { response: { 200: api.getRun.res } },
    handler: notImplemented('GET /runs/:r'),
  })
  app.route({
    method: 'GET',
    url: '/api/works/:w/runs',
    schema: { querystring: api.listRuns.query, response: { 200: api.listRuns.res } },
    handler: notImplemented('GET /runs'),
  })

  // ---- context engine (§3.11; Stage 3 — 06 owns handlers) ----
  app.route({
    method: 'GET',
    url: '/api/works/:w/context/candidates',
    schema: { response: { 200: api.getContextCandidates.res } },
    handler: notImplemented('GET /context/candidates'),
  })
  app.route({
    method: 'POST',
    url: '/api/works/:w/context/preview',
    schema: { body: api.previewContext.body, response: { 200: api.previewContext.res } },
    handler: notImplemented('POST /context/preview'),
  })
  app.route({
    method: 'POST',
    url: '/api/works/:w/context/reset',
    handler: notImplemented('POST /context/reset'),
  })

  // ---- illustration health (§3.12; Stage 5 — 08 owns the report) ----
  app.route({
    method: 'GET',
    url: '/api/illustration/health',
    schema: { response: { 200: api.illustrationHealth.res } },
    handler: notImplemented('GET /api/illustration/health'),
  })
}
