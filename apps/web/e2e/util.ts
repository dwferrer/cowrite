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
