import type { BudgetKnobsOverrides } from '@cowrite/shared'
import { api } from '@cowrite/shared'
import { AppError } from '../http/errors.js'
import { openWork, param, type ResourceDeps, type RouteApp } from '../http/routes/shared.js'
import type { OpenWork } from '../http/workRegistry.js'
import { templateRenderer } from '../prompt/renderer.js'
import { loadTemplates, type TemplateSet } from '../prompt/templates/loader.js'
import { contextDir } from '../storage/lib/paths.js'
import type { WorkHandle } from '../storage/service.js'
import {
  ContextEngine,
  type EngineDeps,
  EngineValidationError,
  SessionBusyError,
} from './engine.js'
import type { PromptRenderer } from './renderTypes.js'

/**
 * The §11 REST surface of docs/06-context-engine.md, mounted by the API layer (03 §3.11):
 * /context/state, /candidates, /preview, /reset, /usage. Also the composition glue that
 * constructs ONE engine per open WorkHandle (06 §3: the work lock already guarantees one
 * process; this WeakMap guarantees one engine per handle) with deps adapted from storage
 * and the per-work event bus. The engine's `renderer` is the template-backed one
 * (prompt/renderer.ts over prompt/templates/*.md) — the templates are the ONE wording
 * source at every composition root (07 §6); callers with their own loaded set (the
 * harness, so its `promptsHash` and the engine's wording are one set) pass it in.
 */

const engines = new WeakMap<WorkHandle, Promise<ContextEngine>>()

/** The default template set for engines nobody handed one to (REST /context routes). */
let defaultTemplates: Promise<TemplateSet> | null = null

function defaultRendererPromise(): Promise<PromptRenderer> {
  defaultTemplates ??= loadTemplates()
  return defaultTemplates.then(templateRenderer)
}

function definedOnly<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>
}

/** Build EngineDeps from an open work (storage readers + in-process channels — 06 §9.3). */
export function engineDepsFor(
  open: OpenWork,
  renderer: PromptRenderer,
  appBudgets?: () => BudgetKnobsOverrides,
): EngineDeps {
  const { handle, bus } = open
  return {
    renderer,
    workId: handle.work.id,
    contextDir: contextDir(handle.workDir),
    manuscript: {
      levelScheme: () => handle.work.levelScheme,
      listSections: () =>
        handle.listSections().map((row) => ({
          id: row.id,
          parentId: row.parentId,
          kind: row.kind,
          orderKey: row.orderKey,
          title: row.title,
          contentHash: row.contentHash,
          frozenAt: row.frozenAt,
          wordCount: row.wordCount,
          shortSummary: row.shortSummary,
          longSummary: row.longSummary,
        })),
      getSectionContent: (sectionId) => handle.getSectionContent(sectionId),
      listSnippets: async () =>
        (await handle.listSnippetsWithText()).map((s) => ({
          id: s.id,
          orderKey: s.orderKey,
          text: s.text,
        })),
    },
    worldInfo: {
      listEntries: async () =>
        (await handle.listWorldEntries()).map((entry) => ({
          id: entry.meta.id,
          name: entry.meta.name,
          shortSummary: entry.meta.shortSummary,
          body: entry.body,
        })),
    },
    situation: {
      getSituation: async () => ({ text: (await handle.getSituation()).text }),
    },
    channels: {
      // §8.5 in-process channels: never on the wire.
      emitEnrichmentWanted: (sectionId) => {
        bus.publishLocal({ type: 'enrichment_wanted', sectionId })
      },
      onEnrichmentCompleted: (cb) => {
        // Storage summary writes and the harness's explicit completion signal both count
        // as "enrichment landed" — either queues the anchor refresh (06 §4.3).
        const unsubStorage = handle.onChange((change) => {
          if (
            change.type === 'enrichment.updated' &&
            (change.enrichment === 'shortSummary' || change.enrichment === 'longSummary')
          ) {
            cb(change.sectionId)
          }
        })
        const unsubBus = bus.onLocal((event) => {
          if (event.type === 'enrichment.completed' && typeof event.sectionId === 'string') {
            cb(event.sectionId)
          }
        })
        return () => {
          unsubStorage()
          unsubBus()
        }
      },
      onWorkChanged: (cb) =>
        // Every committed mutation invalidates the engine's cached snapshot; run
        // recordings don't touch manuscript/world/situation state, so they're exempt.
        handle.onChange((change) => {
          if (change.type !== 'run.recorded') cb()
        }),
    },
    knobs: () => ({
      // Override chain, lowest to highest (06 §8.1): schema defaults → app config.budgets
      // → per-work work.json contextOverrides. Re-read per task so PATCHes apply.
      ...definedOnly(appBudgets?.() ?? {}),
      ...definedOnly(handle.work.settings.contextOverrides),
    }),
  }
}

/**
 * One engine per open WorkHandle; constructed lazily on the first /context touch or task
 * submit. The creating caller may inject its template set (`templates`) so the renderer
 * wording and the run-stamped `promptsHash` come from the SAME bytes; later callers get
 * the cached engine regardless. The engine is registered as a per-open close resource:
 * the registry runs `engine.close()` (subscription detach + usage-append settlement)
 * BEFORE `handle.close()`, so a work delete never EPERMs on Windows (03 §4.3).
 */
export function engineFor(
  open: OpenWork,
  appBudgets?: () => BudgetKnobsOverrides,
  templates?: Promise<TemplateSet>,
): Promise<ContextEngine> {
  const existing = engines.get(open.handle)
  if (existing !== undefined) return existing
  const renderer =
    templates === undefined ? defaultRendererPromise() : templates.then(templateRenderer)
  const created = renderer.then((r) => ContextEngine.load(engineDepsFor(open, r, appBudgets)))
  engines.set(open.handle, created)
  open.addCloseResource(async () => {
    engines.delete(open.handle)
    await (await created).close()
  })
  return created
}

/** Map engine-typed errors to the §7 envelope codes. */
function rethrow(err: unknown): never {
  if (err instanceof EngineValidationError) throw new AppError('validation', err.message)
  if (err instanceof SessionBusyError) throw new AppError('busy', err.message)
  throw err
}

export function registerContextRoutes(app: RouteApp, deps: ResourceDeps): void {
  const engine = async (req: Parameters<typeof openWork>[1]) =>
    engineFor(await openWork(deps, req), deps.budgets)

  app.route({
    method: 'GET',
    url: '/api/works/:w/context/state',
    schema: { response: { 200: api.getContextState.res } },
    handler: async (req) => (await engine(req)).stateRes(),
  })

  app.route({
    method: 'GET',
    url: '/api/works/:w/context/candidates',
    schema: { response: { 200: api.getContextCandidates.res } },
    handler: async (req) => (await engine(req)).candidates(),
  })

  app.route({
    method: 'POST',
    url: '/api/works/:w/context/preview',
    schema: { body: api.previewContext.body, response: { 200: api.previewContext.res } },
    handler: async (req) => {
      try {
        return await (await engine(req)).preview(req.body)
      } catch (err) {
        rethrow(err)
      }
    },
  })

  app.route({
    method: 'POST',
    url: '/api/works/:w/context/reset',
    handler: async (req, reply) => {
      try {
        await (await engine(req)).reset()
      } catch (err) {
        rethrow(err)
      }
      return reply.status(204).send()
    },
  })

  app.route({
    method: 'GET',
    url: '/api/works/:w/context/usage',
    schema: { querystring: api.getContextUsage.query, response: { 200: api.getContextUsage.res } },
    handler: async (req) => {
      void param(req, 'w') // presence-checked; engine() resolves the same param
      return (await engine(req)).usage(req.query.limit)
    },
  })
}
