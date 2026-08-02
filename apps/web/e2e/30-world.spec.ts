import { expect, test } from '@playwright/test'
import { testids } from '../src/testids'
import { createSnippet, createWork, ensureConfigured } from './util'

/**
 * Spec (d) — the world flow (docs/09-testing.md §6.3 #6, Stage-2 subset): create an entry
 * with a key, the key underlines in the rendered prose (`span.wi`), hovering opens the
 * one global hovercard, and clicking navigates to the entry detail.
 */

let workId: string

test.beforeAll(async ({ request }) => {
  await ensureConfigured(request)
  const work = await createWork(request, 'World Flow Work')
  workId = work.id
  await createSnippet(request, workId, 'The storm glass glowed on the shelf all night.')
})

test('world entry with a key: underline → hovercard → navigate', async ({ page }) => {
  await page.goto(`/w/${workId}`)
  await expect(page.getByTestId(testids.snippetBlock).first()).toContainText('storm glass')

  // open the world panel, create the entry
  await page.getByTestId(testids.worldToggle).click()
  await expect(page.getByTestId(testids.worldPanel)).toBeVisible()
  await page.getByTestId(testids.worldCreateName).fill('Storm Glass')
  await page.getByTestId(testids.worldCreateButton).click()
  await expect(page.getByTestId(testids.worldEntryDetail)).toBeVisible()
  const entryUrl = page.url()
  const entryId = entryUrl.slice(entryUrl.lastIndexOf('/') + 1)

  // add the matching key and a summary for the hovercard
  await page.getByTestId(testids.worldKeyInput).fill('storm glass')
  await page.getByTestId(testids.worldKeyInput).press('Enter')
  await expect(page.getByTestId(testids.worldKeyChip)).toContainText('storm glass')
  await page.getByTestId(testids.worldShortSummary).fill('A weather-omen curio.')
  await page.getByTestId(testids.worldShortSummary).blur()

  // close the panel; the matcher rebuilt from the world list → underline span appears
  await page.getByTestId(testids.worldPanelClose).click()
  const underline = page.locator(`span.wi[data-entry-id="${entryId}"]`).first()
  await expect(underline).toBeVisible()
  await expect(underline).toHaveText('storm glass')

  // hover 350 ms → hovercard with name + summary
  await underline.hover()
  const hovercard = page.getByTestId(testids.worldHovercard)
  await expect(hovercard).toBeVisible()
  await expect(hovercard).toContainText('Storm Glass')
  await expect(hovercard).toContainText('A weather-omen curio.')

  // click the underlined key → entry detail route
  await underline.click()
  await expect(page).toHaveURL(new RegExp(`/w/${workId}/world/${entryId}$`))
  await expect(page.getByTestId(testids.worldEntryDetail)).toBeVisible()
  await expect(page.getByTestId(testids.worldEntryName)).toHaveValue('Storm Glass')
})
