import { expect, test } from '@playwright/test'
import { testids } from '../src/testids'
import {
  assertLlmDrained,
  createSnippet,
  createWork,
  ensureConfigured,
  resetLlm,
  scriptLlm,
  snippetBlock,
} from './util'

/**
 * Spec (f) — 429-then-success surfaces the retrying badge (docs/05-agents.md §6.4;
 * docs/04-frontend.md §8.3): the first model call answers 429 with Retry-After, the
 * client honors it and replays, and the streaming block shows the "retrying" status
 * line while it waits; the second call streams the composition and the snippet lands.
 */

const BODY =
  'After one rate-limit bounce the mock endpoint relented and streamed the whole ' +
  'composition without further complaint, proving the badge and the retry both work.'

test.beforeAll(async ({ request }) => {
  await ensureConfigured(request)
})

test('429 then success: retrying badge, then the snippet lands', async ({ page, request }) => {
  await resetLlm(request)
  const work = await createWork(request, 'Retry Work')
  await createSnippet(request, work.id, 'A story the rate limiter briefly interrupted.')
  await scriptLlm(request, [
    // Retry-After: 2 s — a wide, deterministic window for the badge assertion
    { type: 'http', status: 429, retryAfterMs: 2000, match: { model: 'mock-high' } },
    {
      type: 'respondStream',
      text: snippetBlock('new', BODY),
      chunkSize: 10,
      delayMs: 50,
      match: { model: 'mock-high' },
    },
  ])

  await page.goto(`/w/${work.id}`)
  await expect(page.getByTestId(testids.snippetBlock)).toHaveCount(1)
  await page.getByTestId(testids.frontierContinue).click()

  // the badge appears while the client sleeps out the Retry-After window
  const badge = page.getByTestId(testids.streamingRetrying)
  await expect(badge).toBeVisible({ timeout: 10_000 })
  await expect(badge).toContainText('retrying (attempt 2)')

  // …and CLEARS on the first post-retry delta — the replayed stream is live again,
  // so the badge must not linger under freshly arriving prose (04 §8.3).
  await expect(page.getByTestId(testids.streamingText)).toContainText('After one rate-limit', {
    timeout: 15_000,
  })
  await expect(badge).toHaveCount(0)

  // then the replayed call streams and commits normally
  const blocks = page.getByTestId(testids.snippetBlock)
  await expect(blocks).toHaveCount(2, { timeout: 15_000 })
  await expect(blocks.nth(1)).toHaveAttribute('data-authorship', 'agent')
  await expect(blocks.nth(1)).toContainText('relented and streamed')
  await expect(page.getByTestId(testids.streamingBlock)).toHaveCount(0)

  await assertLlmDrained(request)
})
