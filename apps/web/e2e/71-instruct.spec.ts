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
 * Spec (b) — instructed-continue (docs/04-frontend.md §8.2): the Instruct… affordance
 * expands into the instruction textarea, Ctrl-Enter launches the task, the instruction
 * rides the stream header, and the scripted response lands as an agent snippet. The
 * scenario's `lastMessageIncludes` match asserts the instruction actually reached the
 * prompt — a miss fails the mock loudly and the task errors.
 */

const INSTRUCTION = 'Take the story seaward: the ferry must leave tonight.'
const BODY =
  'Obedient to the instruction, the ferry cast off under a thin moon and took the story ' +
  'seaward, exactly as directed, with the harbor lights shrinking into a scripted distance.'

test.beforeAll(async ({ request }) => {
  await ensureConfigured(request)
})

test('Instruct…: the instruction reaches the prompt and the response lands', async ({
  page,
  request,
}) => {
  await resetLlm(request)
  const work = await createWork(request, 'Instructed Continue Work')
  await createSnippet(request, work.id, 'The ferry idled at the dock, engines warm.')
  await scriptLlm(request, [
    {
      type: 'respondStream',
      text: snippetBlock('new', BODY),
      chunkSize: 10,
      delayMs: 50,
      match: { model: 'mock-high', lastMessageIncludes: 'ferry must leave tonight' },
    },
  ])

  await page.goto(`/w/${work.id}`)
  await expect(page.getByTestId(testids.snippetBlock)).toHaveCount(1)

  await page.getByTestId(testids.frontierInstruct).click()
  const input = page.getByTestId(testids.frontierInstructInput)
  await expect(input).toBeFocused()
  await input.fill(INSTRUCTION)
  await input.press('Control+Enter')

  // the stream header carries the instruction (04 §8.2) while tokens arrive
  const streaming = page.getByTestId(testids.streamingBlock)
  await expect(streaming).toBeVisible()
  await expect(streaming).toContainText(INSTRUCTION)
  await expect(page.getByTestId(testids.streamingText)).toContainText('Obedient to the', {
    timeout: 10_000,
  })

  const blocks = page.getByTestId(testids.snippetBlock)
  await expect(blocks).toHaveCount(2, { timeout: 15_000 })
  await expect(blocks.nth(1)).toHaveAttribute('data-authorship', 'agent')
  await expect(blocks.nth(1)).toContainText('scripted distance')
  await expect(page.getByTestId(testids.streamingBlock)).toHaveCount(0)

  await assertLlmDrained(request)
})
