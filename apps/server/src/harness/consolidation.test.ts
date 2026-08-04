import type { SnippetDto, Task } from '@cowrite/shared'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { boundaryJson, consolidation, ENRICH_OK, PAGE } from './stage4Fixtures.js'
import {
  attachCapture,
  createSnippet,
  createWork,
  destroyHarnessCtx,
  eventsOf,
  fetchSections,
  type HarnessTestCtx,
  makeHarnessCtx,
  openWork,
  patchConsolidation,
  seedFrozenSection,
  seedPages,
  until,
} from './testUtil.js'

/**
 * The Stage-4 cases the pipeline suite (stage4.pipeline.test.ts) does not cover: the
 * manual "Consolidate now" route (03 §3.8) incl. its nothing-eligible 202 and unknown-
 * token 409, mid-grace SSE attach hydration (03 §8.3), the unconfigured-low-lane
 * surfacing (409 config_missing + quiet scheduler back-off), and the mock improviser
 * regression for unscripted sweeps. The full trigger→boundaries→apply→enrich→undo
 * lifecycle lives in the pipeline suite — not repeated here.
 */

let ctx: HarnessTestCtx

beforeAll(async () => {
  ctx = await makeHarnessCtx()
})

afterAll(async () => {
  await destroyHarnessCtx(ctx)
})

beforeEach(() => {
  ctx.llm.scenario.reset()
  ctx.llm.requests.length = 0
})

describe('POST /consolidate ("Consolidate now")', () => {
  it('answers 409 for an unknown undo token', async () => {
    const work = await createWork(ctx, 'Undo Unknown')
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/works/${work.id}/consolidations/01JGNOTATOKEN/undo`,
    })
    expect(res.statusCode, res.body).toBe(409)
  })

  it('forces evaluation below thresholds and returns the 202 boundary Task', async () => {
    const work = await createWork(ctx, 'Manual Consolidate')
    // Thresholds stay at their defaults (18/9000 — NOT exceeded); only the active
    // window shrinks so a prefix exists. Long debounce keeps the auto path cold.
    await patchConsolidation(
      ctx,
      work.id,
      consolidation({
        maxFrontierSnippets: 18,
        maxFrontierWords: 9000,
        activeWindowSnippets: 1,
        debounceMs: 600_000,
      }),
    )
    const open = await openWork(ctx, work.id)
    const capture = attachCapture(open.bus)
    const snippets: SnippetDto[] = []
    for (let i = 0; i < 4; i++) {
      snippets.push(await createSnippet(ctx, work.id, `${PAGE} (manual ${i + 1})`))
    }
    const cut = snippets[0] as SnippetDto
    ctx.llm.scenario
      .respond(boundaryJson(cut.id, 'Forced Chapter'), { model: 'mock-low' })
      .respond(ENRICH_OK, { model: 'mock-low' })

    const res = await ctx.app.inject({ method: 'POST', url: `/api/works/${work.id}/consolidate` })
    expect(res.statusCode, res.body).toBe(202)
    const task = res.json() as Task
    expect(task.spec.kind).toBe('propose-boundaries')
    expect(task.lane).toBe('background')

    // GET /tasks lists the background-lane entry (03 §3.7).
    const listed = await ctx.app.inject({ method: 'GET', url: `/api/works/${work.id}/tasks` })
    expect((listed.json() as Task[]).some((t) => t.id === task.id)).toBe(true)

    const applied = await until(
      () => eventsOf(capture, 'consolidation.applied')[0],
      'the forced consolidation to apply',
    )
    expect(applied.title).toBe('Forced Chapter')
    await until(async () => {
      const rows = await fetchSections(ctx, work.id)
      return rows.length === 1 && rows[0]?.shortSummary !== null
    }, 'the forced chapter to be enriched')

    capture.detach()
    ctx.llm.scenario.assertDrained()
  })

  it('answers 202 {applied: false, reason: "nothing-eligible"} when nothing is eligible', async () => {
    // BUG regression: this used to 409 — but a frontier resting inside the active
    // window is a normal state, not a conflict (03 §3.8).
    const work = await createWork(ctx, 'Nothing Eligible')
    await createSnippet(ctx, work.id, 'One lonely page inside the active window.')
    const res = await ctx.app.inject({ method: 'POST', url: `/api/works/${work.id}/consolidate` })
    expect(res.statusCode, res.body).toBe(202)
    expect(res.json()).toEqual({ applied: false, reason: 'nothing-eligible' })
  })
})

describe('mid-grace SSE attach (03 §8.3 hydration)', () => {
  it('a fresh attach mid-grace re-offers the undo with the TRUE remaining deadline', async () => {
    const work = await createWork(ctx, 'Attach Regrace')
    await patchConsolidation(
      ctx,
      work.id,
      consolidation({ maxFrontierSnippets: 4, maxFrontierWords: 5000 }),
    )
    const { snippets, capture } = await seedPages(ctx, work.id, 6, 'page', PAGE)
    const cut = snippets[1] as SnippetDto
    ctx.llm.scenario
      .respond(boundaryJson(cut.id, 'Regrace'), { model: 'mock-low' })
      .respond(ENRICH_OK, { model: 'mock-low' })

    // The 150 ms debounce fires after the last frontier write and drives the cycle.
    const applied = await until(
      () => eventsOf(capture, 'consolidation.applied')[0],
      'consolidation.applied on the stream',
    )
    expect(applied.undoDeadline).not.toBe('')
    // keep the re-armed debounce from starting an unscripted second cycle
    await patchConsolidation(ctx, work.id, consolidation({ maxFrontierSnippets: 100 }))
    await until(
      () => eventsOf(capture, 'task.completed').length >= 2,
      'both background runs to settle',
    )

    // A brand-new subscriber (reload) hydrates the pending grace purely from the
    // stream: a synthetic consolidation.applied frame with the SAME deadline.
    const open = await openWork(ctx, work.id)
    const reattach = attachCapture(open.bus)
    const offered = await until(
      () => eventsOf(reattach, 'consolidation.applied')[0],
      'the synthetic mid-grace attach frame',
    )
    expect(offered.undoToken).toBe(applied.undoToken)
    expect(offered.undoDeadline).toBe(applied.undoDeadline)

    capture.detach()
    reattach.detach()
    ctx.llm.scenario.assertDrained()
  })
})

describe('unconfigured low lane (config_missing surfacing + scheduler back-off)', () => {
  let bare: HarnessTestCtx

  beforeAll(async () => {
    bare = await makeHarnessCtx(
      {},
      { omitLowLane: true, scheduler: { sweepTickMs: 20, sweepIdleMs: 5 } },
    )
  })

  afterAll(async () => {
    await destroyHarnessCtx(bare)
  })

  it('surfaces 409 config_missing on explicit submits and the scheduler backs off', async () => {
    const work = await createWork(bare, 'No Low Lane')
    const sectionId = await seedFrozenSection(bare, work.id) // missing summaries ⇒ stale
    const open = await openWork(bare, work.id)
    bare.works.retain(open.slug) // presence: the sweep gate sees a subscriber

    // Explicit user submit: loud, typed 409.
    const res = await bare.app.inject({
      method: 'POST',
      url: `/api/works/${work.id}/tasks`,
      payload: { kind: 'enrich-section', sectionId },
    })
    expect(res.statusCode, res.body).toBe(409)
    expect((res.json() as { error: { code: string } }).error.code).toBe('config_missing')

    // The sweep sees the stale section but backs off instead of spinning failing
    // submissions: several windows pass, zero tasks exist, nothing crashed.
    await new Promise((resolve) => setTimeout(resolve, 120))
    const tasks = await bare.app.inject({ method: 'GET', url: `/api/works/${work.id}/tasks` })
    expect(tasks.json()).toEqual([])

    bare.works.release(open.slug)
  })

  it('manual /consolidate surfaces 409 config_missing when a prefix exists', async () => {
    const work = await createWork(bare, 'No Low Lane Manual')
    const patch = await bare.app.inject({
      method: 'PATCH',
      url: `/api/works/${work.id}`,
      payload: {
        settings: {
          consolidation: { activeWindowSnippets: 1, activeWindowWords: 10, debounceMs: 600_000 },
        },
      },
    })
    expect(patch.statusCode).toBe(200)
    for (let i = 0; i < 3; i++) await createSnippet(bare, work.id, `${PAGE} (bare ${i + 1})`)
    const res = await bare.app.inject({
      method: 'POST',
      url: `/api/works/${work.id}/consolidate`,
    })
    expect(res.statusCode, res.body).toBe(409)
    expect((res.json() as { error: { code: string } }).error.code).toBe('config_missing')
  })
})

describe('the staleness sweep against real storage', () => {
  let swept: HarnessTestCtx

  beforeAll(async () => {
    swept = await makeHarnessCtx({}, { scheduler: { sweepTickMs: 25, sweepIdleMs: 5 } })
  })

  afterAll(async () => {
    await destroyHarnessCtx(swept)
  })

  // BUG regression: an UNSCRIPTED sweep under COWRITE_MOCK_LLM used to poison the
  // strict scenario queue (recorded failure + assertDrained blowup). Background-shaped
  // requests now fall back to the mock's improviser when nothing is scripted. (The
  // scripted sweep-repair path is covered by the pipeline suite's restart test.)
  it('completes an unscripted sweep via the mock improviser — no queue poisoning', async () => {
    const work = await createWork(swept, 'Sweep Improvised')
    const sectionId = await seedFrozenSection(swept, work.id, { title: null })
    // NOTHING scripted here on purpose.
    const open = await openWork(swept, work.id)
    swept.works.retain(open.slug)
    try {
      await until(async () => {
        const summaries = await open.handle.getSummaries(sectionId)
        return summaries.short !== null && summaries.long !== null
      }, 'the sweep to enrich via the improvised mock response')
    } finally {
      swept.works.release(open.slug)
    }
    swept.llm.scenario.assertDrained() // nothing scripted, nothing failed
    expect(open.handle.getSection(sectionId)?.title).toBe('Improvised Chapter')
  })
})
