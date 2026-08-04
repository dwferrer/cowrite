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
 * Spec (e) — SSE reconnect mid-generation replays the snapshot (docs/03-api.md §8.3):
 * a full page reload is the harshest reconnect — the new page never saw `task.started`
 * or any delta. On mount the client hydrates the running task from GET /tasks, the bus
 * answers the fresh connection with a synthetic `task.snapshot` carrying everything
 * streamed so far, and live deltas resume on top — no text lost, and the run still
 * completes into a committed snippet. (Chosen over CDP connection-dropping: a reload is
 * deterministic and exercises the same snapshot path.)
 */

const EARLY = 'The early sentences streamed before the reload happened,'
const LATE = 'and the late sentences finished after the page came back.'
const BODY =
  `${EARLY} filling the accumulator that the reconnect snapshot must replay in one piece, ` +
  `with enough slow drip to survive a full page reload in the middle, ${LATE}`

test.beforeAll(async ({ request }) => {
  await ensureConfigured(request)
})

test('page reload mid-generation: snapshot replays, stream resumes, snippet lands', async ({
  page,
  request,
}) => {
  await resetLlm(request)
  const work = await createWork(request, 'Reconnect Work')
  await createSnippet(request, work.id, 'A story that survives reconnects.')
  await scriptLlm(request, [
    {
      // ~55 chunks × 200 ms ≈ 11 s — the reload happens around the 2 s mark
      type: 'respondStream',
      text: snippetBlock('new', BODY),
      chunkSize: 8,
      delayMs: 200,
      match: { model: 'mock-high' },
    },
  ])

  await page.goto(`/w/${work.id}`)
  await expect(page.getByTestId(testids.snippetBlock)).toHaveCount(1)
  await page.getByTestId(testids.frontierContinue).click()
  await expect(page.getByTestId(testids.streamingText)).toContainText('early sentences', {
    timeout: 10_000,
  })

  // the harshest reconnect: a fresh page mid-generation
  await page.reload()
  await expect(page.getByTestId(testids.docView)).toBeVisible()

  // the streaming block is back, and the snapshot replayed the pre-reload text
  await expect(page.getByTestId(testids.streamingBlock)).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId(testids.streamingText)).toContainText('early sentences', {
    timeout: 10_000,
  })

  // live deltas resume on top of the snapshot and the run completes normally
  const blocks = page.getByTestId(testids.snippetBlock)
  await expect(blocks).toHaveCount(2, { timeout: 20_000 })
  await expect(blocks.nth(1)).toHaveAttribute('data-authorship', 'agent')
  await expect(blocks.nth(1)).toContainText('early sentences')
  await expect(blocks.nth(1)).toContainText('after the page came back')
  await expect(page.getByTestId(testids.streamingBlock)).toHaveCount(0)

  await assertLlmDrained(request)
})
