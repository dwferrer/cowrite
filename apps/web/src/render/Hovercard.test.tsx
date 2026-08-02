import type { WorldEntryDto } from '@cowrite/shared'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { testids } from '../testids.js'
import { HovercardCard, hovercardExcerpt } from './Hovercard.js'

const entry = (overrides: Partial<WorldEntryDto> = {}): WorldEntryDto => ({
  id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  name: 'Mara Voss',
  keys: ['Mara'],
  body: 'First line of the body.\n\nSecond line here.\nThird line.\nFourth line never shows.',
  bodyHash: 'xxh64:0123456789abcdef',
  shortSummary: null,
  hasImage: false,
  imageVersion: null,
  updatedAt: '2026-08-01T12:00:00.000Z',
  ...overrides,
})

afterEach(cleanup)

describe('hovercardExcerpt', () => {
  it('prefers shortSummary when present', () => {
    expect(hovercardExcerpt(entry({ shortSummary: 'The ferry pilot.' }))).toBe('The ferry pilot.')
  })

  it('falls back to the first ~3 non-empty lines of the body', () => {
    expect(hovercardExcerpt(entry())).toBe('First line of the body. Second line here. Third line.')
  })

  it('returns empty for an empty body without summary', () => {
    expect(hovercardExcerpt(entry({ body: '' }))).toBe('')
  })
})

describe('HovercardCard', () => {
  it('renders name and the body fallback when shortSummary is missing', () => {
    render(<HovercardCard workId="W1" entry={entry()} onOpen={vi.fn()} />)
    const card = screen.getByTestId(testids.worldHovercard)
    expect(card.textContent).toContain('Mara Voss')
    expect(card.textContent).toContain('First line of the body.')
    expect(card.textContent).not.toContain('Fourth line')
    // no image → no thumbnail element
    expect(card.querySelector('img')).toBeNull()
  })

  it('renders the thumbnail slot and shortSummary when present', () => {
    render(
      <HovercardCard
        workId="W1"
        entry={entry({ shortSummary: 'The ferry pilot.', hasImage: true, imageVersion: 'abc' })}
        onOpen={vi.fn()}
      />,
    )
    const card = screen.getByTestId(testids.worldHovercard)
    expect(card.textContent).toContain('The ferry pilot.')
    const img = card.querySelector('img')
    expect(img?.getAttribute('src')).toContain('/image?v=abc')
  })
})
