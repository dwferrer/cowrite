import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createWorkViaApi,
  destroyTestCtx,
  expectEnvelope,
  makeTestCtx,
  NO_SUCH_ID,
  type TestCtx,
} from './testUtil.js'

/**
 * Registered-but-stubbed routes (docs/03-api.md §6.2): the remaining Stage-5 routes
 * exist now and answer 501 with the §7 envelope carrying the `not_implemented` code.
 * Task/run/proposal routes went live with the Stage-3 harness, the consolidation
 * controls with the Stage-4 scheduler (both tested in src/harness/);
 * `/tasks/estimate` is M2 and deliberately absent (404).
 */

let ctx: TestCtx

beforeEach(async () => {
  ctx = await makeTestCtx()
})

afterEach(async () => {
  await destroyTestCtx(ctx)
})

const w = `/api/works/${NO_SUCH_ID}`

const STUBS: Array<{ method: 'GET' | 'POST'; url: string; payload?: Record<string, unknown> }> = [
  { method: 'GET', url: '/api/illustration/health' },
]

describe('stub routes', () => {
  it('answers 501 not_implemented with the envelope on every stub route', async () => {
    for (const { method, url, payload } of STUBS) {
      const res = await ctx.app.inject({
        method,
        url,
        ...(payload === undefined ? {} : { payload }),
      })
      expect(res.statusCode, `${method} ${url}`).toBe(501)
      expectEnvelope(res, 501, 'not_implemented')
      expect((res.json() as { error: { message: string } }).error.message).toContain(
        'not implemented',
      )
    }
  })

  it('POST /tasks validates the TaskSpec body before any handler logic (400)', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `${w}/tasks`,
      payload: { kind: 'no-such-kind' },
    })
    expectEnvelope(res, 400, 'validation')
  })

  it('POST /tasks answers 501 for kinds whose stage has not landed', async () => {
    const work = await createWorkViaApi(ctx, 'Stubbed Kinds')
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/works/${work.id}/tasks`,
      payload: { kind: 'illustrate-section', sectionId: NO_SUCH_ID },
    })
    expectEnvelope(res, 501, 'not_implemented')
  })

  it('POST /tasks {enrich-section} is live (Stage 4): an unknown section answers 404', async () => {
    const work = await createWorkViaApi(ctx, 'Enrich Validation')
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/works/${work.id}/tasks`,
      payload: { kind: 'enrich-section', sectionId: NO_SUCH_ID },
    })
    expectEnvelope(res, 404, 'not_found')
  })

  it('GET /runs requires the artifact query param (400)', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: `${w}/runs` })
    expectEnvelope(res, 400, 'validation')
  })

  it('POST /tasks/estimate is NOT registered (M2): 404', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `${w}/tasks/estimate`,
      payload: { kind: 'continue' },
    })
    expectEnvelope(res, 404, 'not_found')
  })
})
