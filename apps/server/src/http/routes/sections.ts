import { api } from '@cowrite/shared'
import { toSectionRowDto } from '../../events/adapter.js'
import { AppError } from '../errors.js'
import { hydrateSectionRow, openWork, param, type ResourceDeps, type RouteApp } from './shared.js'

/**
 * Section routes (docs/03-api.md §3.2): the flat document-order row list with inlined
 * summaries, lazy leaf content with baseHash optimistic concurrency, user title edits
 * (titleSource: "user" — never clobbered by enrichment), and the user summary-edit path
 * (author: "user", stamped at the current sourceHash).
 */

export function registerSectionRoutes(app: RouteApp, deps: ResourceDeps): void {
  app.route({
    method: 'GET',
    url: '/api/works/:w/sections',
    schema: { response: { 200: api.listSections.res } },
    handler: async (req) => {
      const { handle } = await openWork(deps, req)
      // Served entirely from the index rows (summaries inlined, schema v2): no file I/O.
      return handle.listSections().map((row) => toSectionRowDto(row, handle.work.levelScheme))
    },
  })

  app.route({
    method: 'GET',
    url: '/api/works/:w/sections/:s/content',
    schema: { response: { 200: api.getSectionContent.res } },
    handler: async (req) => {
      const { handle } = await openWork(deps, req)
      const sectionId = param(req, 's')
      const row = handle.getSection(sectionId)
      if (row === null) throw new AppError('not_found', `no section '${sectionId}'`)
      // §3.2: interior sections have no prose — 404 not_found, not a validation error.
      if (row.contentHash === null) {
        throw new AppError('not_found', `section '${sectionId}' is interior — no content`)
      }
      const { text, contentHash } = await handle.getSectionContent(sectionId)
      return { markdown: text, contentHash }
    },
  })

  app.route({
    method: 'PATCH',
    url: '/api/works/:w/sections/:s/content',
    schema: {
      body: api.patchSectionContent.body,
      response: { 200: api.patchSectionContent.res },
    },
    handler: async (req) => {
      const { handle } = await openWork(deps, req)
      const result = await handle.replaceSectionContent(param(req, 's'), req.body.markdown, {
        baseHash: req.body.baseHash,
      })
      if (!result.ok) {
        throw new AppError('conflict', 'section content changed under you (stale baseHash)', {
          currentHash: result.conflict.currentHash,
          currentText: result.conflict.currentText,
        })
      }
      return { contentHash: result.contentHash }
    },
  })

  app.route({
    method: 'PATCH',
    url: '/api/works/:w/sections/:s',
    schema: { body: api.patchSection.body, response: { 200: api.patchSection.res } },
    handler: async (req) => {
      const { handle } = await openWork(deps, req)
      const sectionId = param(req, 's')
      await handle.setSectionTitle(sectionId, req.body.title, { source: 'user' })
      return hydrateSectionRow(handle, sectionId)
    },
  })

  app.route({
    method: 'GET',
    url: '/api/works/:w/sections/:s/summaries',
    schema: { response: { 200: api.getSectionSummaries.res } },
    handler: async (req) => {
      const { handle } = await openWork(deps, req)
      return handle.getSummaries(param(req, 's'))
    },
  })

  app.route({
    method: 'PUT',
    url: '/api/works/:w/sections/:s/summaries',
    schema: {
      body: api.putSectionSummaries.body,
      response: { 200: api.putSectionSummaries.res },
    },
    handler: async (req) => {
      const { handle } = await openWork(deps, req)
      const sectionId = param(req, 's')
      const { short, long } = req.body
      if (short === undefined && long === undefined) {
        throw new AppError('validation', 'provide at least one of {short, long}')
      }
      if (short !== undefined) {
        await handle.putSummary(sectionId, 'short', short, { source: 'user' })
      }
      if (long !== undefined) {
        await handle.putSummary(sectionId, 'long', long, { source: 'user' })
      }
      return hydrateSectionRow(handle, sectionId)
    },
  })
}
