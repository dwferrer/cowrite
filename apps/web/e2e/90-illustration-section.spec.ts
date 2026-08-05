import { expect, test } from '@playwright/test'
import { testids } from '../src/testids'
import {
  assertComfyDrained,
  assertLlmDrained,
  createLeafSection,
  createWork,
  ensureConfigured,
  illustrationCritiqueText,
  illustrationPromptText,
  resetComfy,
  resetLlm,
  resetSectionIllustration,
  scriptComfy,
  scriptLlm,
} from './util'

/**
 * Spec (a) — the illustrate-section flow end to end (docs/08-illustration.md §4, §8;
 * docs/04-frontend.md §10): pressing "Illustrate" on an enriched leaf section shimmers the
 * reserved image box with cycling `task.progress` phase captions, then swaps in the
 * committed PNG live (no reload). Mock-driven: the low lane scripts one compose + one
 * accepting critique; the mock ComfyUI is scripted with a deliberate queue/exec delay so
 * the shimmer's phase captions are reliably observable (never a sleep in the test itself).
 */

test.beforeAll(async ({ request }) => {
  await ensureConfigured(request)
})

test('Illustrate: shimmer cycles phase captions, then the committed PNG appears', async ({
  page,
  request,
}) => {
  await resetLlm(request)
  await resetComfy(request)
  const work = await createWork(request, 'Illustrate Section Work')
  const { sectionId } = await createLeafSection(request, work.id, 'The Lighthouse')
  // createLeafSection's guaranteed post-enrich auto-illustrate already committed one image
  // (see its doc comment) — suppress it so THIS test starts from a genuine blank slate and
  // presses "Illustrate" itself, matching the scenario under test.
  await resetSectionIllustration(request, work.id, sectionId)

  // A deliberate queue + exec delay (350 ms total, 4 progress ticks) makes "Queued" then
  // "Generating (…%)" observable — the compose/critique low-lane calls have no delay knob,
  // so the ComfyUI leg is what buys the shimmer its on-screen time.
  await scriptComfy(request, [{ type: 'image', queueMs: 150, execMs: 400, progressTicks: 4 }])
  await scriptLlm(request, [
    {
      type: 'respond',
      text: illustrationPromptText(
        'A weathered stone lighthouse on a storm-lit cliff, waves breaking white below, ' +
          'one lit window near the top, dusk clouds racing overhead, dramatic chiaroscuro.',
      ),
      match: { model: 'mock-low' },
    },
    {
      type: 'respond',
      text: illustrationCritiqueText({ verdict: 'accept', overall: 8 }),
      match: { model: 'mock-low' },
    },
  ])

  await page.goto(`/w/${work.id}`)
  await expect(page.getByTestId(testids.sectionHeader)).toContainText('The Lighthouse')
  // the SSE connection must be live BEFORE we launch the task, or its task.queued/started/
  // progress frames fire into a socket nobody is listening on yet (offlineBanner shows until
  // `connected` flips true — 04 §4.2).
  await expect(page.getByTestId(testids.offlineBanner)).toHaveCount(0)

  const header = page.getByTestId(testids.sectionHeader).filter({ hasText: 'The Lighthouse' })
  await header.getByTestId(testids.sectionMenuButton).click()
  await expect(page.getByTestId(testids.sectionMenu)).toBeVisible()
  await page.getByTestId(testids.illustrateAction).click()

  // the shimmer appears over the reserved box, captions cycling through the pipeline phases
  const shimmer = page.getByTestId(testids.illustrationShimmer)
  await expect(shimmer).toBeVisible()
  const caption = page.getByTestId(testids.illustrationCaption)
  await expect(caption).toHaveText(/Queued|Composing|Submitting/, { timeout: 5_000 })
  await expect(caption).toContainText('Generating', { timeout: 5_000 })

  // completion: the shimmer clears and the committed PNG swaps in live
  await expect(shimmer).toHaveCount(0, { timeout: 20_000 })
  const img = page.getByTestId(testids.illustrationImage)
  await expect(img).toBeVisible()
  await expect(img).toHaveAttribute('src', new RegExp(`/sections/${sectionId}/illustration`))
  await expect
    .poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0))
    .toBe(true)

  await assertLlmDrained(request)
  await assertComfyDrained(request)
})
