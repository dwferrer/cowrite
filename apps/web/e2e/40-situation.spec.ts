import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { testids } from '../src/testids'
import { createWork, e2eDataDir, ensureConfigured } from './util'

/**
 * Spec (e) — the situation pane (docs/04-frontend.md §9.1): debounced save with the
 * content-hash token, then the conflict path — an EXTERNAL write to situation.md between
 * saves makes the next PUT 409, surfacing the theirs/mine chip instead of silently
 * clobbering the file (02 §8).
 */

const FIRST_NOTE = 'First note from the pane.'
const EXTERNAL_NOTE = 'External edit written straight to situation.md.'
const SECOND_NOTE = 'Second draft typed while the file changed under us.'

let workId: string
let workSlug: string

test.beforeAll(async ({ request }) => {
  await ensureConfigured(request)
  const work = await createWork(request, 'Situation Work')
  workId = work.id
  workSlug = work.slug
})

test('situation saves, then an external edit forces the theirs/mine conflict', async ({ page }) => {
  await page.goto(`/w/${workId}`)
  await page.getByTestId(testids.situationToggle).click()
  await expect(page.getByTestId(testids.situationPane)).toBeVisible()

  // click the rendered view → textarea; type; the debounced save lands with a tick
  await page.getByTestId(testids.situationRendered).click()
  const textarea = page.getByTestId(testids.situationText)
  await textarea.fill(FIRST_NOTE)
  await expect(page.getByTestId(testids.situationSavedTick)).toBeVisible({ timeout: 10_000 })

  // the file on disk is the human-readable markdown we just typed
  const situationPath = join(e2eDataDir(), 'works', workSlug, 'situation.md')
  expect(readFileSync(situationPath, 'utf8')).toBe(FIRST_NOTE)

  // external writer changes the file — the server compares hashes at PUT time (02 §6.6)
  writeFileSync(situationPath, EXTERNAL_NOTE, 'utf8')

  // the next edit's save carries the now-stale baseHash ⇒ 409 ⇒ the conflict banner
  // (distinct testid from the SSE "changed on disk" chip, which may also appear).
  await textarea.fill(SECOND_NOTE)
  const banner = page.getByTestId(testids.situationConflict)
  await expect(banner).toBeVisible({ timeout: 10_000 })

  // "Take theirs": reload the disk version, drop the local draft. Clicking the banner
  // button also blurs the textarea, which re-commits the held draft against the
  // still-stale hash — a second deterministic 409 — so the banner returns while the
  // pane (back in rendered view) shows the disk text.
  await page.getByTestId(testids.situationConflictTheirs).click()
  await expect(page.getByTestId(testids.situationRendered)).toContainText(EXTERNAL_NOTE)
  expect(readFileSync(situationPath, 'utf8')).toBe(EXTERNAL_NOTE)

  // "Keep mine": resubmit the held draft against the reloaded hash — the save goes through
  await expect(banner).toBeVisible({ timeout: 10_000 })
  await page.getByTestId(testids.situationConflictMine).click()
  await expect(banner).toHaveCount(0)
  // The banner clears synchronously on click while the PUT is still in flight — wait on
  // visible state (the saved tick) before asserting the disk write landed (09 §6.1).
  await expect(page.getByTestId(testids.situationSavedTick)).toBeVisible({ timeout: 10_000 })
  await expect.poll(() => readFileSync(situationPath, 'utf8')).toBe(SECOND_NOTE)
  await expect(page.getByTestId(testids.situationRendered)).toContainText(SECOND_NOTE)
})
