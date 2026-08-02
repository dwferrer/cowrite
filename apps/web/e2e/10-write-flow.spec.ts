import { expect, test } from '@playwright/test'
import { testids } from '../src/testids'
import { ensureConfigured } from './util'

/**
 * Spec (b) — the hand-writing flow (docs/09-testing.md §6.3 #1, Stage-2 subset): create a
 * work through the UI, open it, write two snippets in the frontier compose editor
 * (Ctrl-Enter saves), reload the page, and the prose is still there — real server, real
 * SSE echo, real files under the temp data dir.
 */

const SNIPPET_ONE = 'The lighthouse keeper counted the waves twice that morning.'
const SNIPPET_TWO = 'By noon the storm glass on the shelf had gone the color of milk.'

test.beforeAll(async ({ request }) => {
  await ensureConfigured(request)
})

test('create a work, hand-write two snippets, reload — text persists', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId(testids.worksList)).toBeVisible()

  await page.getByTestId(testids.worksCreateInput).fill('Write Flow Work')
  await page.getByTestId(testids.worksCreateButton).click()
  await expect(page).toHaveURL(/\/w\/[0-9A-Z]+$/)
  await expect(page.getByTestId(testids.docView)).toBeVisible()

  // snippet one via the frontier compose editor
  await page.getByTestId(testids.frontierNewSnippet).click()
  const editorText = page.getByTestId(testids.snippetEditor).getByLabel('Edit text')
  await editorText.fill(SNIPPET_ONE)
  await editorText.press('Control+Enter')
  await expect(page.getByTestId(testids.snippetBlock)).toHaveCount(1)
  await expect(page.getByTestId(testids.snippetBlock).first()).toContainText(
    'counted the waves twice',
  )

  // snippet two
  await page.getByTestId(testids.frontierNewSnippet).click()
  await editorText.fill(SNIPPET_TWO)
  await editorText.press('Control+Enter')
  await expect(page.getByTestId(testids.snippetBlock)).toHaveCount(2)
  await expect(page.getByTestId(testids.snippetBlock).nth(1)).toContainText('color of milk')

  // authorship tint marker (04 §5.1): hand-written snippets carry the user edge
  await expect(page.getByTestId(testids.snippetBlock).first()).toHaveAttribute(
    'data-authorship',
    'user',
  )

  // reload — everything came back from disk through the real API
  await page.reload()
  await expect(page.getByTestId(testids.snippetBlock)).toHaveCount(2)
  await expect(page.getByTestId(testids.snippetBlock).first()).toContainText(
    'counted the waves twice',
  )
  await expect(page.getByTestId(testids.snippetBlock).nth(1)).toContainText('color of milk')
})
