import { api } from '@cowrite/shared'
import type { WorkHandle } from '../../storage/service.js'
import { AppError } from '../errors.js'
import {
  openWork,
  param,
  type ResourceDeps,
  type RouteApp,
  requirePng,
  toWorldEntryDto,
  userUploadMeta,
} from './shared.js'

/**
 * World-info routes (docs/03-api.md §3.5): full-body list (one fetch powers the panel,
 * hovercards, and the key matcher), single-entry fetch (the SSE patch target), create,
 * PATCH with baseHash optimistic concurrency on body replacement, delete (entry + its
 * image), and the raw-PNG user image upload/delete.
 */

async function upsertOrConflict(
  handle: WorkHandle,
  input: Parameters<WorkHandle['upsertWorldEntry']>[0],
) {
  const result = await handle.upsertWorldEntry(input)
  if (!result.ok) {
    throw new AppError('conflict', 'world entry body changed under you (stale baseHash)', {
      currentHash: result.conflict.currentHash,
      currentText: result.conflict.currentText,
    })
  }
  return result.entry
}

export function registerWorldRoutes(app: RouteApp, deps: ResourceDeps): void {
  app.route({
    method: 'GET',
    url: '/api/works/:w/world',
    schema: { response: { 200: api.listWorldEntries.res } },
    handler: async (req) => {
      const { handle } = await openWork(deps, req)
      const entries = await handle.listWorldEntries()
      return Promise.all(entries.map((entry) => toWorldEntryDto(handle, entry)))
    },
  })

  app.route({
    method: 'GET',
    url: '/api/works/:w/world/:e',
    schema: { response: { 200: api.getWorldEntry.res } },
    handler: async (req) => {
      const { handle } = await openWork(deps, req)
      return toWorldEntryDto(handle, await handle.getWorldEntry(param(req, 'e')))
    },
  })

  app.route({
    method: 'POST',
    url: '/api/works/:w/world',
    schema: { body: api.createWorldEntry.body, response: { 201: api.createWorldEntry.res } },
    handler: async (req, reply) => {
      const { handle } = await openWork(deps, req)
      const { name, keys, body, shortSummary } = req.body
      const entry = await upsertOrConflict(handle, {
        name,
        ...(keys === undefined ? {} : { keys }),
        ...(shortSummary === undefined ? {} : { shortSummary }),
        body: body ?? '',
        createdBy: 'user',
      })
      reply.code(201)
      return toWorldEntryDto(handle, entry)
    },
  })

  app.route({
    method: 'PATCH',
    url: '/api/works/:w/world/:e',
    schema: { body: api.patchWorldEntry.body, response: { 200: api.patchWorldEntry.res } },
    handler: async (req) => {
      const { handle } = await openWork(deps, req)
      const entryId = param(req, 'e')
      const existing = await handle.getWorldEntry(entryId) // 404 for unknown ids
      const { name, keys, body, shortSummary, baseHash } = req.body
      const entry = await upsertOrConflict(handle, {
        id: entryId,
        name: name ?? existing.meta.name,
        ...(keys === undefined ? {} : { keys }),
        ...(shortSummary === undefined ? {} : { shortSummary }),
        body: body ?? existing.body,
        createdBy: existing.meta.createdBy,
        // §3.5: the token guards body replacement; harmless (and still honored) otherwise.
        ...(baseHash === undefined ? {} : { baseHash }),
      })
      return toWorldEntryDto(handle, entry)
    },
  })

  app.route({
    method: 'DELETE',
    url: '/api/works/:w/world/:e',
    handler: async (req, reply) => {
      const { handle } = await openWork(deps, req)
      await handle.deleteWorldEntry(param(req, 'e'))
      return reply.code(204).send()
    },
  })

  app.route({
    method: 'POST',
    url: '/api/works/:w/world/:e/image',
    schema: { response: { 200: api.uploadWorldImage.res } },
    handler: async (req) => {
      const { handle } = await openWork(deps, req)
      const entryId = param(req, 'e')
      const png = requirePng(req.body)
      await handle.putWorldImage(entryId, png, userUploadMeta())
      const info = handle.worldImagePath(entryId)
      if (info === null) throw new AppError('internal', 'uploaded image did not index')
      return { imageVersion: info.version }
    },
  })

  app.route({
    method: 'DELETE',
    url: '/api/works/:w/world/:e/image',
    handler: async (req, reply) => {
      const { handle } = await openWork(deps, req)
      // Storage owns the whole layering (02 §11): mutex + readonly guard, pointer clear,
      // PNG + sidecar removal, index refresh, one world.updated. Idempotent.
      await handle.deleteWorldImage(param(req, 'e'))
      return reply.code(204).send()
    },
  })
}
