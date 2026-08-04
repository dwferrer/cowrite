import { expect, test } from '@playwright/test'
import { testids } from '../src/testids'
import {
  assertLlmDrained,
  boundariesBlock,
  consolidateNow,
  createSnippet,
  createWork,
  enrichBlock,
  ensureConfigured,
  type LlmStep,
  listSections,
  MANUAL_CONSOLIDATION,
  PAGE,
  patchConsolidation,
  resetLlm,
  scriptLlm,
} from './util'

/**
 * The fold ladder for real (docs/04-frontend.md §5.3; §15.2 spec 3): seed a work with 16
 * frozen chapters via the scripted consolidation pipeline, then assert the distance
 * ladder renders 2 full / 4 long / 8 short / 2 name, that summaries (not prose) are what
 * long/short show, and that a manual pin expands a name chapter to full prose — lazily
 * fetched, header position preserved, pin persisted across reload.
 *
 * Enrichment reality (05 §6.2): the post-consolidation enrich batch draws on the sweep
 * budget (4 per window), so only the FIRST four chapters enrich here — the rest would
 * wait for later sweep windows (subscriber + 60 s idle gates), far too slow for an e2e.
 * The remaining chapters get USER summaries via PUT …/summaries: the ladder needs
 * summary text, not agent provenance, and the pipeline path is covered by the 4-batch
 * (and by spec 81).
 */

const CHAPTERS = 16
/** The 05 §6.2 sweep-budget cap: how many enrich runs the post-apply batch enqueues. */
const ENRICH_BATCH = 4
// Enrich responses are IDENTICAL on purpose: the background lane runs 2 tasks
// concurrently, so response→chapter binding is nondeterministic — same text everywhere
// keeps the strict-order mock honest without caring which chapter got which response.
const TITLE = 'Frozen Crossing'
const SHORT = 'A crossing in one line.'
const LONG = 'The long account of the crossing, told over a few patient sentences.'

test.beforeAll(async ({ request }) => {
  await ensureConfigured(request)
})

test('fold ladder: distances, summaries, pin-to-full with preserved header position', async ({
  page,
  request,
}) => {
  // the scripted pipeline (1 boundary + 16 enrich runs) plus the UI walk needs headroom
  test.setTimeout(120_000)
  await resetLlm(request)
  const work = await createWork(request, 'Fold Ladder Novel')
  await patchConsolidation(request, work.id, { ...MANUAL_CONSOLIDATION, maxFrontierSnippets: 30 })

  // 20 snippets; the eligible prefix (minus the 2-snippet active window) covers 0..17 —
  // 16 cuts make 16 single-snippet chapters, leaving 4 frontier snippets.
  const snippets: Array<{ id: string }> = []
  for (let i = 0; i < 20; i++) {
    snippets.push(await createSnippet(request, work.id, `${PAGE} (ladder ${i + 1})`))
  }

  const cuts = snippets
    .slice(0, CHAPTERS)
    .map((s, i): [string, string] => [s.id, `Chapter ${i + 1}`])
  const steps: LlmStep[] = [
    { type: 'respond', text: boundariesBlock(cuts), match: { model: 'mock-low' } },
    ...Array.from(
      { length: ENRICH_BATCH },
      (): LlmStep => ({
        type: 'respond',
        text: enrichBlock(TITLE, SHORT, LONG),
        match: { model: 'mock-low' },
      }),
    ),
  ]
  await scriptLlm(request, steps)
  await consolidateNow(request, work.id)

  // the boundary task + journaled apply settle first: all 16 chapters exist
  await expect
    .poll(async () => (await listSections(request, work.id)).length, { timeout: 30_000 })
    .toBe(CHAPTERS)

  // chapters past the enrich batch get user summaries (same text; ladder parity)
  const applied = await listSections(request, work.id)
  for (const row of applied.slice(ENRICH_BATCH)) {
    const put = await request.put(`/api/works/${work.id}/sections/${row.id}/summaries`, {
      data: { short: SHORT, long: LONG },
    })
    expect(put.ok()).toBe(true)
  }

  // …and the batch enrich (chapters 1-4, document order) lands title + both summaries
  await expect
    .poll(
      async () => {
        const rows = await listSections(request, work.id)
        return (
          rows.every((r) => r.shortSummary !== null && r.longSummary !== null) &&
          rows[0]?.title === TITLE
        )
      },
      { timeout: 30_000 },
    )
    .toBe(true)
  const sections = await listSections(request, work.id)

  // a tall viewport mounts every virtualized block, so ladder counts are assertable flat
  await page.setViewportSize({ width: 1280, height: 8000 })
  await page.goto(`/w/${work.id}`)
  await expect(page.getByTestId(testids.docView)).toBeVisible()
  // measured heights can still exceed the viewport; pin the scroll to the top so the
  // earliest chapters are inside the virtualizer's mounted range for the assertions
  await page.getByTestId(testids.docView).evaluate((el) => {
    el.scrollTop = 0
  })
  await expect(page.getByTestId(testids.snippetBlock)).toHaveCount(4)

  // the ladder (d = 15..0): 2 name / 8 short / 4 long / 2 full
  const foldCount = (fold: string) =>
    page.locator(`[data-testid="${testids.sectionBlock}"][data-fold="${fold}"]`)
  await expect(foldCount('full')).toHaveCount(2)
  await expect(foldCount('long')).toHaveCount(4)
  await expect(foldCount('short')).toHaveCount(8)
  await expect(page.getByTestId(testids.nameCard)).toHaveCount(2)

  // long/short render SUMMARIES; deep-past name cards carry the title + one-line hook
  await expect(foldCount('short').first()).toContainText(SHORT)
  await expect(foldCount('long').first()).toContainText(LONG)
  await expect(page.getByTestId(testids.nameCard).first()).toContainText(TITLE)
  // collapsed bodies carry the subtle fidelity affordance
  await expect(page.getByTestId(testids.sectionFoldHint).first()).toContainText('summary')

  // ---- pin chapter 1 (a name card) to full ----
  const first = sections[0]
  if (!first) throw new Error('no first section')
  const header = page.locator(
    `[data-testid="${testids.sectionHeader}"][data-section-id="${first.id}"]`,
  )
  await expect(header).toHaveAttribute('data-fold', 'name')
  const before = await header.boundingBox()

  const contentReq = page.waitForRequest(`**/api/works/${work.id}/sections/${first.id}/content`)
  await header.locator(`[data-testid="${testids.foldDot}"][data-level="full"]`).click()
  await contentReq // the lazy leaf-prose fetch fired (§5.6)

  await expect(header).toHaveAttribute('data-fold', 'full')
  // the chapter's real prose (its consumed snippet) is on screen
  await expect(foldCount('full').first()).toContainText('(ladder 1)')
  await expect(foldCount('full')).toHaveCount(3)
  await expect(page.getByTestId(testids.nameCard)).toHaveCount(1)

  // the pinned header stayed put (±2 px) while everything below grew (§5.5)
  const after = await header.boundingBox()
  expect(Math.abs((after?.y ?? Number.NaN) - (before?.y ?? 0))).toBeLessThanOrEqual(2)

  // ---- the pin persists across reload (panelStore persist, §5.3) ----
  await page.reload()
  await expect(page.getByTestId(testids.docView)).toBeVisible()
  await expect(header).toHaveAttribute('data-fold', 'full')
  await expect(foldCount('full').first()).toContainText('(ladder 1)')

  // ---- auto resets the pin back to the distance default ----
  await header.locator(`[data-testid="${testids.foldAuto}"]`).click()
  await expect(header).toHaveAttribute('data-fold', 'name')
  await expect(page.getByTestId(testids.nameCard)).toHaveCount(2)

  await assertLlmDrained(request)
})
