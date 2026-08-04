import { describe, expect, it } from 'vitest'
import {
  assembleUserMessage,
  insertSelectionMarkers,
  renderEntryItem,
  renderExpandedContext,
  renderGlobalContext,
  renderLocalContext,
  renderLocalContextRefresh,
  renderSectionItem,
  renderSituation,
  renderSnippetItem,
  renderVoiceAnchors,
  renderWorldInfo,
} from './regions.js'

describe('item rendering (07 §2.2)', () => {
  it('renders a name-fidelity section as a self-closing one-liner without fidelity', () => {
    expect(renderSectionItem({ id: 'S1', level: 'chapter', name: 'Ch 1', fidelity: 'name' })).toBe(
      '<section id="S1" level="chapter" name="Ch 1"/>',
    )
  })

  it('renders summary fidelities as blocks with canonical attribute order', () => {
    expect(
      renderSectionItem({
        id: 'S1',
        level: 'chapter',
        name: 'Ch 1',
        fidelity: 'short',
        content: 'A summary.',
      }),
    ).toBe('<section id="S1" level="chapter" name="Ch 1" fidelity="short">\nA summary.\n</section>')
  })

  it('renders expanded sections with path instead of name when only path is given', () => {
    expect(
      renderSectionItem({ id: 'S1', path: 'The Storm Glass', fidelity: 'full', content: 'Prose.' }),
    ).toBe('<section id="S1" path="The Storm Glass" fidelity="full">\nProse.\n</section>')
  })

  it('renders a name-fidelity entry self-closing', () => {
    expect(renderEntryItem({ id: 'E1', name: 'Mara', fidelity: 'name' })).toBe(
      '<entry id="E1" name="Mara"/>',
    )
  })

  it('throws when content is missing above name fidelity', () => {
    expect(() => renderSectionItem({ id: 'S1', fidelity: 'short' })).toThrow(/requires content/)
    expect(() => renderEntryItem({ id: 'E1', name: 'Mara', fidelity: 'full' })).toThrow(
      /requires content/,
    )
  })

  it('marks the quick-edit target and brackets the selection in place (§2.4)', () => {
    const text = 'He stood. He left the room.'
    const rendered = renderSnippetItem({
      id: 'SN1',
      text,
      editTarget: true,
      selection: { start: 3, end: 9 },
    })
    expect(rendered).toBe(
      '<snippet id="SN1" role="edit-target">\nHe <selection>stood.</selection> He left the room.\n</snippet>',
    )
  })

  it('insertSelectionMarkers validates the span', () => {
    expect(insertSelectionMarkers('abcd', { start: 0, end: 4 })).toBe('<selection>abcd</selection>')
    expect(() => insertSelectionMarkers('abcd', { start: 2, end: 8 })).toThrow(/out of range/)
    expect(() => insertSelectionMarkers('abcd', { start: 3, end: 2 })).toThrow(/out of range/)
  })
})

describe('region rendering (07 §2.1)', () => {
  it('omits empty regions entirely — no husks', () => {
    expect(renderWorldInfo([])).toBeNull()
    expect(renderGlobalContext([])).toBeNull()
    expect(renderVoiceAnchors([])).toBeNull()
    expect(renderExpandedContext([])).toBeNull()
    expect(renderLocalContext([])).toBeNull()
    expect(renderSituation('')).toBeNull()
    expect(renderSituation('  \n ')).toBeNull()
  })

  it('packs items back-to-back with no blank line between them', () => {
    const region = renderWorldInfo([
      { id: 'E1', name: 'A', fidelity: 'short', content: 'One.' },
      { id: 'E2', name: 'B', fidelity: 'name' },
    ])
    expect(region).toBe(
      '<world-info>\n<entry id="E1" name="A" fidelity="short">\nOne.\n</entry>\n<entry id="E2" name="B"/>\n</world-info>',
    )
  })

  it('renders the refresh region verbatim (§6.7 shape)', () => {
    expect(renderLocalContextRefresh('tail prose')).toBe(
      '<local-context-refresh>\ntail prose\n</local-context-refresh>',
    )
  })
})

describe('assembleUserMessage (06 §5.1 order)', () => {
  const minimal = {
    instructionsMarkup: '<instructions>\nDo the thing.\n</instructions>\n',
    taskMarkup: '<task kind="continue">\nContinue.\n</task>\n',
    localContext: [{ id: 'SN1', text: 'Prose.' }],
  }

  it('joins non-empty regions with exactly one blank line and no trailing newline', () => {
    expect(assembleUserMessage(minimal)).toBe(
      '<instructions>\nDo the thing.\n</instructions>\n\n' +
        '<task kind="continue">\nContinue.\n</task>\n\n' +
        '<local-context>\n<snippet id="SN1">\nProse.\n</snippet>\n</local-context>',
    )
  })

  it('slots the situation between expanded context and task, and skips empties', () => {
    const message = assembleUserMessage({
      ...minimal,
      situation: 'Storm building.',
      worldInfo: [],
    })
    expect(message).toContain(
      '</instructions>\n\n<situation>\nStorm building.\n</situation>\n\n<task',
    )
    expect(message).not.toContain('<world-info>')
  })

  it('is byte-deterministic for identical inputs', () => {
    const a = assembleUserMessage({ ...minimal, situation: 'Same.' })
    const b = assembleUserMessage({ ...minimal, situation: 'Same.' })
    expect(a).toBe(b)
  })
})
