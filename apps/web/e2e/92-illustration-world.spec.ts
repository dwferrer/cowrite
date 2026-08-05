import { expect, test } from '@playwright/test'
import { testids } from '../src/testids'
import {
  assertComfyDrained,
  assertLlmDrained,
  createWork,
  ensureConfigured,
  illustrationCritiqueText,
  illustrationPromptText,
  resetComfy,
  resetLlm,
  scriptComfy,
  scriptLlm,
} from './util'

/**
 * Spec (c) — the world-entry "Generate image" flow (docs/08-illustration.md §4, §6, §8;
 * docs/04-frontend.md §9.3): from a fresh entry with no image, Generate opens the optional
 * one-line guidance box, submitting launches a `world-image` task, the shimmer covers the
 * reserved slot, and the committed PNG appears live. The low lane scripts the compose +
 * critique calls; ComfyUI is scripted with a deliberate queue/exec delay (like the 90-spec)
 * so the shimmer is reliably on-screen to observe — an UNSCRIPTED render auto-succeeds
 * instantly (09 §2.3), which can commit the image before the shimmer assertion ever polls.
 */

test.beforeAll(async ({ request }) => {
  await ensureConfigured(request)
})

test('world entry "Generate": guidance box, shimmer, committed image', async ({
  page,
  request,
}) => {
  await resetLlm(request)
  await resetComfy(request)
  const work = await createWork(request, 'Illustrate World Work')

  await page.goto(`/w/${work.id}`)
  await page.getByTestId(testids.worldToggle).click()
  await expect(page.getByTestId(testids.worldPanel)).toBeVisible()
  await page.getByTestId(testids.worldCreateName).fill('Storm Glass')
  await page.getByTestId(testids.worldCreateButton).click()
  await expect(page.getByTestId(testids.worldEntryDetail)).toBeVisible()
  await page
    .getByTestId(testids.worldBodyText)
    .fill('A weathered glass orb said to warn of storms.')
  await page.getByTestId(testids.worldBodySave).click()

  // A deliberate queue + exec delay keeps the shimmer on-screen long enough to observe (the
  // compose/critique low-lane calls have no delay knob, so the ComfyUI leg buys the time).
  await scriptComfy(request, [{ type: 'image', queueMs: 150, execMs: 400, progressTicks: 4 }])
  await scriptLlm(request, [
    {
      type: 'respond',
      text: illustrationPromptText(
        'A weathered glass orb on a wooden sill, storm light inside swirling faintly, ' +
          'rain-streaked window behind it, moody teal and amber palette, still life.',
      ),
      match: { model: 'mock-low' },
    },
    {
      type: 'respond',
      text: illustrationCritiqueText({ verdict: 'accept', overall: 7.5 }),
      match: { model: 'mock-low' },
    },
  ])

  // no committed image yet — Generate opens the optional guidance box first
  await expect(page.getByTestId(testids.worldImage)).toHaveCount(0)
  await page.getByTestId(testids.worldImageGenerate).click()
  await page.getByTestId(testids.worldImageGuidanceSubmit).click()

  const shimmer = page.getByTestId(testids.illustrationShimmer)
  await expect(shimmer).toBeVisible()
  await expect(shimmer).toHaveCount(0, { timeout: 20_000 })

  const img = page.getByTestId(testids.worldImage)
  await expect(img).toBeVisible()
  await expect
    .poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0))
    .toBe(true)

  await assertLlmDrained(request)
  await assertComfyDrained(request)
})
