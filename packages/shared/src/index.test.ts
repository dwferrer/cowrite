import { describe, expect, it } from 'vitest'
import { healthResponseSchema } from './index.js'

describe('healthResponseSchema', () => {
  it('accepts a valid health payload', () => {
    const parsed = healthResponseSchema.parse({ status: 'ok', app: 'cowrite', version: '0.0.1' })
    expect(parsed.version).toBe('0.0.1')
  })

  it('rejects unknown status values', () => {
    expect(() =>
      healthResponseSchema.parse({ status: 'down', app: 'cowrite', version: '0.0.1' }),
    ).toThrow()
  })
})
