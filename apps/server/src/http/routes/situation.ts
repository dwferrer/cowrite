import { api } from '@cowrite/shared'
import { xxh64OfString } from '../../storage/lib/hash.js'
import { AppError } from '../errors.js'
import { openWork, type ResourceDeps, type RouteApp } from './shared.js'

/**
 * Situation routes (docs/03-api.md §3.6): the per-work singleton markdown scratchpad.
 * GET answers '' when the file is absent; PUT is an atomic replace guarded by the
 * content-hash token — a stale `baseHash` returns `409 conflict {currentText,
 * currentHash}` so the UI can run its theirs/mine prompt instead of silently losing an
 * external edit.
 */

export function registerSituationRoutes(app: RouteApp, deps: ResourceDeps): void {
  app.route({
    method: 'GET',
    url: '/api/works/:w/situation',
    schema: { response: { 200: api.getSituation.res } },
    handler: async (req) => {
      const { handle } = await openWork(deps, req)
      return handle.getSituation()
    },
  })

  app.route({
    method: 'PUT',
    url: '/api/works/:w/situation',
    schema: { body: api.putSituation.body, response: { 200: api.putSituation.res } },
    handler: async (req) => {
      const { handle } = await openWork(deps, req)
      // `baseHash: null` = "no situation.md yet" — the token for that state is hash('').
      const baseHash = req.body.baseHash ?? (await xxh64OfString(''))
      const result = await handle.putSituation(req.body.text, { baseHash })
      if (!result.ok) {
        throw new AppError('conflict', 'the situation changed under you (stale baseHash)', {
          currentText: result.conflict.currentText,
          currentHash: result.conflict.hash,
          updatedAt: result.conflict.updatedAt,
        })
      }
      return { updatedAt: result.updatedAt, hash: result.hash }
    },
  })
}
