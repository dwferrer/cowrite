import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createMockLlm, type MockLlm } from '@cowrite/mock-llm'
import type { HarnessKnobsOverrides, SnippetDto, Task, WorkEvent } from '@cowrite/shared'
import { AppConfig, WorkDetail } from '@cowrite/shared'
import { expect } from 'vitest'
import { buildApp } from '../app.js'
import type { WorkEventBus } from '../events/bus.js'
import { createSseFrameSink } from '../events/sseFrames.js'
import { resourceRoutes } from '../http/routes/index.js'
import { type OpenWork, WorkRegistry } from '../http/workRegistry.js'
import type { ZodApp } from '../http/zod.js'
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
}

export async function makeHarnessCtx(
  harnessOverrides: HarnessKnobsOverrides = {},
  options: HarnessCtxOptions = {},
): Promise<HarnessTestCtx> {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cowrite-harness-'))
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
      low: { baseUrl: `${llm.url}/v1`, model: 'mock-low', ...prices },
    },
    harness: harnessOverrides,
  })
  const harness = new AgentHarness({
    config: () => config,
    laneDeps: options.laneDeps ?? { sleepImpl: async () => {} }, // instant retry backoff
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

/** Poll until `fn` returns a defined, non-false value (the SSE/async settle helper). */
export async function until<T>(
  fn: () => T | undefined | false,
  what = 'condition',
  timeoutMs = 8000,
): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const value = fn()
    if (value !== undefined && value !== false) return value
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
