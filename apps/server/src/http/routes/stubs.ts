import { api } from '@cowrite/shared'
import type { AgentHarness } from '../../harness/service.js'
import type { RouteApp } from './shared.js'

/**
 * The illustration health route (docs/03-api.md §3.12, docs/08 §8): ComfyUI reachability
 * plus the per-workflow / per-route registry validation report, powering the settings-page
 * status row. Backed by the harness's illustration runtime (registry + ComfyUI client);
 * when illustration is unconfigured it reports `comfy.ok = false` with a "not configured"
 * detail rather than failing. Formerly a 501 stub — the pipeline landed in Stage 5.
 */

export function registerStubRoutes(app: RouteApp, harness: AgentHarness): void {
  app.route({
    method: 'GET',
    url: '/api/illustration/health',
    schema: { response: { 200: api.illustrationHealth.res } },
    handler: () => harness.illustrationHealth(),
  })
}
