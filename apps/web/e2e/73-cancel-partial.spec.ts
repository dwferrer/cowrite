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
 * Spec (d) — cancel mid-stream keeps the partial (docs/05-agents.md §6.3/§6.5;
 * docs/04-frontend.md §8.4): cancel the streaming continue with the ✕, the keep-partial
 * proposal banner replaces the streaming block, and "Keep partial as snippet" commits
 * the streamed prose with agent provenance through the durable proposal route.
 */

const PARTIAL_HEAD = 'The partial prose survived the cancel:'
const LONG_BODY =
  `${PARTIAL_HEAD} sentence one holds the early marker, ` +
  'sentence two keeps arriving on a slow drip so the test has a wide cancel window, ' +
  'sentence three would only exist if nobody pressed the button, ' +
  'and sentence four never streams at all because the socket closes first.'

test.beforeAll(async ({ request }) => {
  await ensureConfigured(request)
})

test('cancel mid-stream: keep-partial banner, apply commits the partial', async ({
  page,
  request,
}) => {
  await resetLlm(request)
  const work = await createWork(request, 'Cancel Partial Work')
  await createSnippet(request, work.id, 'A story worth interrupting.')
  await scriptLlm(request, [
    {
      // ~60 chunks × 150 ms ≈ 9 s of stream — the cancel lands well before the end
      type: 'respondStream',
      text: snippetBlock('new', LONG_BODY),
      chunkSize: 6,
      delayMs: 150,
      match: { model: 'mock-high' },
    },
  ])

  await page.goto(`/w/${work.id}`)
  await expect(page.getByTestId(testids.snippetBlock)).toHaveCount(1)
  await page.getByTestId(testids.frontierContinue).click()

  // wait for real streamed text, then cancel mid-stream
  await expect(page.getByTestId(testids.streamingText)).toContainText('partial prose survived', {
    timeout: 10_000,
  })
  await page.getByTestId(testids.streamingCancel).click()

  // the keep-partial card replaces the stream in the frontier slot (04 §8.4)
  const card = page.getByTestId(testids.keepPartial)
  await expect(card).toBeVisible({ timeout: 10_000 })
  await expect(card).toContainText('Generation cancelled')
  await expect(card).toContainText('partial prose survived')

  // keep it: the partial commits as a fresh agent snippet via the proposal route
  await page.getByTestId(testids.keepPartialApply).click()
  const blocks = page.getByTestId(testids.snippetBlock)
  await expect(blocks).toHaveCount(2, { timeout: 10_000 })
  await expect(blocks.nth(1)).toHaveAttribute('data-authorship', 'agent')
  await expect(blocks.nth(1)).toContainText('partial prose survived')
  // the un-streamed tail must NOT be in the committed partial
  await expect(blocks.nth(1)).not.toContainText('sentence four')
  await expect(page.getByTestId(testids.keepPartial)).toHaveCount(0)

  await assertLlmDrained(request)
})
