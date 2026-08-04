import { describe, expect, it } from 'vitest'
import {
  ATTRIBUTE_VALUE_MAX_CHARS,
  CANONICAL_REGION_NAMES,
  closeTagLine,
  OUTPUT_BLOCK_TAG_NAMES,
  openTagLine,
  REGION_TAG_NAMES,
  sanitizeAttributeValue,
  selfClosingTagLine,
  tagBlock,
} from './tags.js'

describe('sanitizeAttributeValue (07 §1 rule 4)', () => {
  it('turns double quotes into single quotes', () => {
    expect(sanitizeAttributeValue('the "insurers" copy')).toBe("the 'insurers' copy")
  })

  it('turns each newline flavor into a single space', () => {
    expect(sanitizeAttributeValue('a\nb\r\nc\rd')).toBe('a b c d')
  })

  it('truncates to 120 chars', () => {
    const long = 'x'.repeat(200)
    expect(sanitizeAttributeValue(long)).toBe('x'.repeat(ATTRIBUTE_VALUE_MAX_CHARS))
  })

  it('truncates by code point, not UTF-16 unit', () => {
    const long = '𝕏'.repeat(130) // astral plane: 2 UTF-16 units each
    const out = sanitizeAttributeValue(long)
    expect(Array.from(out)).toHaveLength(ATTRIBUTE_VALUE_MAX_CHARS)
    expect(out.endsWith('𝕏')).toBe(true) // never split a surrogate pair
  })

  it('passes ids, fidelities, and short names through unchanged', () => {
    expect(sanitizeAttributeValue('01J2N8Q3F7VWXK2MR9T5BCAD01')).toBe('01J2N8Q3F7VWXK2MR9T5BCAD01')
    expect(sanitizeAttributeValue('Mara Voss')).toBe('Mara Voss')
    expect(sanitizeAttributeValue('The Storm Glass › The Lamp Room')).toBe(
      'The Storm Glass › The Lamp Room',
    )
  })
})

describe('tag emission (07 §1 rules 1–3)', () => {
  it('formats opening, closing, and self-closing tag lines', () => {
    expect(openTagLine('world-info')).toBe('<world-info>')
    expect(
      openTagLine('entry', [
        ['id', 'abc'],
        ['name', 'Mara'],
      ]),
    ).toBe('<entry id="abc" name="Mara">')
    expect(closeTagLine('world-info')).toBe('</world-info>')
    expect(
      selfClosingTagLine('section', [
        ['id', 'abc'],
        ['name', 'Ch 1'],
      ]),
    ).toBe('<section id="abc" name="Ch 1"/>')
  })

  it('emits attributes in caller order (byte determinism)', () => {
    expect(
      openTagLine('excerpt', [
        ['from', 'A'],
        ['tokens', '10'],
      ]),
    ).toBe('<excerpt from="A" tokens="10">')
    expect(
      openTagLine('excerpt', [
        ['tokens', '10'],
        ['from', 'A'],
      ]),
    ).toBe('<excerpt tokens="10" from="A">')
  })

  it('sanitizes attribute values but never content', () => {
    const prose = 'She said "run".\n\n<div>\n</world-info>\nDone.'
    expect(tagBlock('snippet', [['id', 'x"y']], prose)).toBe(
      `<snippet id="x'y">\n${prose}\n</snippet>`,
    )
  })

  it('absorbs a single trailing newline on block content', () => {
    expect(tagBlock('situation', [], 'notes\n')).toBe('<situation>\nnotes\n</situation>')
    expect(tagBlock('situation', [], 'notes')).toBe('<situation>\nnotes\n</situation>')
  })
})

describe('vocabulary (07 §2 — closed and exhaustive)', () => {
  it('canonical region names are the region tags without brackets', () => {
    for (const name of CANONICAL_REGION_NAMES) {
      expect(REGION_TAG_NAMES).toContain(name)
    }
  })

  it('matches the §2.5 output block set', () => {
    expect([...OUTPUT_BLOCK_TAG_NAMES]).toEqual([
      'snippet',
      'span',
      'title',
      'summary-short',
      'summary-long',
      'boundaries',
      'image-prompt',
    ])
  })
})
