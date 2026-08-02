import { expect, test } from '@playwright/test'
import { testids } from '../src/testids'
import { createSnippet, createWork, ensureConfigured } from './util'

/**
 * Spec (c) — edit / cycle / restore (docs/09-testing.md §6.3 #2, Stage-2 subset):
 * double-click opens the plaintext editor, Ctrl-Enter saves one revision; the selection
 * toolbar's cycler peeks back (purely visual) and Restore appends a NEW revision with the
 * old text — history is never rewritten.
 */

const REV_ONE = 'Rev one: the harbor was empty at dawn.'
const REV_TWO = 'Rev two: the harbor was crowded by dusk.'

let workId: string

test.beforeAll(async ({ request }) => {
  await ensureConfigured(request)
  const work = await createWork(request, 'Revise Cycle Work')
  workId = work.id
  await createSnippet(request, workId, REV_ONE)
})

test('revise a snippet, peek an old revision, restore it', async ({ page }) => {
  await page.goto(`/w/${workId}`)
  const block = page.getByTestId(testids.snippetBlock).first()
  await expect(block).toContainText('empty at dawn')

  // double-click → editor; edit; Ctrl-Enter → rev 2
  await block.dblclick()
  const editorText = page.getByTestId(testids.snippetEditor).getByLabel('Edit text')
  await editorText.fill(REV_TWO)
  await editorText.press('Control+Enter')
  await expect(block).toContainText('crowded by dusk')

  // single-click select → toolbar + cycler
  await block.click()
  await expect(page.getByTestId(testids.selectionToolbar)).toBeVisible()
  const cycler = page.getByTestId(testids.revisionCycler)
  await expect(cycler).toContainText('rev 2/2')

  // step back: peek banner + rev-1 text (display only)
  await page.getByTestId(testids.revisionPrev).click()
  await expect(page.getByTestId(testids.revisionPeekBanner)).toBeVisible()
  await expect(page.getByTestId(testids.revisionPeekBanner)).toContainText('viewing rev 1 of 2')
  await expect(block).toContainText('empty at dawn')

  // restore: rev 3 exists with rev-1 text, peek cleared
  await page.getByTestId(testids.revisionRestore).click()
  await expect(page.getByTestId(testids.revisionPeekBanner)).toHaveCount(0)
  await expect(block).toContainText('empty at dawn')
  await expect(page.getByTestId(testids.revisionCycler)).toContainText('rev 3/3')

  // the footer agrees after a reload — the revision log is on disk, not just in caches
  await page.reload()
  const reloaded = page.getByTestId(testids.snippetBlock).first()
  await expect(reloaded).toContainText('empty at dawn')
  await reloaded.click()
  await expect(page.getByTestId(testids.snippetFooter)).toContainText('rev 3/3')
})
