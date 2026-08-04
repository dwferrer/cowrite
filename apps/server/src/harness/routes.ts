import { api, RunArtifact } from '@cowrite/shared'
import { AppError } from '../http/errors.js'
import { openWork, param, type ResourceDeps, type RouteApp } from '../http/routes/shared.js'
import type { AgentHarness } from './service.js'

/**
 * The harness-owned HTTP surface (docs/05-agents.md §8; docs/03-api.md §3.7, §3.9):
 * tasks (submit / list / get / cancel), the proposal resolution routes, and the runs
 * provenance endpoints. Registered by the API layer's resource-route plugin; replaces
 * the Stage-2 501 stubs. Schemas are the shared registry's — identity-equal by
 * construction (the contract test enforces it).
 */

const ARTIFACT_KINDS = new Set<string>(RunArtifact.shape.kind.options)

/** `artifact=<kind>:<id>` (03 §3.9); 400 on an unknown kind or a shapeless value. */
function parseArtifactParam(raw: string): { kind: RunArtifact['kind']; id: string } {
  const sep = raw.indexOf(':')
  const kind = sep === -1 ? '' : raw.slice(0, sep)
  const id = sep === -1 ? '' : raw.slice(sep + 1)
  if (!ARTIFACT_KINDS.has(kind) || id === '') {
    throw new AppError('validation', `artifact must be "<kind>:<id>"; got '${raw}'`)
  }
  return { kind: kind as RunArtifact['kind'], id }
}

export function registerTaskRoutes(app: RouteApp, deps: ResourceDeps, harness: AgentHarness): void {
  // ---- tasks (03 §3.7) -------------------------------------------------------------
  app.route({
    method: 'POST',
    url: '/api/works/:w/tasks',
    schema: { body: api.createTask.body, response: { 202: api.createTask.res } },
    handler: async (req, reply) => {
      const open = await openWork(deps, req)
      const task = await harness.submit(open, req.body)
      return reply.status(202).send(task)
    },
  })

  app.route({
    method: 'GET',
    url: '/api/works/:w/tasks',
    schema: { response: { 200: api.listTasks.res } },
    handler: async (req) => harness.list(await openWork(deps, req)),
  })

  app.route({
    method: 'GET',
    url: '/api/works/:w/tasks/:t',
    schema: { response: { 200: api.getTask.res } },
    handler: async (req) => {
      const task = harness.get(await openWork(deps, req), param(req, 't'))
      if (task === null)
        throw new AppError('not_found', `no task '${param(req, 't')}' in this process`)
      return task
    },
  })

  app.route({
    method: 'POST',
    url: '/api/works/:w/tasks/:t/cancel',
    schema: { response: { 202: api.cancelTask.res } },
    handler: async (req, reply) => {
      const task = harness.cancel(await openWork(deps, req), param(req, 't'))
      return reply.status(202).send(task)
    },
  })

  // ---- proposal resolution (03 §3.7; 05 §5.1/§6.5) ---------------------------------
  app.route({
    method: 'POST',
    url: '/api/works/:w/tasks/:t/proposal/apply',
    schema: { response: { 200: api.applyProposal.res } },
    handler: async (req) => harness.applyProposal(await openWork(deps, req), param(req, 't')),
  })

  app.route({
    method: 'POST',
    url: '/api/works/:w/tasks/:t/proposal/discard',
    handler: async (req, reply) => {
      await harness.discardProposal(await openWork(deps, req), param(req, 't'))
      return reply.status(204).send()
    },
  })

  // ---- consolidation controls (03 §3.8; 05 §6.2 scheduler) -------------------------
  app.route({
    method: 'POST',
    url: '/api/works/:w/consolidate',
    schema: { response: { 202: api.consolidateNow.res } },
    handler: async (req, reply) => {
      const open = await openWork(deps, req)
      const result = await harness.consolidateNow(open)
      // Nothing-eligible is a 202 union variant, not an error (03 §3.8): the frontier
      // simply sits inside the active window. 409 stays for busy/closing works.
      return reply.status(202).send(
        result.kind === 'task'
          ? result.task
          : result.kind === 'applied'
            ? {
                applied: true as const,
                sectionIds: result.sectionIds,
                undoToken: result.undoToken,
                undoDeadline: result.undoDeadline,
              }
            : { applied: false as const, reason: 'nothing-eligible' as const },
      )
    },
  })

  app.route({
    method: 'POST',
    url: '/api/works/:w/consolidations/:undoToken/undo',
    handler: async (req, reply) => {
      const open = await openWork(deps, req)
      // Cancel-by-target runs BEFORE storage touches directories (02 §6.4); an
      // unknown/expired token surfaces as the storage layer's typed 409.
      await harness.undoWorkConsolidation(open, param(req, 'undoToken'))
      return reply.status(204).send()
    },
  })

  // ---- runs / provenance (03 §3.9) -------------------------------------------------
  app.route({
    method: 'GET',
    url: '/api/works/:w/runs/:r',
    schema: { response: { 200: api.getRun.res } },
    handler: async (req) => {
      const open = await openWork(deps, req)
      return open.handle.readRun(param(req, 'r')) // RunNotFoundError → 404 envelope
    },
  })

  app.route({
    method: 'GET',
    url: '/api/works/:w/runs',
    schema: { querystring: api.listRuns.query, response: { 200: api.listRuns.res } },
    handler: async (req) => {
      const open = await openWork(deps, req)
      const { kind, id } = parseArtifactParam(req.query.artifact)
      // RunByArtifact extends RunSummary; the serializer strips the join-only columns.
      return open.handle.queryRunsByArtifact(kind, id).slice(0, req.query.limit)
    },
  })
}
