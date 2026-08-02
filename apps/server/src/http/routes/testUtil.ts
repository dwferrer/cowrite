import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ApiErrorBody, AppConfig, type ErrorCode, WorkDetail } from '@cowrite/shared'
import { expect } from 'vitest'
import { buildApp } from '../../app.js'
import { buildFixtureWork, FIX } from '../../storage/index/fixture.js'
import { createStorage, type StorageService } from '../../storage/service.js'
import { WorkRegistry } from '../workRegistry.js'
import type { ZodApp } from '../zod.js'
import { resourceRoutes } from './index.js'

/**
 * Test-only harness for the resource-route integration tests (docs/03-api.md §12):
 * `buildApp` over real storage on a temp data dir, driven via `app.inject()` — no
 * sockets, no mocks. The storage fixture work (index/fixture.ts) provides sections,
 * snippets, world entries, and images without going through consolidation (Stage 4).
 */

export interface TestCtx {
  dataDir: string
  storage: StorageService
  works: WorkRegistry
  app: ZodApp
}

export async function makeTestCtx(): Promise<TestCtx> {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cowrite-routes-'))
  const storage = createStorage(dataDir)
  const works = new WorkRegistry(storage)
  const app = buildApp({
    config: { current: () => AppConfig.parse({}) },
    works,
    version: '0.0.1-test',
    webDist: null,
    plugins: [resourceRoutes({ works, storage })],
  })
  return { dataDir, storage, works, app }
}

export async function destroyTestCtx(ctx: TestCtx): Promise<void> {
  await ctx.works.closeAll()
  await ctx.app.close()
  await fsp.rm(ctx.dataDir, { recursive: true, force: true })
}

/** Materialize the storage fixture work under <dataDir>/works and return its id. */
export async function seedFixtureWork(ctx: TestCtx) {
  const info = await buildFixtureWork(path.join(ctx.dataDir, 'works'))
  return { ...info, workId: FIX.workId }
}

/** POST /api/works and parse the created WorkDetail. */
export async function createWorkViaApi(ctx: TestCtx, title: string): Promise<WorkDetail> {
  const res = await ctx.app.inject({ method: 'POST', url: '/api/works', payload: { title } })
  expect(res.statusCode).toBe(201)
  return WorkDetail.parse(res.json())
}

/** Assert the §7 envelope: status + code, returning details for further checks. */
export function expectEnvelope(
  res: { statusCode: number; json: () => unknown },
  statusCode: number,
  code: ErrorCode,
): unknown {
  expect(res.statusCode).toBe(statusCode)
  const body = ApiErrorBody.parse(res.json())
  expect(body.error.code).toBe(code)
  return body.error.details
}

/** A syntactically valid ULID that matches nothing in any test data dir. */
export const NO_SUCH_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
