import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createMockLlm, type MockLlm } from '@cowrite/mock-llm'
import type {
  HarnessKnobsOverrides,
  SectionRow as SectionRowDto,
  SnippetDto,
  Task,
  WorkEvent,
} from '@cowrite/shared'
import { AppConfig, WorkDetail } from '@cowrite/shared'
import { ulid } from 'ulid'
import { expect } from 'vitest'
import { buildApp } from '../app.js'
import type { WorkEventBus } from '../events/bus.js'
import { createSseFrameSink } from '../events/sseFrames.js'
import { resourceRoutes } from '../http/routes/index.js'
import { type OpenWork, WorkRegistry } from '../http/workRegistry.js'
import type { ZodApp } from '../http/zod.js'
import { xxh64OfString } from '../storage/lib/hash.js'
import { createStorage, type StorageService } from '../storage/service.js'
import { AgentHarness } from './service.js'

/**
 * Mock-llm-backed integration harness (docs/05 §12 tier 2, docs/09 §2.3): the real
 * Fastify app over real temp-dir storage, both model lanes pointed at an in-process
 * `@cowrite/mock-llm` with the canonical `mock-high`/`mock-low` model names, driven via
 * `app.inject()` with SSE captured straight off the per-work bus.
 */

export interface HarnessTestCtx {
  dataDir: string
  storage: StorageService
  works: WorkRegistry
  harness: AgentHarness
  llm: MockLlm
  app: ZodApp
}

export interface HarnessCtxOptions {
  /** Model-client seams; defaults to instant retry backoff. */
  laneDeps?: import('../models/lanes.js').LaneDeps
  /** Per-MTok prices on both lanes (spend-guard tests need a non-null derived cost). */
  modelPricesPerMTok?: { prompt: number; completion: number }
  /** Background-scheduler tuning (sweep cadence/idle/cap) for Stage-4 tests. */
  scheduler?: import('./scheduler.js').SchedulerOptions
  /** Leave the low lane unconfigured (the config_missing / back-off scenarios). */
  omitLowLane?: boolean
  /** Reuse an existing data dir — the restart-mid-pipeline tests boot a second ctx over
   *  the first one's files (02 §6.5 restart story). Still removed by destroyHarnessCtx. */
  dataDir?: string
}

export async function makeHarnessCtx(
  harnessOverrides: HarnessKnobsOverrides = {},
  options: HarnessCtxOptions = {},
): Promise<HarnessTestCtx> {
  const dataDir = options.dataDir ?? (await fsp.mkdtemp(path.join(os.tmpdir(), 'cowrite-harness-')))
  const storage = createStorage(dataDir)
  const works = new WorkRegistry(storage)
  const llm = await createMockLlm()
  const prices =
    options.modelPricesPerMTok === undefined
      ? {}
      : {
          promptCostPerMTok: options.modelPricesPerMTok.prompt,
          completionCostPerMTok: options.modelPricesPerMTok.completion,
        }
  const config = AppConfig.parse({
    models: {
      high: { baseUrl: `${llm.url}/v1`, model: 'mock-high', ...prices },
      ...(options.omitLowLane === true
        ? {}
        : { low: { baseUrl: `${llm.url}/v1`, model: 'mock-low', ...prices } }),
    },
    harness: harnessOverrides,
  })
  const harness = new AgentHarness({
    config: () => config,
    laneDeps: options.laneDeps ?? { sleepImpl: async () => {} }, // instant retry backoff
    ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
  })
  works.onClose((open) => harness.closeWork(open))
  const app = buildApp({
    config: { current: () => config },
    works,
    version: '0.0.1-test',
    webDist: null,
    plugins: [resourceRoutes({ works, storage, harness })],
  })
  return { dataDir, storage, works, harness, llm, app }
}

export async function destroyHarnessCtx(ctx: HarnessTestCtx): Promise<void> {
  await ctx.works.closeAll()
  await ctx.app.close()
  await ctx.llm.close()
  await fsp.rm(ctx.dataDir, { recursive: true, force: true })
}

export async function createWork(ctx: HarnessTestCtx, title: string): Promise<WorkDetail> {
  const res = await ctx.app.inject({ method: 'POST', url: '/api/works', payload: { title } })
  expect(res.statusCode).toBe(201)
  return WorkDetail.parse(res.json())
}

export async function createSnippet(
  ctx: HarnessTestCtx,
  workId: string,
  text: string,
): Promise<SnippetDto> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/works/${workId}/snippets`,
    payload: { text },
  })
  expect(res.statusCode).toBe(201)
  return res.json() as SnippetDto
}

export async function openWork(ctx: HarnessTestCtx, workId: string): Promise<OpenWork> {
  return ctx.works.open(workId)
}

// ---------------------------------------------------------------------------
// Stage-4 route helpers shared by the pipeline suites (PATCH replaces the whole
// settings object — callers spell out the full consolidation block they want,
// usually via stage4Fixtures' `consolidation()`).
// ---------------------------------------------------------------------------

export async function patchConsolidation(
  ctx: HarnessTestCtx,
  workId: string,
  consolidation: import('./stage4Fixtures.js').Stage4Consolidation,
  contextOverrides: Record<string, number> = {},
): Promise<void> {
  const res = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/works/${workId}`,
    payload: { settings: { consolidation, contextOverrides } },
  })
  expect(res.statusCode, res.body).toBe(200)
}

export async function fetchSections(ctx: HarnessTestCtx, workId: string): Promise<SectionRowDto[]> {
  const res = await ctx.app.inject({ method: 'GET', url: `/api/works/${workId}/sections` })
  expect(res.statusCode).toBe(200)
  return res.json() as SectionRowDto[]
}

export async function fetchSnippets(ctx: HarnessTestCtx, workId: string): Promise<SnippetDto[]> {
  const res = await ctx.app.inject({ method: 'GET', url: `/api/works/${workId}/snippets` })
  expect(res.statusCode).toBe(200)
  return res.json() as SnippetDto[]
}

/** Open the work, attach an SSE capture, and seed `count` snippets of `text (label n)`. */
export async function seedPages(
  ctx: HarnessTestCtx,
  workId: string,
  count: number,
  label: string,
  text: string,
): Promise<{ snippets: SnippetDto[]; capture: SseCapture }> {
  const open = await openWork(ctx, workId)
  const capture = attachCapture(open.bus)
  const snippets: SnippetDto[] = []
  for (let i = 0; i < count; i++) {
    snippets.push(await createSnippet(ctx, workId, `${text} (${label} ${i + 1})`))
  }
  return { snippets, capture }
}

// ---------------------------------------------------------------------------
// Stage-4 seeding: hand-written frozen section dirs, adopted by the reconciler
// (the storage API deliberately has no create-section call — consolidation is
// the only writer; tests seed the files the way an external editor would).
// ---------------------------------------------------------------------------

export interface SeedSectionOptions {
  title?: string | null
  titleSource?: 'user' | 'agent'
  content?: string
  orderKey?: string
  /** Pre-existing summaries (absent ⇒ missing-counts-as-stale, 02 §6.5). */
  shortSummary?: string
  longSummary?: string
}

/** Write a frozen leaf chapter into the open work and reconcile it in; returns its id. */
export async function seedFrozenSection(
  ctx: HarnessTestCtx,
  workId: string,
  opts: SeedSectionOptions = {},
): Promise<string> {
  const open = await openWork(ctx, workId)
  const id = ulid()
  const orderKey = opts.orderKey ?? 'a0'
  const content = opts.content ?? 'The keeper counted the ships while the fog rolled in.\n'
  const contentHash = await xxh64OfString(content)
  const dir = path.join(
    open.handle.workDir,
    'sections',
    `${orderKey}-seeded.${id.slice(-6).toLowerCase()}`,
  )
  await fsp.mkdir(dir, { recursive: true })
  const summaryMeta = (source: 'user' | 'agent') => ({
    source,
    runId: null,
    generatedAt: '2026-07-01T00:00:00Z',
    sourceHash: contentHash,
  })
  await fsp.writeFile(path.join(dir, 'content.md'), content)
  if (opts.shortSummary !== undefined) {
    await fsp.writeFile(path.join(dir, 'summary-short.md'), opts.shortSummary)
  }
  if (opts.longSummary !== undefined) {
    await fsp.writeFile(path.join(dir, 'summary-long.md'), opts.longSummary)
  }
  await fsp.writeFile(
    path.join(dir, 'section.json'),
    JSON.stringify({
      schemaVersion: 1,
      id,
      kind: 'chapter',
      orderKey,
      title: opts.title === undefined ? 'Seeded Chapter' : opts.title,
      titleSource: opts.titleSource ?? 'agent',
      frozenAt: '2026-07-01T00:00:00Z',
      contentHash,
      enrichments: {
        shortSummary: opts.shortSummary === undefined ? null : summaryMeta('agent'),
        longSummary: opts.longSummary === undefined ? null : summaryMeta('agent'),
        illustration: null,
      },
    }),
  )
  await fsp.writeFile(path.join(dir, 'history.jsonl'), '')
  await open.handle.reconcile()
  return id
}

// ---------------------------------------------------------------------------
// SSE capture straight off the bus (frames parsed the way a client would).
// ---------------------------------------------------------------------------

export interface SseCapture {
  events: WorkEvent[]
  detach: () => void
}

export function attachCapture(bus: WorkEventBus, lastEventId?: string): SseCapture {
  const events: WorkEvent[] = []
  const detach = bus.attach(
    createSseFrameSink((event) => events.push(event)),
    lastEventId,
  )
  return { events, detach }
}

export function eventsOf<T extends WorkEvent['type']>(
  capture: SseCapture,
  type: T,
): Array<Extract<WorkEvent, { type: T }>> {
  return capture.events.filter((e): e is Extract<WorkEvent, { type: T }> => e.type === type)
}

/** Poll until `fn` (sync or async) returns a defined, non-false value. */
export async function until<T>(
  fn: () => T | Promise<T> | undefined | false | Promise<T | undefined | false>,
  what = 'condition',
  timeoutMs = 8000,
): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const value = await fn()
    if (value !== undefined && value !== false) return value as T
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** Poll GET /tasks/:t until the task reaches a terminal status. */
export async function waitForTerminal(
  ctx: HarnessTestCtx,
  workId: string,
  taskId: string,
): Promise<Task> {
  const t0 = Date.now()
  for (;;) {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/works/${workId}/tasks/${taskId}`,
    })
    if (res.statusCode === 200) {
      const task = res.json() as Task
      if (task.status === 'done' || task.status === 'error' || task.status === 'cancelled') {
        return task
      }
    }
    if (Date.now() - t0 > 8000) throw new Error(`task ${taskId} never reached a terminal status`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
