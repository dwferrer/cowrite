import { api } from '@cowrite/shared'
import { openWork, type ResourceDeps, type RouteApp } from './shared.js'

/**
 * The editing signal (docs/03-api.md §3.4): the client declares which snippet has an
 * open editor so consolidation never freezes a passage out from under the user. `null`
 * clears it; the registry also clears it server-side when the work's SSE subscriber
 * count drops to zero, so a vanished tab can't pin consolidation forever. The signal is
 * in-memory (not a storage write), so it works on read-only opens too.
 */

export function registerEditingRoutes(app: RouteApp, deps: ResourceDeps): void {
  app.route({
    method: 'POST',
    url: '/api/works/:w/editing',
    schema: { body: api.setEditing.body },
    handler: async (req, reply) => {
      const { handle } = await openWork(deps, req)
      handle.setEditingSnippet(req.body.snippetId)
      return reply.code(204).send()
    },
  })
}
