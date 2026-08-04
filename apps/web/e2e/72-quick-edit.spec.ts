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
 * Spec (c) — quick-edit on a selected snippet (docs/04-frontend.md §7.2, §8.3, §8.4):
 * the happy path shows the "being rewritten" shimmer (no mid-document token streaming)
 * and swaps the committed revision in atomically; the conflict path (the snippet mutates
 * under the run via the API) surfaces the apply-anyway/discard proposal card, and
 * "keep mine" (Discard) preserves the user's text.
 */

const ORIGINAL = 'The storm glass sat on the shelf, cloudy and ignored by everyone.'
const REWRITE =
  'The storm glass sat on the shelf, gone the color of milk, and this deterministic ' +
  'mock rewrite tightened the sentence exactly as instructed.'

test.beforeAll(async ({ request }) => {
  await ensureConfigured(request)
})

test('quick-edit: shimmer while rewriting, atomic revision swap', async ({ page, request }) => {
  await resetLlm(request)
  const work = await createWork(request, 'Quick Edit Work')
  const snippet = await createSnippet(request, work.id, ORIGINAL)
  await scriptLlm(request, [
    {
      type: 'respondStream',
      text: snippetBlock(snippet.id, REWRITE),
      chunkSize: 8,
      delayMs: 60,
      match: { model: 'mock-high', lastMessageIncludes: 'Tighten this sentence' },
    },
  ])

  await page.goto(`/w/${work.id}`)
  const block = page.getByTestId(testids.snippetBlock)
  await expect(block).toHaveCount(1)

  // single-click selects; the quick-edit box appears under the selection toolbar
  await block.click()
  const input = page.getByTestId(testids.quickEditInput)
  await expect(input).toBeVisible()
  await input.fill('Tighten this sentence.')
  await input.press('Control+Enter')

  // the shimmer replaces token streaming for targeted rewrites (04 §8.3)
  await expect(page.getByTestId(testids.snippetRewriting)).toBeVisible()
  await expect(page.getByTestId(testids.snippetRewriting)).toContainText('being rewritten')
  // and no live text renders mid-document while it runs
  await expect(page.getByTestId(testids.streamingText)).toHaveCount(0)

  // atomic swap: the committed revision replaces the text, shimmer gone
  await expect(block).toContainText('deterministic mock rewrite', { timeout: 15_000 })
  await expect(page.getByTestId(testids.snippetRewriting)).toHaveCount(0)

  await assertLlmDrained(request)
})

test('quick-edit conflict: mutate under the run, then keep mine', async ({ page, request }) => {
  await resetLlm(request)
  const work = await createWork(request, 'Quick Edit Conflict Work')
  const snippet = await createSnippet(request, work.id, ORIGINAL)
  const USER_TEXT = 'The user rewrote the storm glass line while the agent was busy.'
  await scriptLlm(request, [
    {
      // slow stream: a wide window for the mid-run mutation below
      type: 'respondStream',
      text: snippetBlock(snippet.id, REWRITE),
      chunkSize: 5,
      delayMs: 100,
      match: { model: 'mock-high' },
    },
  ])

  await page.goto(`/w/${work.id}`)
  const block = page.getByTestId(testids.snippetBlock)
  await block.click()
  const input = page.getByTestId(testids.quickEditInput)
  await input.fill('Tighten this sentence.')
  await input.press('Control+Enter')
  await expect(page.getByTestId(testids.snippetRewriting)).toBeVisible()

  // mutate the target under the run: the task's baseRev is now stale (05 §5.6)
  const patch = await request.patch(`/api/works/${work.id}/snippets/${snippet.id}`, {
    data: { text: USER_TEXT, baseRev: snippet.rev },
  })
  expect(patch.ok()).toBe(true)

  // completion degrades to a conflict proposal — the diff-less card (04 §8.4)
  const card = page.getByTestId(testids.keepPartial)
  await expect(card).toBeVisible({ timeout: 15_000 })
  await expect(card).toContainText('Text changed while editing')
  await expect(card).toContainText('deterministic mock rewrite') // the buffered rewrite, copyable

  // keep mine: Discard preserves the user's mutation
  await page.getByTestId(testids.keepPartialDiscard).click()
  await expect(card).toHaveCount(0)
  await expect(block).toContainText('user rewrote the storm glass')
  await expect(block).not.toContainText('deterministic mock rewrite')

  await assertLlmDrained(request)
})
