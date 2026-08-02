import { describe, expect, it } from 'vitest'
import { detectDialogue } from './dialogue.js'

describe('detectDialogue', () => {
  it('finds a simple straight-quoted range including the quote marks', () => {
    const text = 'She said, "hello there" and left.'
    expect(detectDialogue(text)).toEqual([[10, 23]])
    expect(text.slice(10, 23)).toBe('"hello there"')
  })

  it('pairs curly quotes with curly closers', () => {
    const text = '“Storm’s coming,” she said.'
    expect(detectDialogue(text)).toEqual([[0, 17]])
    expect(text.slice(0, 17)).toBe('“Storm’s coming,”')
  })

  it('closes an unclosed quote at paragraph end', () => {
    const text = 'He whispered, "wait'
    expect(detectDialogue(text)).toEqual([[14, text.length]])
  })

  it('finds multiple ranges in one paragraph', () => {
    const text = '"Yes," she said. "No," he said.'
    const ranges = detectDialogue(text)
    expect(ranges).toEqual([
      [0, 6],
      [17, 22],
    ])
    expect(text.slice(17, 22)).toBe('"No,"')
  })

  it('does not open a quote glued to a word character (inch marks, code-ish text)', () => {
    expect(detectDialogue('a 5" nail and a 3" screw')).toEqual([])
  })

  it('opens after punctuation like an em-dash or parenthesis', () => {
    const text = '(“aside”) and —"dash"'
    const ranges = detectDialogue(text)
    expect(ranges).toHaveLength(2)
    const first = ranges[0] as readonly [number, number]
    const second = ranges[1] as readonly [number, number]
    expect(text.slice(first[0], first[1])).toBe('“aside”')
    expect(text.slice(second[0], second[1])).toBe('"dash"')
  })

  it('a mismatched closer does not close a curly opener', () => {
    // straight " inside a curly quote is content, not a closer
    const text = '“a 5" nail” done'
    expect(detectDialogue(text)).toEqual([[0, 11]])
  })

  it('returns nothing for prose without quotes', () => {
    expect(detectDialogue('Mara crossed at night; the glass cracked.')).toEqual([])
  })
})
