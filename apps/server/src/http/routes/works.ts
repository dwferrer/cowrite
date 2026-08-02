import { api, type WorkSummary } from '@cowrite/shared'
import {
  mergeSettings,
  openWork,
  param,
  type ResourceDeps,
  type RouteApp,
  toWorkDetail,
} from './shared.js'

/**
 * Works routes (docs/03-api.md §3.1). GET /works is the cheap scan (no work opened,
 * counts from each work's existing index or null); everything under /works/:w lazily
 * opens the work (§4.1). DELETE runs the registry's ordered teardown (§4.3) before the
 * `.trash` rename — load-bearing on Windows.
 */

export function registerWorkRoutes(app: RouteApp, deps: ResourceDeps): void {
  app.route({
    method: 'GET',
    url: '/api/works',
    schema: { response: { 200: api.listWorks.res } },
    handler: async (): Promise<WorkSummary[]> => {
      const listings = await deps.storage.listWorks()
      return listings.flatMap((listing) => {
        if (!listing.ok) return [] // broken works surface as startup warnings, not here
        return [
          {
            id: listing.meta.id,
            title: listing.meta.title,
            slug: listing.slug,
            wordCount: listing.counts?.wordCount ?? null,
            snippetCount: listing.counts?.snippetCount ?? null,
            sectionCount: listing.counts?.sectionCount ?? null,
            updatedAt: listing.counts?.updatedAt ?? listing.meta.createdAt,
          },
        ]
      })
    },
  })

  app.route({
    method: 'POST',
    url: '/api/works',
    schema: { body: api.createWork.body, response: { 201: api.createWork.res } },
    handler: async (req, reply) => {
      const created = await deps.works.createWork(req.body.title)
      const open = await deps.works.open(created.meta.id)
      reply.code(201)
      return toWorkDetail(open)
    },
  })

  app.route({
    method: 'GET',
    url: '/api/works/:w',
    schema: { response: { 200: api.getWork.res } },
    handler: async (req) => toWorkDetail(await openWork(deps, req)),
  })

  app.route({
    method: 'PATCH',
    url: '/api/works/:w',
    schema: { body: api.patchWork.body, response: { 200: api.patchWork.res } },
    handler: async (req) => {
      const open = await openWork(deps, req)
      const { title, settings } = req.body
      await open.handle.updateWork({
        ...(title === undefined ? {} : { title }),
        ...(settings === undefined
          ? {}
          : { settings: mergeSettings(open.handle.work.settings, settings) }),
      })
      return toWorkDetail(open)
    },
  })

  app.route({
    method: 'DELETE',
    url: '/api/works/:w',
    handler: async (req, reply) => {
      await deps.works.deleteWork(param(req, 'w'))
      return reply.code(204).send()
    },
  })
}
