import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  defaultTemplatesDir,
  fillTemplate,
  INTERACTIVE_TEMPLATES,
  loadTemplates,
  renderTemplate,
  TEMPLATE_NAMES,
  TemplateSlotError,
} from './loader.js'

async function copySetTo(dir: string): Promise<void> {
  const source = defaultTemplatesDir()
  for (const name of TEMPLATE_NAMES) {
    await writeFile(path.join(dir, `${name}.md`), await readFile(path.join(source, `${name}.md`)))
  }
}

describe('loadTemplates', () => {
  it('loads the complete checked-in v0 set', async () => {
    const set = await loadTemplates()
    expect([...set.templates.keys()].sort()).toEqual([...TEMPLATE_NAMES].sort())
    for (const text of set.templates.values()) expect(text.length).toBeGreaterThan(0)
  })

  it('ships only known templates in the directory (hash covers the whole set)', async () => {
    const files = (await readdir(defaultTemplatesDir())).filter((f) => f.endsWith('.md'))
    expect(files.sort()).toEqual(TEMPLATE_NAMES.map((n) => `${n}.md`).sort())
  })

  it('stamps a stable xxh64 promptsHash for identical content', async () => {
    const a = await loadTemplates()
    const b = await loadTemplates()
    expect(a.promptsHash).toMatch(/^xxh64:[0-9a-f]{16}$/)
    expect(b.promptsHash).toBe(a.promptsHash)
  })

  it('changes promptsHash when any template byte changes', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cowrite-prompts-'))
    await copySetTo(dir)
    const original = await loadTemplates(dir)
    expect(original.promptsHash).toBe((await loadTemplates()).promptsHash)
    const repairPath = path.join(dir, 'repair.md')
    await writeFile(repairPath, `${await readFile(repairPath, 'utf8')}!`)
    const edited = await loadTemplates(dir)
    expect(edited.promptsHash).not.toBe(original.promptsHash)
  })

  it('fails loudly on a missing template file', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cowrite-prompts-'))
    await expect(loadTemplates(dir)).rejects.toThrow(/prompt template missing/)
  })
})

describe('fillTemplate', () => {
  it('fills every slot occurrence', () => {
    expect(fillTemplate('Edit snippet {{targetId}}: {{targetId}} again.', { targetId: 'A1' })).toBe(
      'Edit snippet A1: A1 again.',
    )
  })

  it('inserts values verbatim — no $-pattern semantics, no re-scanning', () => {
    expect(fillTemplate('X {{v}} Y', { v: "$& $' {{v}}" })).toBe("X $& $' {{v}} Y")
  })

  it('throws on an unfilled slot, naming it', () => {
    expect(() => fillTemplate('{{instruction}}', {})).toThrow(TemplateSlotError)
    expect(() => fillTemplate('{{instruction}}', {})).toThrow(/instruction/)
  })

  it('throws on a provided value no slot consumes', () => {
    expect(() => fillTemplate('no slots here', { stray: 'x' })).toThrow(/unknown template slot/)
  })
})

describe('the v0 wording (07 §6)', () => {
  it('system.md is slot-free and states the delineation rules', async () => {
    const set = await loadTemplates()
    const system = renderTemplate(set, 'system') // would throw if it had slots
    expect(system).toContain('IS the manuscript')
    expect(system).toContain('never transcribe them')
    expect(system).toContain('Do not drift toward the register of')
  })

  it('the plain-continue task region is the fixed byte-constant string (§5.1)', async () => {
    const set = await loadTemplates()
    expect(renderTemplate(set, 'continue-task')).toBe(
      '<task kind="continue">\nContinue the story directly from the end of <local-context>.\n</task>\n',
    )
  })

  it('instructed-continue shares continue instructions and differs only in <task> (§6.2)', async () => {
    const set = await loadTemplates()
    const task = renderTemplate(set, 'instructed-continue-task', {
      instruction: 'Edlen finally names the thing in the water.',
    })
    expect(task).toContain('<task kind="instructed-continue">')
    expect(task).toContain(
      '<user-instructions>\nEdlen finally names the thing in the water.\n</user-instructions>',
    )
    expect(INTERACTIVE_TEMPLATES.continue.instructions).toBe(
      INTERACTIVE_TEMPLATES['instructed-continue'].instructions,
    )
  })

  it('quick-edit templates echo the target id and wrap user material (§6.3)', async () => {
    const set = await loadTemplates()
    const instructions = renderTemplate(set, 'quick-edit', {
      targetId: '01J2P7R9GT5W0ZNXK3M8QAB4CD',
    })
    expect(instructions).toContain('<snippet id="01J2P7R9GT5W0ZNXK3M8QAB4CD">')
    const task = renderTemplate(set, 'quick-edit-task', {
      targetId: '01J2P7R9GT5W0ZNXK3M8QAB4CD',
      instruction: 'Make him angrier.',
      selectionText: 'he said',
    })
    expect(task).toContain('Edit snippet 01J2P7R9GT5W0ZNXK3M8QAB4CD.')
    expect(task).toContain('<user-instructions>\nMake him angrier.\n</user-instructions>')
    expect(task).toContain('<selection-excerpt>\nhe said\n</selection-excerpt>')
  })

  it('refresh and repair templates carry the §6.7/§6.8 wording', async () => {
    const set = await loadTemplates()
    const refresh = renderTemplate(set, 'refresh', { refreshTail: 'last prose lines' })
    expect(refresh).toContain('<local-context-refresh>\nlast prose lines\n</local-context-refresh>')
    expect(refresh).toContain('Planning is over.')
    const repair = renderTemplate(set, 'repair', { blockList: '<snippet id="new">' })
    expect(repair).toBe(
      'Your reply did not contain the required <snippet id="new"> block(s). Reply again with only the\n' +
        'required block(s) — opening tag on its own line, content, closing tag on its own line — and no\n' +
        'other text.\n',
    )
  })

  it('enrich and boundaries templates keep their Stage-4 slots', async () => {
    const set = await loadTemplates()
    const enrich = set.templates.get('enrich') ?? ''
    for (const slot of [
      'matchedEntries',
      'precedingSiblingShorts',
      'sectionId',
      'sectionName',
      'content',
    ]) {
      expect(enrich).toContain(`{{${slot}}}`)
    }
    const boundaries = set.templates.get('boundaries') ?? ''
    for (const slot of ['minWords', 'maxWords', 'lastTwoFrozenShorts', 'eligibleSnippets']) {
      expect(boundaries).toContain(`{{${slot}}}`)
    }
  })
})
