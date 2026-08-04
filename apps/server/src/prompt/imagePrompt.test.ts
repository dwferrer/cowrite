import { describe, expect, it } from 'vitest'
import { renderEstablishedImagery, renderGuidance } from './imagePrompt.js'

describe('image-prompt regions (07 §2.1, 08 §compose)', () => {
  it('renders established imagery items with their source names', () => {
    expect(
      renderEstablishedImagery([
        { from: 'Mara Voss', text: 'A woman in her late forties with cropped grey hair.' },
      ]),
    ).toBe(
      '<established-imagery>\n<imagery from="Mara Voss">\nA woman in her late forties with cropped grey hair.\n</imagery>\n</established-imagery>',
    )
  })

  it('omits empty regions', () => {
    expect(renderEstablishedImagery([])).toBeNull()
    expect(renderGuidance('')).toBeNull()
    expect(renderGuidance('  \n')).toBeNull()
  })

  it('wraps guidance verbatim', () => {
    expect(renderGuidance('warmer light, closer framing')).toBe(
      '<guidance>\nwarmer light, closer framing\n</guidance>',
    )
  })
})
