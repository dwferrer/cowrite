import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  destroyTestCtx,
  expectEnvelope,
  makeTestCtx,
  NO_SUCH_ID,
  type TestCtx,
} from './testUtil.js'

/**
 * Registered-but-stubbed routes (docs/03-api.md §6.2): every Stage-3/4/5 route exists
 * now and answers 501 with the §7 envelope carrying the `not_implemented` code. Bodies
 * are still validated: a malformed TaskSpec 400s before the 501. `/tasks/estimate` is M2
 * and deliberately absent (404).
 */

let ctx: TestCtx

beforeEach(async () => {
  ctx = await makeTestCtx()
})

afterEach(async () => {
  await destroyTestCtx(ctx)
})

const w = `/api/works/${NO_SUCH_ID}`
const t = NO_SUCH_ID

const STUBS: Array<{ method: 'GET' | 'POST'; url: string; payload?: Record<string, unknown> }> = [
  { method: 'POST', url: `${w}/tasks`, payload: { kind: 'continue' } },
  { method: 'GET', url: `${w}/tasks` },
  { method: 'GET', url: `${w}/tasks/${t}` },
  { method: 'POST', url: `${w}/tasks/${t}/cancel` },
  { method: 'POST', url: `${w}/tasks/${t}/proposal/apply` },
  { method: 'POST', url: `${w}/tasks/${t}/proposal/discard` },
  { method: 'POST', url: `${w}/consolidate` },
  { method: 'POST', url: `${w}/consolidations/some-token/undo` },
  { method: 'GET', url: `${w}/runs/${t}` },
  { method: 'GET', url: `${w}/runs?artifact=snippet:${t}` },
  { method: 'GET', url: `${w}/context/candidates` },
  { method: 'POST', url: `${w}/context/preview`, payload: { taskType: 'continue' } },
  { method: 'POST', url: `${w}/context/reset` },
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

  it('POST /tasks validates the TaskSpec body before stubbing (400)', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `${w}/tasks`,
      payload: { kind: 'no-such-kind' },
    })
    expectEnvelope(res, 400, 'validation')
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
