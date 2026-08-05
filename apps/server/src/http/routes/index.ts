import { AppConfig } from '@cowrite/shared'
import type { FastifyPluginAsync } from 'fastify'
import { registerContextRoutes } from '../../context/routes.js'
import { registerTaskRoutes } from '../../harness/routes.js'
import { AgentHarness } from '../../harness/service.js'
import { registerEditingRoutes } from './editing.js'
import { registerImageRoutes } from './images.js'
import { registerSectionRoutes } from './sections.js'
import { type ResourceDeps, withZod } from './shared.js'
import { registerSituationRoutes } from './situation.js'
import { registerSnippetRoutes } from './snippets.js'
import { registerStubRoutes } from './stubs.js'
import { registerWorkRoutes } from './works.js'
import { registerWorldRoutes } from './world.js'

/**
 * The resource-route plugin (docs/03-api.md §3.1–§3.11): everything under /api/works and
 * the registered Stage-3/4/5 stubs, one `buildApp(deps).plugins` entry. The composition
 * root constructs it with the WorkRegistry (work lifecycle §4) and the StorageService
 * (the cheap /works list scan, which must not open works).
 */

export type { ResourceDeps } from './shared.js'

export function resourceRoutes(deps: ResourceDeps): FastifyPluginAsync {
  return async (app) => {
    const zodApp = withZod(app)
    // Default harness: all-defaults config ⇒ unconfigured lanes ⇒ 409 config_missing at
    // task creation; runs/proposal routes work regardless (they read storage).
    const harness = deps.harness ?? new AgentHarness({ config: () => AppConfig.parse({}) })
    // Every open work's bus gets the harness's attach-time task-state provider (03 §8.3
    // hydration fencing) and its background scheduler; SSE presence gates the sweep.
    deps.works.onOpen((open) =>
      harness.attachWork(open, () => deps.works.subscriberCount(open.slug) > 0),
    )
    registerWorkRoutes(zodApp, deps)
    registerSectionRoutes(zodApp, deps)
    registerSnippetRoutes(zodApp, deps)
    registerWorldRoutes(zodApp, deps)
    registerSituationRoutes(zodApp, deps)
    registerEditingRoutes(zodApp, deps)
    registerImageRoutes(zodApp, deps)
    registerContextRoutes(zodApp, deps)
    registerTaskRoutes(zodApp, deps, harness)
    registerStubRoutes(zodApp, harness)
  }
}
