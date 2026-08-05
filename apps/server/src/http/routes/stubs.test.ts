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
 * Registered routes that formerly 501'd (docs/03-api.md §6.2): the illustration health
 * route went live with the Stage-5 pipeline and reports "not configured" (comfy off) when
 * no `comfyui` block is set. Task/run/proposal routes went live with the Stage-3 harness,
 * the consolidation controls with the Stage-4 scheduler; `/tasks/estimate` is M2 (404).
 */

let ctx: TestCtx

beforeEach(async () => {
  ctx = await makeTestCtx()
})

afterEach(async () => {
  await destroyTestCtx(ctx)
})

const w = `/api/works/${NO_SUCH_ID}`

describe('stub routes', () => {
  it('GET /api/illustration/health reports "not configured" when comfyui is unset (200)', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/illustration/health' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      ok: boolean
      comfy: { ok: boolean }
      workflows: unknown[]
    }
    expect(body.ok).toBe(false)
    expect(body.comfy.ok).toBe(false)
    expect(body.workflows).toEqual([])
  })

  it('POST /tasks validates the TaskSpec body before any handler logic (400)', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `${w}/tasks`,
      payload: { kind: 'no-such-kind' },
    })
    expectEnvelope(res, 400, 'validation')
  })

  it('POST /tasks {illustrate-section} answers 409 config_missing when no lane is configured', async () => {
    const work = await createWorkViaApi(ctx, 'Illustration Kinds')
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/works/${work.id}/tasks`,
      payload: { kind: 'illustrate-section', sectionId: NO_SUCH_ID },
    })
    expectEnvelope(res, 409, 'config_missing')
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
