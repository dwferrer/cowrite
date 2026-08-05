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
  scriptComfy,
  scriptLlm,
} from './util'

/**
 * Spec (b) — "Regenerate…" with a guidance string (docs/08-illustration.md §4.2, §4.3, §8;
 * docs/04-frontend.md §10): a new image replaces the old one live, and the provenance
 * viewer for that run shows the guidance verbatim (rendered into the composed prompt's
 * `<guidance>` region) plus the full critique transcript. The scripted regenerate run is a
 * revise-then-accept loop (two attempts) so the transcript has something to show: two
 * composed-prompt entries and two critique entries.
 */

const GUIDANCE = 'show the storm from the cliff edge, dusk light, no figures'

test.beforeAll(async ({ request }) => {
  await ensureConfigured(request)
})

test('Regenerate with guidance: new image + provenance shows guidance and critique transcript', async ({
  page,
  request,
}) => {
  await resetLlm(request)
  await resetComfy(request)
  const work = await createWork(request, 'Illustrate Regenerate Work')
  // createLeafSection's guaranteed post-enrich auto-illustrate (see its doc comment) already
  // committed an initial image — exactly the pre-existing image this spec's "Regenerate…"
  // scenario needs, no separate setup illustrate required.
  const { illustrationVersion: firstVersion } = await createLeafSection(
    request,
    work.id,
    'The Cove',
  )

  // The regenerate run: revise-then-accept (two attempts), so the transcript has two
  // composed-prompt entries and two critiques to assert against.
  await scriptComfy(request, [{ type: 'image' }, { type: 'image' }])
  await scriptLlm(request, [
    {
      type: 'respond',
      text: illustrationPromptText(
        'A storm-lit cove seen from a high cliff edge at dusk, wind-driven spray, no figures, ' +
          'moody violet clouds, dramatic scale.',
      ),
      match: { model: 'mock-low' },
    },
    {
      type: 'respond',
      text: illustrationCritiqueText({
        verdict: 'revise',
        overall: 5,
        problems: ['the cliff edge is not readable'],
        promptAdvice: 'push the cliff edge into the foreground silhouette',
      }),
      match: { model: 'mock-low' },
    },
    {
      type: 'respond',
      text: illustrationPromptText(
        'A storm-lit cove from a jagged cliff-edge silhouette in the foreground at dusk, wind-' +
          'driven spray below, no figures, moody violet clouds, dramatic scale.',
      ),
      match: { model: 'mock-low' },
    },
    {
      type: 'respond',
      text: illustrationCritiqueText({ verdict: 'accept', overall: 8.5 }),
      match: { model: 'mock-low' },
    },
  ])

  await page.goto(`/w/${work.id}`)
  const firstImg = page.getByTestId(testids.illustrationImage)
  await expect(firstImg).toBeVisible()
  const firstSrc = await firstImg.getAttribute('src')
  expect(firstSrc).toContain(firstVersion)
  // the SSE connection must be live before we launch the regenerate task (see 90-spec).
  await expect(page.getByTestId(testids.offlineBanner)).toHaveCount(0)

  const header = page.getByTestId(testids.sectionHeader).filter({ hasText: 'The Cove' })
  await header.getByTestId(testids.sectionMenuButton).click()
  await page.getByTestId(testids.regenerateAction).click()
  await expect(page.getByTestId(testids.regenerateGuidanceBox)).toBeVisible()
  await page.getByTestId(testids.regenerateGuidanceInput).fill(GUIDANCE)
  await page.getByTestId(testids.regenerateGuidanceSubmit).click()

  // shimmer, then the new committed image swaps in live
  await expect(page.getByTestId(testids.illustrationShimmer)).toBeVisible()
  await expect(page.getByTestId(testids.illustrationShimmer)).toHaveCount(0, { timeout: 30_000 })
  const img = page.getByTestId(testids.illustrationImage)
  await expect.poll(async () => img.getAttribute('src'), { timeout: 5_000 }).not.toBe(firstSrc)

  // open the lightbox, then the provenance viewer for the regenerate run — the footer
  // lists runs oldest-first (initial illustrate, then regenerate), so the LAST link is ours
  await img.click()
  const lightbox = page.getByTestId(testids.illustrationLightbox)
  await expect(lightbox).toBeVisible()
  const runLinks = page.getByTestId(testids.illustrationRunLink)
  await expect(runLinks).toHaveCount(2)
  await runLinks.last().click()

  const viewer = page.getByTestId(testids.runViewer)
  await expect(viewer).toBeVisible()
  await expect(page.getByTestId(testids.runViewerHeader)).toContainText('illustrate-section')

  const illustrationSection = page.getByTestId(testids.runIllustrationSection)
  await expect(illustrationSection).toBeVisible()
  await expect(page.getByTestId(testids.runIllustrationPrompt)).toHaveCount(2)
  await expect(page.getByTestId(testids.runIllustrationCritique)).toHaveCount(2)
  await expect(page.getByTestId(testids.runIllustrationCritique).first()).toContainText('revise')
  await expect(page.getByTestId(testids.runIllustrationCritique).nth(1)).toContainText('accept')
  await expect(page.getByTestId(testids.runIllustrationArtifactImage)).toBeVisible()

  // the guidance rode along verbatim in the composed prompt's <guidance> region
  await page.getByTestId(testids.runPromptText).click()
  const guidanceMessage = page.getByTestId(testids.runPromptMessage).filter({ hasText: GUIDANCE })
  await expect(guidanceMessage.first()).toBeVisible()

  await page.getByTestId(testids.runViewerClose).click()
  await expect(viewer).toHaveCount(0)

  await assertLlmDrained(request)
  await assertComfyDrained(request)
})
