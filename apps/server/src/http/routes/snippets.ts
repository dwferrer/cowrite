import { api, type SnippetDto } from '@cowrite/shared'
import { toSnippetDto } from '../../events/adapter.js'
import { keyBetween } from '../../storage/lib/orderKeys.js'
import type { WorkHandle } from '../../storage/service.js'
import { AppError } from '../errors.js'
import { openWork, param, type ResourceDeps, type RouteApp } from './shared.js'

/**
 * Frontier snippet routes (docs/03-api.md §3.3): full-text list, create (append or the
 * rare insert-between via afterSnippetId), one-revision-per-PATCH with baseRev optimistic
 * concurrency, delete, the revision log, and restore-as-new-revision (history is never
 * rewritten).
 */

async function snippetDto(handle: WorkHandle, snippetId: string): Promise<SnippetDto> {
  return toSnippetDto(await handle.getSnippet(snippetId))
}

/** Order key for an insert after `afterSnippetId`: between it and its successor (03 §3.3). */
function insertKey(handle: WorkHandle, afterSnippetId: string): string {
  const rows = handle.listSnippets() // ordered by orderKey
  const index = rows.findIndex((r) => r.id === afterSnippetId)
  if (index === -1) throw new AppError('not_found', `no snippet '${afterSnippetId}'`)
  const after = rows[index]
  if (after === undefined) throw new AppError('internal', 'snippet row vanished mid-read')
  return keyBetween(after.orderKey, rows[index + 1]?.orderKey ?? null)
}

export function registerSnippetRoutes(app: RouteApp, deps: ResourceDeps): void {
  app.route({
    method: 'GET',
    url: '/api/works/:w/snippets',
    schema: { response: { 200: api.listSnippets.res } },
    handler: async (req) => {
      const { handle } = await openWork(deps, req)
      return (await handle.listSnippetsWithText()).map(toSnippetDto)
    },
  })

  app.route({
    method: 'POST',
    url: '/api/works/:w/snippets',
    schema: { body: api.createSnippet.body, response: { 201: api.createSnippet.res } },
    handler: async (req, reply) => {
      const { handle } = await openWork(deps, req)
      const { text, afterSnippetId } = req.body
      const orderKey = afterSnippetId === undefined ? undefined : insertKey(handle, afterSnippetId)
      const meta = await handle.appendSnippet(text, {
        author: 'user',
        ...(orderKey === undefined ? {} : { orderKey }),
      })
      reply.code(201)
      return snippetDto(handle, meta.id)
    },
  })

  app.route({
    method: 'PATCH',
    url: '/api/works/:w/snippets/:s',
    schema: { body: api.patchSnippet.body, response: { 200: api.patchSnippet.res } },
    handler: async (req) => {
      const { handle } = await openWork(deps, req)
      const snippetId = param(req, 's')
      const result = await handle.reviseSnippet(snippetId, req.body.text, {
        author: 'user',
        baseRev: req.body.baseRev,
      })
      if (!result.ok) {
        throw new AppError('conflict', 'snippet was revised under you (stale baseRev)', {
          currentRev: result.conflict.currentRev,
          currentText: result.conflict.currentText,
        })
      }
      return snippetDto(handle, snippetId)
    },
  })

  app.route({
    method: 'DELETE',
    url: '/api/works/:w/snippets/:s',
    handler: async (req, reply) => {
      const { handle } = await openWork(deps, req)
      await handle.deleteSnippet(param(req, 's'))
      return reply.code(204).send()
    },
  })

  app.route({
    method: 'GET',
    url: '/api/works/:w/snippets/:s/revisions',
    schema: { response: { 200: api.listSnippetRevisions.res } },
    handler: async (req) => {
      const { handle } = await openWork(deps, req)
      // 404 for an unknown snippet (an empty log and a missing snippet must differ).
      await handle.getSnippet(param(req, 's'))
      return handle.getRevisions(param(req, 's'))
    },
  })

  app.route({
    method: 'POST',
    url: '/api/works/:w/snippets/:s/restore',
    schema: { body: api.restoreSnippet.body, response: { 200: api.restoreSnippet.res } },
    handler: async (req) => {
      const { handle } = await openWork(deps, req)
      const snippetId = param(req, 's')
      await handle.restoreSnippet(snippetId, req.body.rev, { author: 'user' })
      return snippetDto(handle, snippetId)
    },
  })
}
