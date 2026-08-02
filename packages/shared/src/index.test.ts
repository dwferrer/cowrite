import { describe, expect, it } from 'vitest'
import { api } from './api.js'
import { healthResponseSchema } from './index.js'

describe('healthResponseSchema', () => {
  it('is the 03 §3.12 shape {ok: true, version, uptime}', () => {
    const parsed = healthResponseSchema.parse({ ok: true, version: '0.0.1', uptime: 3.25 })
    expect(parsed).toEqual({ ok: true, version: '0.0.1', uptime: 3.25 })
  })

  it('rejects the pre-Stage-2 {status, app, version} shape and ok: false', () => {
    expect(
      healthResponseSchema.safeParse({ status: 'ok', app: 'cowrite', version: '0.0.1' }).success,
    ).toBe(false)
    expect(healthResponseSchema.safeParse({ ok: false, version: '0.0.1', uptime: 1 }).success).toBe(
      false,
    )
  })

  it('is identity-equal to the route registry health schema (the contract-test invariant)', () => {
    expect(healthResponseSchema).toBe(api.health.res)
  })
})
