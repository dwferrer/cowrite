import { ContextStateRes, PreviewResponse, UsageEvent } from '@cowrite/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  destroyTestCtx,
  expectEnvelope,
  makeTestCtx,
  NO_SUCH_ID,
  seedFixtureWork,
  type TestCtx,
} from '../../http/routes/testUtil.js'
import { FIX } from '../../storage/index/fixture.js'

/**
 * The live /context/* REST surface (docs/06-context-engine.md §11, replacing the Stage-2
 * 501 stubs) driven over real storage via the fixture work: state, candidates, preview
 * (per-fidelity token counts + server-fed budgets), reset, usage.
 */

let ctx: TestCtx
let workId: string

beforeEach(async () => {
  ctx = await makeTestCtx()
  const seeded = await seedFixtureWork(ctx)
  workId = seeded.workId
})

afterEach(async () => {
  await destroyTestCtx(ctx)
})

const url = (suffix: string): string => `/api/works/${workId}/context/${suffix}`

describe('GET /context/state', () => {
  it('serves the ledger + computed default map', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: url('state') })
    expect(res.statusCode).toBe(200)
    const body = ContextStateRes.parse(res.json())
    expect(body.state.taskCounter).toBe(0)
    const rows = new Map(body.defaultMap.map((r) => [r.id, r.fidelity]))
    // sec1 is enriched (short + long): a summary fidelity
    expect(['short', 'long']).toContain(rows.get(FIX.sec1))
    // sec2 is a frozen leaf with NO summaries: rule-2 full inclusion
    expect(rows.get(FIX.sec2)).toBe('full')
    // world entries present
    expect(rows.get(FIX.mara)).toBe('short')
    expect(rows.get(FIX.glass)).toBe('name') // no shortSummary
  })

  it('404s for an unknown work', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/works/${NO_SUCH_ID}/context/state`,
    })
    expectEnvelope(res, 404, 'not_found')
  })
})

describe('GET /context/candidates', () => {
  it('lists sections + world entries with per-fidelity token counts, absences omitted', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: url('candidates') })
    expect(res.statusCode).toBe(200)
    const list = res.json() as Array<{
      id: string
      kind: string
      tokens: Record<string, number>
      defaultFidelity: string
      currentFidelity: string
    }>
    const sec2 = list.find((c) => c.id === FIX.sec2)
    expect(sec2?.tokens.full).toBeGreaterThan(0)
    expect(sec2?.tokens.short).toBeUndefined() // no summary enriched yet ⇒ omitted
    const sec1 = list.find((c) => c.id === FIX.sec1)
    expect(sec1?.tokens.short).toBeGreaterThan(0)
    expect(sec1?.tokens.long).toBeGreaterThan(0)
    const mara = list.find((c) => c.id === FIX.mara)
    expect(mara?.kind).toBe('world')
    expect(mara?.tokens.full).toBeGreaterThan(0)
  })
})

describe('POST /context/preview', () => {
  it('answers totals, per-region counts, and the effective budgets', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: url('preview'),
      payload: { taskType: 'continue' },
    })
    expect(res.statusCode).toBe(200)
    const body = PreviewResponse.parse(res.json())
    expect(body.totalTokens).toBeGreaterThan(0)
    expect(body.perRegion['local-context']).toBeGreaterThan(0)
    expect(body.perRegion['global-context']).toBeGreaterThan(0)
    expect(body.softBudget).toBe(32_000)
    expect(body.hardCap).toBe(64_000)
    expect(body.overSoft).toBe(false)
  })

  it('reflects per-work contextOverrides in the served budgets (server-fed meter scale)', async () => {
    const patch = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/works/${workId}`,
      payload: { settings: { contextOverrides: { softBudget: 111, hardCap: 222 } } },
    })
    expect(patch.statusCode).toBe(200)
    const res = await ctx.app.inject({
      method: 'POST',
      url: url('preview'),
      payload: { taskType: 'continue' },
    })
    const body = PreviewResponse.parse(res.json())
    expect(body.softBudget).toBe(111)
    expect(body.hardCap).toBe(222)
    expect(body.overSoft).toBe(true) // the fixture work easily exceeds 111 tokens
  })

  it('overlays selections into expanded-context', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: url('preview'),
      payload: {
        taskType: 'continue',
        selections: [{ id: FIX.mara, kind: 'world', fidelity: 'full' }],
      },
    })
    const body = PreviewResponse.parse(res.json())
    expect(body.perRegion['expanded-context']).toBeGreaterThan(0)
  })

  it('400s for non-interactive kinds', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: url('preview'),
      payload: { taskType: 'enrich-section' },
    })
    expectEnvelope(res, 400, 'validation')
  })

  it('400s for a malformed body before touching the engine', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: url('preview'),
      payload: { taskType: 'no-such-kind' },
    })
    expectEnvelope(res, 400, 'validation')
  })
})

describe('POST /context/reset and GET /context/usage', () => {
  it('reset answers 204 and wipes the persisted ledger', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: url('reset') })
    expect(res.statusCode).toBe(204)
    const state = await ctx.app.inject({ method: 'GET', url: url('state') })
    expect(ContextStateRes.parse(state.json()).state.elevated).toHaveLength(0)
  })

  it('usage serves parsed UsageEvent rows (empty before any task ran)', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: url('usage') })
    expect(res.statusCode).toBe(200)
    const events = z.array(UsageEvent).parse(res.json())
    expect(events).toEqual([])
  })

  it('usage validates the limit query', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: `${url('usage')}?limit=0` })
    expectEnvelope(res, 400, 'validation')
  })
})
