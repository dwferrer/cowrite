import { expect, test } from '@playwright/test'
import { testids } from '../src/testids'
import {
  assertLlmDrained,
  boundariesBlock,
  createSnippet,
  createWork,
  enrichBlock,
  ensureConfigured,
  type LlmStep,
  MANUAL_CONSOLIDATION,
  PAGE,
  patchConsolidation,
  resetLlm,
  scriptLlm,
} from './util'

/**
 * The consolidation flow end to end in the UI (docs/04-frontend.md §4.3, §15.2 spec 4;
 * docs/02 §6): writing past the frontier thresholds arms the debounce, the scripted
 * boundary agent cuts a chapter, the toast offers Undo until the grace deadline, the
 * frontier visibly shrinks live (no reload), enrichment clears the staleness badge with
 * the background pulse dot showing the lane at work — then Undo restores the frontier.
 */

const TITLE = 'The Crossing'

test.beforeAll(async ({ request }) => {
  await ensureConfigured(request)
})

test('write past thresholds → toast → chapter appears → enrich → undo restores', async ({
  page,
  request,
}) => {
  await resetLlm(request)
  const work = await createWork(request, 'Consolidation Flow Work')
  // auto path: short debounce, low snippet threshold (over requires >6)
  await patchConsolidation(request, work.id, {
    ...MANUAL_CONSOLIDATION,
    maxFrontierSnippets: 6,
    debounceMs: 400,
  })

  const snippets: Array<{ id: string }> = []
  for (let i = 0; i < 6; i++) {
    snippets.push(await createSnippet(request, work.id, `${PAGE} (flow ${i + 1})`))
  }

  const cut = snippets[2]
  if (!cut) throw new Error('missing snippet')
  const steps: LlmStep[] = [
    { type: 'respond', text: boundariesBlock([[cut.id, TITLE]]), match: { model: 'mock-low' } },
    {
      // the enrich run streams slowly so the background pulse dot is reliably visible
      type: 'respondStream',
      text: enrichBlock(TITLE, 'They cross at night.', 'The crossing, at length.'),
      chunkSize: 4,
      delayMs: 100,
      match: { model: 'mock-low' },
    },
  ]
  await scriptLlm(request, steps)

  await page.goto(`/w/${work.id}`)
  await expect(page.getByTestId(testids.docView)).toBeVisible()
  await expect(page.getByTestId(testids.snippetBlock)).toHaveCount(6)
  await expect(page.getByTestId(testids.sectionHeader)).toHaveCount(0)

  // the 7th write crosses the threshold; the 400 ms debounce fires the pipeline
  await createSnippet(request, work.id, `${PAGE} (flow 7)`)
  await expect(page.getByTestId(testids.snippetBlock)).toHaveCount(7)

  // toast: 'Chapter 1 "The Crossing" frozen' with a live Undo (04 §4.3)
  const toast = page.getByTestId(testids.toast).filter({ hasText: 'frozen' })
  await expect(toast).toBeVisible({ timeout: 20_000 })
  await expect(toast).toContainText(`Chapter 1 "${TITLE}" frozen`)
  const undoButton = toast.getByRole('button', { name: 'Undo' })
  await expect(undoButton).toBeVisible()

  // the frontier shrank LIVE (snippets 1..3 consumed) and the chapter appeared
  await expect(page.getByTestId(testids.sectionHeader)).toHaveCount(1)
  await expect(page.getByTestId(testids.snippetBlock)).toHaveCount(4)
  await expect(page.getByTestId(testids.sectionHeader)).toContainText(TITLE)

  // fresh sections are stale until enrichment lands (02 §6.5 missing-counts-as-stale)
  await expect(page.getByTestId(testids.staleBadge)).toBeVisible()

  // the background lane is at work: pulse dot + popover naming the enrich task (04 §4.4)
  const dot = page.getByTestId(testids.backgroundDot)
  await expect(dot).toBeVisible()
  await dot.click()
  await expect(page.getByTestId(testids.backgroundTaskRow)).toContainText('enrich-section')

  // enrichment arrival is LIVE: the badge clears and the dot goes away without reload
  await expect(page.getByTestId(testids.staleBadge)).toHaveCount(0, { timeout: 20_000 })
  await expect(page.getByTestId(testids.backgroundDot)).toHaveCount(0, { timeout: 20_000 })

  // ---- undo within the grace window: byte-identical frontier restore (02 §6.4) ----
  await undoButton.click()
  await expect(page.getByTestId(testids.sectionHeader)).toHaveCount(0, { timeout: 20_000 })
  await expect(page.getByTestId(testids.snippetBlock)).toHaveCount(7)
  // the first restored snippet is back in place, oldest first
  await expect(page.getByTestId(testids.snippetBlock).first()).toContainText('(flow 1)')

  await assertLlmDrained(request)
})
