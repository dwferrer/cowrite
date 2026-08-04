import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { templateRenderer } from './renderer.js'
import { defaultTemplatesDir, loadTemplates, TEMPLATE_NAMES } from './templates/loader.js'

/**
 * The renderer-wiring regression (07 §6): the prompt/templates/*.md files are the ONE
 * wording source — editing a template file must change BOTH the rendered prompt AND the
 * stamped promptsHash, in lockstep. (When this landed, the engine's hardcoded
 * defaultRenderer strings were deleted and the golden prompt bytes re-baselined once —
 * a one-time cache-prefix reset; see context/assemble.ts's header note.)
 */

async function copySetTo(dir: string): Promise<void> {
  const source = defaultTemplatesDir()
  for (const name of TEMPLATE_NAMES) {
    await writeFile(path.join(dir, `${name}.md`), await readFile(path.join(source, `${name}.md`)))
  }
}

describe('templateRenderer over a template set', () => {
  it('editing a template file changes the rendered prompt AND promptsHash together', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cowrite-renderer-'))
    await copySetTo(dir)
    const before = await loadTemplates(dir)
    const beforeTask = templateRenderer(before).taskRegion({ kind: 'continue' })

    const taskPath = path.join(dir, 'continue-task.md')
    await writeFile(
      taskPath,
      '<task kind="continue">\nContinue the story. EDITED WORDING.\n</task>\n',
    )
    const after = await loadTemplates(dir)
    const afterTask = templateRenderer(after).taskRegion({ kind: 'continue' })

    expect(afterTask.body).toBe('Continue the story. EDITED WORDING.')
    expect(afterTask.body).not.toBe(beforeTask.body) // the prompt actually changed…
    expect(after.promptsHash).not.toBe(before.promptsHash) // …and the hash attributes it
  })

  it('renders the checked-in wording (the engine sees template bytes, not constants)', async () => {
    const renderer = templateRenderer(await loadTemplates())
    expect(renderer.taskRegion({ kind: 'continue' })).toEqual({
      attrs: { kind: 'continue' },
      body: 'Continue the story directly from the end of <local-context>.',
    })
    const instructed = renderer.taskRegion({
      kind: 'instructed-continue',
      instruction: 'Bring in the storm.',
    })
    expect(instructed.attrs).toEqual({ kind: 'instructed-continue' })
    expect(instructed.body).toContain(
      '<user-instructions>\nBring in the storm.\n</user-instructions>',
    )
    expect(renderer.systemPrompt()).toContain('IS the manuscript')
    expect(renderer.refreshTurn('tail prose')).toContain(
      '<local-context-refresh>\ntail prose\n</local-context-refresh>',
    )
  })

  it('composeUserMessage wraps regions with the ONE tag grammar (sanitized attrs)', async () => {
    const renderer = templateRenderer(await loadTemplates())
    const message = renderer.composeUserMessage([
      { name: 'instructions', body: 'I', tokens: 1 },
      {
        name: 'task',
        attrs: { kind: 'continue', note: 'quote " and\nnewline' },
        body: 'T',
        tokens: 1,
      },
    ])
    expect(message).toBe(
      '<instructions>\nI\n</instructions>\n\n' +
        `<task kind="continue" note="quote ' and newline">\nT\n</task>`,
    )
  })
})
