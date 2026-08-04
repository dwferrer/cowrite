import { expect, test } from '@playwright/test'
import { testids } from '../src/testids'
import {
  assertLlmDrained,
  createSnippet,
  createWork,
  ensureConfigured,
  resetLlm,
  scriptLlm,
  snippetBlock,
} from './util'

/**
 * Spec (a) — the flagship loop (docs/09-testing.md §6.3 #2; docs/10 Stage-3 gate): open a
 * work, Ctrl-Enter launches `continue`, the streaming block renders live tokens, the
 * committed snippet swaps in with agent authorship, and its provenance viewer shows the
 * prompt regions and the exact prompt text. Mock-driven: the server runs with
 * COWRITE_MOCK_LLM=1 and the test scripts one streamed composition.
 */

const SEED = 'The lighthouse keeper counted the boats out and counted them back in.'
const BODY =
  'The mock model continued the story from the counted boats, one steady clause after ' +
  'another, streaming slowly enough to watch: the tide turned, the lamps were trimmed, ' +
  'the ledger of hulls balanced at last, and the night settled toward a natural beat.'

test.beforeAll(async ({ request }) => {
  await ensureConfigured(request)
})

test('Ctrl-Enter continue: stream, agent snippet, provenance viewer', async ({ page, request }) => {
  await resetLlm(request)
  const work = await createWork(request, 'Flagship Continue Work')
  await createSnippet(request, work.id, SEED)
  // one scripted composition; the model match asserts interactive → high lane routing
  await scriptLlm(request, [
    {
      type: 'respondStream',
      text: snippetBlock('new', BODY),
      chunkSize: 8,
      delayMs: 60,
      match: { model: 'mock-high' },
    },
  ])

  await page.goto(`/w/${work.id}`)
  await expect(page.getByTestId(testids.docView)).toBeVisible()
  await expect(page.getByTestId(testids.snippetBlock)).toHaveCount(1)

  // global Ctrl-Enter with nothing selected launches Continue (04 §12)
  await page.keyboard.press('Control+Enter')

  // the streaming block appears and live tokens land in it mid-stream
  await expect(page.getByTestId(testids.streamingBlock)).toBeVisible()
  await expect(page.getByTestId(testids.streamingText)).toContainText('The mock model continued', {
    timeout: 10_000,
  })

  // completion: keyed swap — the committed snippet renders with agent authorship
  const blocks = page.getByTestId(testids.snippetBlock)
  await expect(blocks).toHaveCount(2, { timeout: 15_000 })
  const agentBlock = blocks.nth(1)
  await expect(agentBlock).toHaveAttribute('data-authorship', 'agent')
  await expect(agentBlock).toContainText('natural beat')
  await expect(page.getByTestId(testids.streamingBlock)).toHaveCount(0)

  // provenance: select the snippet — the footer links its origin run
  await agentBlock.click()
  await expect(page.getByTestId(testids.snippetFooter)).toBeVisible()
  await page.getByTestId(testids.snippetRunLink).first().click()

  const viewer = page.getByTestId(testids.runViewer)
  await expect(viewer).toBeVisible()
  await expect(page.getByTestId(testids.runViewerHeader)).toContainText('continue')
  await expect(page.getByTestId(testids.runViewerHeader)).toContainText('mock-high')

  // prompt region breakdown from the recorded ContextSnapshot (04 §7.4)
  await page.getByTestId(testids.runPromptToggle).click()
  await expect(page.getByTestId(testids.runRegion).first()).toBeVisible()

  // the exact prompt text is one click deeper — message roles from the run JSONL
  await page.getByTestId(testids.runPromptText).click()
  await expect(page.getByTestId(testids.runPromptMessage).first()).toBeVisible()

  // the streamed output was recorded too
  await expect(page.getByTestId(testids.runOutput)).toContainText('natural beat')

  await page.getByTestId(testids.runViewerClose).click()
  await expect(viewer).toHaveCount(0)

  await assertLlmDrained(request)
})
