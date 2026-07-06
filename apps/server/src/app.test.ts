import { healthResponseSchema } from '@cowrite/shared'
import { describe, expect, it } from 'vitest'
import { buildApp } from './app.js'

describe('GET /api/health', () => {
  it('returns a schema-valid health payload', async () => {
    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/api/health' })
    expect(res.statusCode).toBe(200)
    const body = healthResponseSchema.parse(res.json())
    expect(body.app).toBe('cowrite')
    await app.close()
  })
})
