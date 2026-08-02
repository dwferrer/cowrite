import { ConfigTestReq, ConfigUpdate } from '@cowrite/shared'
import type { FastifyPluginAsync } from 'fastify'
import { AppError } from '../http/errors.js'
import { type ProbeDeps, runProbe } from './probes.js'
import type { ConfigService } from './service.js'

/**
 * Config routes (docs/03-api.md §3.12) as a self-contained Fastify plugin. The http-core
 * agent registers it with a ConfigService and owns the app-level error handler.
 *
 * Error convention: handlers throw the ONE `AppError` from http/errors.ts — the
 * production error handler matches it via `instanceof`, so a local copy of the class
 * would silently turn every validation failure into a 500 `internal` envelope.
 * Bodies are validated here with the shared Zod schemas (`ConfigUpdate`, `ConfigTestReq`)
 * so the plugin stays contract-true even before the route/schema wiring pass; a failed
 * parse throws `AppError('validation', …, {issues})`.
 *
 * Note a failed probe is a 200 `ProbeResult{ok:false}` — probe failure is this screen's
 * expected outcome, not an API error.
 */

export interface ConfigRoutesOptions {
  service: ConfigService
  /** Injectable for tests (mock fetch, short timeout). */
  probeDeps?: ProbeDeps
}

export const configRoutes: FastifyPluginAsync<ConfigRoutesOptions> = async (app, opts) => {
  const { service, probeDeps } = opts

  // GET /api/config → PublicConfig (redacted; setup flags + override provenance)
  app.get('/api/config', async () => service.public())

  // PUT /api/config → ConfigWriteRes (full replace, §9.5)
  app.put('/api/config', async (req) => {
    const parsed = ConfigUpdate.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError('validation', 'invalid config document', { issues: parsed.error.issues })
    }
    return service.update(parsed.data)
  })

  // POST /api/config/test → ProbeResult (candidate merged over stored, §9.4)
  app.post('/api/config/test', async (req) => {
    const parsed = ConfigTestReq.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError('validation', 'invalid probe request', { issues: parsed.error.issues })
    }
    // The probe merges the RAW candidate over the stored config: ConfigUpdate parsing
    // materializes null defaults, which would make an omitted section indistinguishable
    // from an explicitly cleared one (probes.ts header).
    const raw = req.body as { candidate?: unknown } | null
    return runProbe(
      {
        target: parsed.data.target,
        ...(raw?.candidate === undefined ? {} : { candidate: raw.candidate }),
      },
      service.get(),
      probeDeps,
    )
  })

  // POST /api/config/reload → ConfigWriteRes (re-read from disk, §9.7)
  app.post('/api/config/reload', async () => service.reload())
}
