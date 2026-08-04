import type { LlmStep } from '@cowrite/mock-llm'
import type { APIRequestContext } from '@playwright/test'
import { expect } from '@playwright/test'

/**
 * Shared plumbing for the Stage-2 e2e specs: API-level setup (each spec isolates by WORK,
 * not by data dir — docs/09-testing.md §6.2) and access to the run's shared temp dirs
 * minted by playwright.config.ts.
 */

/** Fixed test port — distinct from the 2697 default so a running dev server never collides. */
export const E2E_PORT = 2698
export const E2E_URL = `http://127.0.0.1:${E2E_PORT}`
/** Fixed port for the server's in-process mock LLM (COWRITE_MOCK_LLM=1 + MOCK_LLM_PORT).
 *  2699 is taken: the restart spec (60) boots its own server there. */
export const E2E_MOCK_LLM_PORT = 2700
export const MOCK_LLM_URL = `http://127.0.0.1:${E2E_MOCK_LLM_PORT}`

export function e2eDataDir(): string {
  const dir = process.env.COWRITE_E2E_DATA_DIR
  if (dir === undefined || dir === '') {
    throw new Error('COWRITE_E2E_DATA_DIR is unset — run the suite through playwright.config.ts')
  }
  return dir
}

export function e2eHomeDir(): string {
  const dir = process.env.COWRITE_E2E_HOME
  if (dir === undefined || dir === '') {
    throw new Error('COWRITE_E2E_HOME is unset — run the suite through playwright.config.ts')
  }
  return dir
}

/**
 * Make sure the high lane is configured so the `/` loader stops redirecting to /settings
 * (04 §3.1). Stage 2 has no agents, so a stub endpoint that nothing ever probes is fine.
 */
export async function ensureConfigured(request: APIRequestContext): Promise<void> {
  const res = await request.get('/api/config')
  expect(res.ok()).toBe(true)
  const config = (await res.json()) as { setup: { highConfigured: boolean } }
  if (config.setup.highConfigured) return
  const put = await request.put('/api/config', {
    data: {
      models: {
        high: { baseUrl: 'http://127.0.0.1:9/v1', apiKey: '', model: 'e2e-stub-high' },
        low: null,
      },
    },
  })
  expect(put.ok()).toBe(true)
}

export interface CreatedWork {
  id: string
  slug: string
}

export async function createWork(request: APIRequestContext, title: string): Promise<CreatedWork> {
  const res = await request.post('/api/works', { data: { title } })
  expect(res.status()).toBe(201)
  const work = (await res.json()) as { id: string; slug: string }
  return { id: work.id, slug: work.slug }
}

export async function createSnippet(
  request: APIRequestContext,
  workId: string,
  text: string,
): Promise<{ id: string; rev: number }> {
  const res = await request.post(`/api/works/${workId}/snippets`, { data: { text } })
  expect(res.status()).toBe(201)
  return (await res.json()) as { id: string; rev: number }
}

// ---------------------------------------------------------------------------
// Stage-4 consolidation plumbing (docs/02 §6; docs/05 §6.2): settings patches,
// scripted boundary/enrich responses, and API-level polling for the pipeline.
// ---------------------------------------------------------------------------

/** ~40 words of scene prose per snippet (no ---/*** lines — the scene-break heuristic
 *  must stay cold so the boundary agent path is what these specs exercise). */
export const PAGE =
  'The storm pressed the town flat while the two of them worked the pump in turns, ' +
  'counting strokes out loud, trading the handle at fifty, listening to the cellar fill ' +
  'anyway, patient and dark and certain as the tide coming home.'

/** A full consolidation settings block: the server PATCH replaces the whole settings
 *  object (schema defaults refill omitted fields), so specs always spell out all of it. */
export interface ConsolidationBlock {
  activeWindowSnippets: number
  activeWindowWords: number
  maxFrontierSnippets: number
  maxFrontierWords: number
  debounceMs: number
  undoGraceMs: number
  mode: 'auto' | 'review'
}

export const MANUAL_CONSOLIDATION: ConsolidationBlock = {
  activeWindowSnippets: 2,
  activeWindowWords: 10,
  maxFrontierSnippets: 6,
  maxFrontierWords: 50_000,
  debounceMs: 600_000, // manual-only: specs drive POST /consolidate themselves
  undoGraceMs: 60_000,
  mode: 'auto',
}

export async function patchConsolidation(
  request: APIRequestContext,
  workId: string,
  consolidation: ConsolidationBlock,
): Promise<void> {
  const res = await request.patch(`/api/works/${workId}`, {
    data: { settings: { consolidation } },
  })
  expect(res.ok()).toBe(true)
}

/** The boundary agent's tagged JSON response (07 boundaries.md; 02 §10.5). */
export function boundariesBlock(cuts: Array<[afterSnippetId: string, title: string]>): string {
  const boundaries = cuts.map(([afterSnippetId, title]) => ({
    afterSnippetId,
    kind: 'chapter',
    title,
  }))
  return `<boundaries>\n${JSON.stringify({ boundaries })}\n</boundaries>`
}

/** The enrichment agent's tagged response (07 enrich.md). */
export function enrichBlock(title: string, short: string, long: string): string {
  return (
    `<title>\n${title}\n</title>\n` +
    `<summary-short>\n${short}\n</summary-short>\n` +
    `<summary-long>\n${long}\n</summary-long>`
  )
}

export interface SectionRowLite {
  id: string
  title: string | null
  isLeaf: boolean
  shortSummary: string | null
  longSummary: string | null
  stale: { short: boolean; long: boolean; illustration: boolean }
}

export async function listSections(
  request: APIRequestContext,
  workId: string,
): Promise<SectionRowLite[]> {
  const res = await request.get(`/api/works/${workId}/sections`)
  expect(res.ok()).toBe(true)
  return (await res.json()) as SectionRowLite[]
}

export async function listSnippets(
  request: APIRequestContext,
  workId: string,
): Promise<Array<{ id: string; text: string }>> {
  const res = await request.get(`/api/works/${workId}/snippets`)
  expect(res.ok()).toBe(true)
  return (await res.json()) as Array<{ id: string; text: string }>
}

/** Force an immediate consolidation evaluation (03 §3.8). */
export async function consolidateNow(request: APIRequestContext, workId: string): Promise<void> {
  const res = await request.post(`/api/works/${workId}/consolidate`)
  expect(res.status(), await res.text()).toBe(202)
}

// ---------------------------------------------------------------------------
// Mock-LLM scripting over the cross-process control routes (docs/09 §2.2/§2.3).
// The step types come straight from @cowrite/mock-llm — plain JSON by design,
// so the same shapes travel over POST /__mock/scenario. One source, no drift.
// ---------------------------------------------------------------------------

export type { LlmMatch, LlmStep } from '@cowrite/mock-llm'

/** Wrap prose in the tag block the Stage-3 output parser expects (07 §tag grammar). */
export function snippetBlock(id: string, body: string): string {
  return `<snippet id="${id}">\n${body}\n</snippet>\n`
}

/** Reset the strict scenario queue (call at the top of every task-running test). */
export async function resetLlm(request: APIRequestContext): Promise<void> {
  const res = await request.post(`${MOCK_LLM_URL}/__mock/reset`)
  expect(res.ok()).toBe(true)
}

/** Enqueue scripted steps; an unscripted or mismatched request fails loudly server-side. */
export async function scriptLlm(request: APIRequestContext, steps: LlmStep[]): Promise<void> {
  const res = await request.post(`${MOCK_LLM_URL}/__mock/scenario`, { data: steps })
  expect(res.ok()).toBe(true)
}

/** End-of-test gate: every scripted step fired and no request ever mismatched. */
export async function assertLlmDrained(request: APIRequestContext): Promise<void> {
  const res = await request.get(`${MOCK_LLM_URL}/__mock/state`)
  expect(res.ok()).toBe(true)
  const state = (await res.json()) as { pending: number; consumed: number; errors: string[] }
  expect(state.errors).toEqual([])
  expect(state.pending).toBe(0)
}
