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
  listSnippets,
  MANUAL_CONSOLIDATION,
  PAGE,
  patchConsolidation,
  resetLlm,
  scriptLlm,
} from './util'

/**
 * The consolidation-under-edit guard (docs/04-frontend.md §7.1, §15.2 spec 10; docs/02
 * §6.2): an open editor pins its snippet OUT of the eligible prefix via the editing
 * signal. A forced consolidation with a scripted proposal that cuts both before AND at
 * the edited snippet must apply only the earlier cut — earlier snippets freeze, the
 * boundary touching the edited snippet is dropped, the editor survives, and save works.
 */

test.beforeAll(async ({ request }) => {
  await ensureConfigured(request)
})

test('editing pins the snippet out of the eligible prefix; earlier snippets freeze', async ({
  page,
  request,
}) => {
  await resetLlm(request)
  const work = await createWork(request, 'Consolidation Under Edit Work')
  await patchConsolidation(request, work.id, MANUAL_CONSOLIDATION)

  const snippets: Array<{ id: string }> = []
  for (let i = 0; i < 8; i++) {
    snippets.push(await createSnippet(request, work.id, `${PAGE} (guard ${i + 1})`))
  }
  const cutEarly = snippets[1]
  const cutAtEdited = snippets[4]
  if (!cutEarly || !cutAtEdited) throw new Error('missing snippets')

  await page.goto(`/w/${work.id}`)
  await expect(page.getByTestId(testids.snippetBlock)).toHaveCount(8)

  // open the editor on snippet 5 (an otherwise-eligible middle snippet) — this fires
  // POST /editing, which truncates the eligible prefix at snippets 1..4 (02 §6.2)
  await page.getByTestId(testids.snippetBlock).nth(4).dblclick()
  const editor = page.getByTestId(testids.snippetEditor)
  await expect(editor).toBeVisible()

  // scripted proposal: one legal cut (after snippet 2) and one that would consume the
  // edited snippet (after snippet 5) — the second MUST be dropped by §6.3 validation
  const steps: LlmStep[] = [
    {
      type: 'respond',
      text: boundariesBlock([
        [cutEarly.id, 'Fore'],
        [cutAtEdited.id, 'Never Applied'],
      ]),
      match: { model: 'mock-low' },
    },
    {
      type: 'respond',
      text: enrichBlock('Fore', 'Two pages, one line.', 'Two pages, at length.'),
      match: { model: 'mock-low' },
    },
  ]
  await scriptLlm(request, steps)
  await consolidateNow(request, work.id)

  // exactly ONE chapter appears (snippets 1..2); the illegal cut never applied
  await expect(page.getByTestId(testids.sectionHeader)).toHaveCount(1, { timeout: 20_000 })
  await expect(page.getByTestId(testids.sectionHeader)).toContainText('Fore')
  await expect(page.getByTestId(testids.snippetBlock)).toHaveCount(6)

  // the edited snippet survived in the frontier with its editor still open
  await expect(editor).toBeVisible()
  const textarea = editor.locator('textarea')
  await expect(textarea).toHaveValue(/\(guard 5\)/)
  const remaining = await listSnippets(request, work.id)
  expect(remaining.map((s) => s.id)).toEqual(snippets.slice(2).map((s) => s.id))

  // save succeeds: the snippet was never frozen out from under the cursor (04 §7.1)
  await textarea.fill('The edited fifth page, saved after the freeze.')
  await textarea.press('Control+Enter')
  await expect(editor).toHaveCount(0)
  await expect(
    page.getByTestId(testids.snippetBlock).filter({ hasText: 'saved after the freeze' }),
  ).toHaveCount(1)

  await assertLlmDrained(request)
})
