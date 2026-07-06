import { describe, expect, it } from 'vitest'
import { SituationDto } from './situation.js'

describe('SituationDto', () => {
  it('round-trips a situation payload', () => {
    const dto = {
      text: 'Mara confronts the harbormaster; storm building',
      updatedAt: '2026-07-06T13:55:00Z',
      hash: 'xxh64:abababababababab',
    }
    expect(SituationDto.parse(dto)).toEqual(dto)
  })

  it('accepts an empty text (absent situation.md = empty) and rejects missing fields', () => {
    expect(
      SituationDto.parse({
        text: '',
        updatedAt: '2026-07-06T13:55:00Z',
        hash: 'xxh64:0000000000000000',
      }).text,
    ).toBe('')
    expect(SituationDto.safeParse({ text: 'x' }).success).toBe(false)
    // the concurrency token is the content hash — it is not optional
    expect(SituationDto.safeParse({ text: 'x', updatedAt: '2026-07-06T13:55:00Z' }).success).toBe(
      false,
    )
  })
})
