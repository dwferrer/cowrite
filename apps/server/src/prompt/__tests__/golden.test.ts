import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { assembleUserMessage, type PromptRegions } from '../regions.js'
import { loadTemplates, renderTemplate } from '../templates/loader.js'

/**
 * Golden render of docs/07-prompting.md §4 — the worked mid-novel `continue` example,
 * byte-exact. The fixture file is the doc's `not-xml` block verbatim; the inputs below are
 * what the context engine would hand over. Any byte drift here is a cache break in disguise.
 */

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')

/** The §4 worked example, as engine-shaped inputs. */
async function workedExampleRegions(): Promise<PromptRegions> {
  const templates = await loadTemplates()
  return {
    instructionsMarkup: renderTemplate(templates, 'continue'),
    worldInfo: [
      {
        id: '01J2N8Q3F7VWXK2MR9T5BCAD01',
        name: 'Mara Voss',
        fidelity: 'short',
        content:
          'Keeper of the Saltmarsh light; late forties, cropped grey hair, a ruined left hand she hides in\n' +
          'a fingerless glove. Widowed by the same storm the town pretends was weather.',
      },
      {
        id: '01J2N9AAE2QRSTK4MP7Y3XCD02',
        name: 'The storm glass',
        fidelity: 'full',
        content:
          'A sealed spirit-glass from the old lighthouse inventory. Its crystals bloom hours before\n' +
          'weather arrives — and, Mara now suspects, before other things arrive too.\n' +
          '\n' +
          '**Appearance:** a hand-blown teardrop of cloudy glass on a brass gimbal, whale-oil sheen.',
      },
    ],
    globalContext: [
      {
        id: '01HZQA55M2C8DWPN6R3VTEXA10',
        level: 'chapter',
        name: 'The Lighthouse Keeper',
        fidelity: 'short',
        content:
          'Mara Voss takes over the decommissioned Saltmarsh light after her predecessor drowns. She finds\n' +
          'the lamp room sealed from the inside and an inventory listing one item too many.',
      },
      {
        id: '01J2KF8T4YB1HZQX7WN2SDEA11',
        level: 'chapter',
        name: 'The Storm Glass',
        fidelity: 'long',
        content:
          'Mara retrieves the storm glass from the sealed lamp room. Over three nights its crystals bloom\n' +
          'in dead calm; each bloom precedes a boat failing to return. She logs the pattern, tells no one.\n' +
          '⋮ The chapter closes with Edlen, the harbormaster, demanding the inventory book "for the\n' +
          'insurers" and Mara handing him a copy with the glass\'s line inked out.',
      },
    ],
    voiceAnchors: [
      {
        from: 'The Lighthouse Keeper',
        tokens: 1010,
        text:
          'The light had been dark for eleven years, and the town had learned to say so the way you say a\n' +
          'grace — quickly, and without looking up. Mara carried her cases up the spiral stair one at a\n' +
          'time, resting on the landings, counting the gulls through the salt-fogged panes.\n' +
          '⋮',
      },
      {
        from: 'The Storm Glass',
        tokens: 980,
        text:
          'Third night. No wind, the marsh flat as poured lead, and the crystals climbing anyway —\n' +
          'feathering up the glass like frost in a hurry.\n' +
          '⋮',
      },
    ],
    expandedContext: [
      {
        kind: 'section',
        id: '01J2KF8T4YB1HZQX7WN2SDEA11',
        path: 'The Storm Glass',
        fidelity: 'full',
        content:
          'The lamp room key turned as if it had been oiled that morning.\n' +
          '⋮ (full chapter text — opened by the model two tasks ago; still within TTL)',
      },
    ],
    situation:
      'Scene: Mara confronts Edlen in the harbor office, dusk, storm building. She wants the original\n' +
      "inventory back. He knows more than he says. Don't resolve it yet — end with her outside in the\n" +
      'first rain.',
    taskMarkup: renderTemplate(templates, 'continue-task'),
    localContext: [
      {
        id: '01J2P7R9GT5W0ZNXK3M8QAB4CD',
        text:
          'The harbor office kept its lamps lit all day in October, which told you what the windows were\n' +
          "worth. Mara came in with the copy of the inventory under her arm and the original's absence\n" +
          'like a stone in her boot.',
      },
      {
        id: '01J2P7SVWX2Y1ANBK9M4QCD5EF',
        text:
          'Edlen did not stand. "Keeper," he said, and made the word sound like a job he\'d once turned\n' +
          'down.\n' +
          '⋮',
      },
    ],
  }
}

describe('golden: §4 worked example (mid-novel continue)', () => {
  it('renders the doc block byte-for-byte', async () => {
    const golden = await readFile(path.join(fixturesDir, 'continue-mid-novel.golden.txt'), 'utf8')
    const assembled = assembleUserMessage(await workedExampleRegions())
    expect(`${assembled}\n`).toBe(golden)
  })

  it('is byte-stable across repeated renders of identical inputs', async () => {
    const first = assembleUserMessage(await workedExampleRegions())
    const second = assembleUserMessage(await workedExampleRegions())
    expect(second).toBe(first)
  })

  it('back-to-back plain continues share every byte through <situation> (§5.1)', async () => {
    const regions = await workedExampleRegions()
    const before = assembleUserMessage(regions)
    const after = assembleUserMessage({
      ...regions,
      localContext: [
        ...(regions.localContext ?? []),
        { id: '01J2P7ZZZZZZZZZZZZZZZZZZZZ', text: 'The rain arrived sideways.' },
      ],
    })
    const stablePrefix = before.slice(0, before.indexOf('<task kind="continue">'))
    expect(after.startsWith(stablePrefix)).toBe(true)
    // the plain-continue <task> region is a byte-constant fixed string
    expect(after).toContain(
      '<task kind="continue">\nContinue the story directly from the end of <local-context>.\n</task>',
    )
  })
})
