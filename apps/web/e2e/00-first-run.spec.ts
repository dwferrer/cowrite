import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { testids } from '../src/testids'
import { e2eHomeDir } from './util'

/**
 * Spec 0 — first-run setup (docs/09-testing.md §6.3 #0, Stage-2 subset): a fresh browser
 * profile with no endpoints redirects the FIRST visit to the welcome settings screen,
 * which offers an explicit skip — hand-writing must work with zero endpoints (03 §9.4).
 * After that first encounter the works list is always reachable; a dismissible banner
 * replaces the redirect. Saving with no models writes a valid config file (effectively
 * dataDir-only — dataDir itself is env-overridden for the run).
 *
 * This file must run FIRST (workers: 1, alphabetical order): later specs configure the
 * high lane via the API, which would defeat the redirect assertions here. Each test gets
 * a fresh browser context (fresh localStorage), so the first-encounter redirect applies
 * per test until the high model is configured.
 */

test('first boot redirects to welcome settings; skip reaches the works list', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveURL(/\/settings$/)
  await expect(page.getByTestId(testids.settingsScreen)).toBeVisible()
  await expect(page.getByTestId(testids.settingsFirstRun)).toBeVisible()
  await expect(page.getByTestId(testids.settingsCardHigh)).toBeVisible()

  // 03 §9.4: the works list IS reachable with zero endpoints via the skip link
  await page.getByTestId(testids.settingsSkipLink).click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByTestId(testids.worksList)).toBeVisible()

  // the redirect is replaced by a small dismissible banner
  await expect(page.getByTestId(testids.modelsBanner)).toBeVisible()
  await page.getByTestId(testids.modelsBannerDismiss).click()
  await expect(page.getByTestId(testids.modelsBanner)).toHaveCount(0)

  // navigating again in the same session never gates
  await page.goto('/')
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByTestId(testids.worksList)).toBeVisible()
})

test('saving a models-free config persists; the works list stays reachable', async ({ page }) => {
  await page.goto('/settings')
  await page.getByTestId(testids.settingsSaveButton).click()
  // the save round-trips: the settings screen re-seeds from the response without erroring
  await expect(page.getByTestId(testids.settingsSaveButton)).toBeEnabled()
  await expect(page.locator('[role="alert"]')).toHaveCount(0)

  // the config file on disk is the settings screen's serialization (JSONC with a pointer
  // comment) and still has both lanes null
  const configText = readFileSync(join(e2eHomeDir(), 'config.jsonc'), 'utf8')
  expect(configText).toContain('"schemaVersion": 1')
  expect(configText).toContain('"high": null')
  expect(configText).toContain('"low": null')

  // setup has been seen (this very settings visit): '/' no longer redirects even though
  // the models are still unconfigured
  await page.goto('/')
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByTestId(testids.worksList)).toBeVisible()
  await expect(page.getByTestId(testids.modelsBanner)).toBeVisible()
})

test('configuring the high model unlocks the works list without the banner', async ({ page }) => {
  await page.goto('/settings')
  const highCard = page.getByTestId(testids.settingsCardHigh)
  await highCard.getByLabel('Base URL').fill('http://127.0.0.1:9/v1')
  await highCard.getByLabel('Model').fill('e2e-stub-high')
  await page.getByTestId(testids.settingsSaveButton).click()
  // saved: the screen drops out of first-run welcome mode
  await expect(page.getByTestId(testids.settingsFirstRun)).toHaveCount(0)

  await page.goto('/')
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByTestId(testids.worksList)).toBeVisible()
  await expect(page.getByTestId(testids.modelsBanner)).toHaveCount(0)
})
