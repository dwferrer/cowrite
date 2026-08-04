import path from 'node:path'
import type { SnippetDto, Task } from '@cowrite/shared'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { engineFor } from '../context/routes.js'
import { applyPlannedOp, planConsolidation } from '../storage/consolidation.js'
import { writePendingOp } from '../storage/journal.js'
import { listSnippetFiles } from '../storage/snippetStore.js'
import {
  at,
  boundariesJson,
  consolidation,
  ENRICH_OK,
  frontierSnapshot,
  PAGE,
} from './stage4Fixtures.js'
import {
  attachCapture,
  createSnippet,
  createWork,
  destroyHarnessCtx,
  eventsOf,
  fetchSections,
  fetchSnippets,
  type HarnessTestCtx,
  makeHarnessCtx,
  openWork,
  patchConsolidation,
  seedPages,
  until,
  waitForTerminal,
} from './testUtil.js'

/**
 * Stage-4 end-to-end lifecycle against mock-llm (docs/10 §Stage 4; 02 §6; 05 §6.2;
 * 06 §4.3): the full pipeline over a 21-snippet frontier — debounced trigger → boundary
 * task → journaled apply → enrichment → engine anchor refresh → a SMALLER assembled
 * context (the whole point) — plus the byte-identical undo round trip with queued-enrich
 * cancellation and re-consolidation, the scene-break heuristic path (no boundary agent),
 * and the restart-mid-pipeline story (journal replay at open + the missing-counts-as-
 * stale sweep repair, 02 §6.5).
 *
 * Contract note: consolidation deliberately emits NO snippet.* wire events — the client
 * refetches the snippet list on `sections.restructured` (03 §3.2 "refetched wholesale
 * only on sections.restructured"); the frontier-shrink assertions below go through that
 * refetch path on purpose.
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

describe('the grand tour: 21 snippets → boundaries → apply → enrich → anchors → smaller context', () => {
  it('shrinks the assembled context to summary fidelity, end to end', async () => {
    const work = await createWork(ctx, 'Grand Tour')
    // Anchors are capped low via contextOverrides so the post-consolidation total is
    // dominated by summaries, not by near-full-chapter anchor excerpts.
    await patchConsolidation(ctx, work.id, consolidation(), { anchorTokensTotal: 200 })
    const open = await openWork(ctx, work.id)

    // Seed to EXACTLY the threshold (20 = maxFrontierSnippets: over requires >20), so
    // the debounce fires idle while we measure the pre-consolidation assembled size.
    const { snippets, capture } = await seedPages(ctx, work.id, 20, 'tour', PAGE)
    const engine = await engineFor(open)
    const pre = await engine.preview({ taskType: 'continue', selections: [], targets: [] })
    expect(pre.totalTokens).toBeGreaterThan(500) // 20 full snippets: genuinely long

    // The 21st write crosses the threshold and arms the 150 ms debounce.
    snippets.push(await createSnippet(ctx, work.id, `${PAGE} (tour 21)`))

    // Eligible prefix = 21 − activeWindow(2) = snippets 1..19; three cuts → 3 chapters.
    ctx.llm.scenario
      .respond(
        boundariesJson([
          [at(snippets, 5).id, 'One'],
          [at(snippets, 11).id, 'Two'],
          [at(snippets, 17).id, 'Three'],
        ]),
        { model: 'mock-low' },
      )
      .respond(ENRICH_OK, { model: 'mock-low' })
      .respond(ENRICH_OK, { model: 'mock-low' })
      .respond(ENRICH_OK, { model: 'mock-low' })

    const applied = await until(
      () => eventsOf(capture, 'consolidation.applied')[0],
      'consolidation.applied on the stream',
    )
    expect(applied.sectionIds).toHaveLength(3)
    expect(applied.undoToken).not.toBe('')
    expect(applied.title).toBe('One') // the first frozen section's boundary title
    expect(eventsOf(capture, 'sections.restructured').length).toBeGreaterThan(0)

    // The internal boundary run went to the low lane with the eligible prefix, no tools.
    const boundaryReq = ctx.llm.requests[0]
    expect(boundaryReq?.model).toBe('mock-low')
    expect(JSON.stringify(boundaryReq?.messages)).toContain(at(snippets, 5).id)
    expect(boundaryReq?.tools).toBeUndefined()

    // Frontier shrank: snippets 0..17 consumed, 18..20 stay live (post the refetch
    // signal — consolidation publishes no snippet.* events by contract, 03 §3.2).
    expect((await fetchSnippets(ctx, work.id)).map((s) => s.id)).toEqual(
      snippets.slice(18).map((s) => s.id),
    )
    const sectionRows = await fetchSections(ctx, work.id)
    expect(sectionRows.map((r) => r.title)).toEqual(['One', 'Two', 'Three'])

    // Enrichment lands on all three: titles + summaries, staleness cleared.
    await until(async () => {
      const rows = await fetchSections(ctx, work.id)
      return (
        rows.length === 3 &&
        rows.every(
          (r) =>
            r.shortSummary !== null && r.longSummary !== null && !r.stale.short && !r.stale.long,
        )
      )
    }, 'all three chapters to be enriched')

    // The SSE stream carried hydrated enrichment.updated rows (03 §8.2).
    const enrichmentEvents = eventsOf(capture, 'enrichment.updated')
    expect(
      enrichmentEvents.some((e) => e.kind === 'short' && e.section.shortSummary !== null),
    ).toBe(true)
    expect(enrichmentEvents.some((e) => e.kind === 'long' && e.section.longSummary !== null)).toBe(
      true,
    )

    // Anchor refresh (06 §4.3): queued by enrichment completion, applied at the NEXT
    // beginTask — run one interactive continue and read the persisted engine state.
    ctx.llm.scenario.respondStream(
      '<snippet id="new">\nThe tide turned; they climbed toward the light.\n</snippet>\n',
      { chunkSize: 16, match: { model: 'mock-high' } },
    )
    const submitted = await ctx.app.inject({
      method: 'POST',
      url: `/api/works/${work.id}/tasks`,
      payload: { kind: 'continue' },
    })
    expect(submitted.statusCode, submitted.body).toBe(202)
    await waitForTerminal(ctx, work.id, (submitted.json() as Task).id)

    const { state } = await engine.stateRes()
    // The refresh stamps the PRE-increment counter (this was the first task: 0) and can
    // only have populated excerpts via the enrichment-queued refresh — empty before it.
    expect(state.taskCounter).toBeGreaterThanOrEqual(1)
    expect(state.anchors.excerpts.length).toBeGreaterThan(0)
    for (const excerpt of state.anchors.excerpts) {
      expect(applied.sectionIds).toContain(excerpt.sectionId)
    }

    // THE WHOLE POINT: the chapter now assembles at summary fidelity and the total is
    // smaller than the pre-consolidation frontier-heavy assembly.
    const post = await engine.preview({ taskType: 'continue', selections: [], targets: [] })
    expect(post.totalTokens).toBeLessThan(pre.totalTokens)
    const candidates = await engine.candidates()
    for (const sectionId of applied.sectionIds) {
      const candidate = candidates.find((c) => c.id === sectionId)
      expect(candidate, `candidate row for section ${sectionId}`).toBeDefined()
      expect(['short', 'long']).toContain(candidate?.defaultFidelity)
    }

    capture.detach()
    ctx.llm.scenario.assertDrained()
  }, 20_000)
})

describe('undo: byte-identical frontier restore, running+queued enrich cancellation, re-trigger', () => {
  it('reverses everything and re-consolidates on demand', async () => {
    const work = await createWork(ctx, 'Undo Bytes')
    // Long debounce: this test drives the manual path only (no timing races).
    await patchConsolidation(
      ctx,
      work.id,
      consolidation({ maxFrontierSnippets: 16, debounceMs: 600_000 }),
    )
    const { snippets, capture } = await seedPages(ctx, work.id, 21, 'undo', PAGE)
    const open = await openWork(ctx, work.id)
    const before = await frontierSnapshot(open.handle.workDir)
    expect(before.size).toBeGreaterThanOrEqual(21) // 21 snippet files (+ any revision logs)

    // Three sections: two enrich runs stream slowly (occupying the lane, capacity 2),
    // the third stays QUEUED — undo must cancel running AND queued by target.
    ctx.llm.scenario
      .respond(
        boundariesJson([
          [at(snippets, 5).id, 'Alpha'],
          [at(snippets, 11).id, 'Beta'],
          [at(snippets, 17).id, 'Gamma'],
        ]),
        { model: 'mock-low' },
      )
      .respondStream(ENRICH_OK, { chunkSize: 6, delayMs: 30, match: { model: 'mock-low' } })
      .respondStream(ENRICH_OK, { chunkSize: 6, delayMs: 30, match: { model: 'mock-low' } })

    const trigger = await ctx.app.inject({
      method: 'POST',
      url: `/api/works/${work.id}/consolidate`,
    })
    expect(trigger.statusCode, trigger.body).toBe(202)
    const applied = await until(
      () => eventsOf(capture, 'consolidation.applied')[0],
      'the forced consolidation to apply',
    )
    expect(applied.sectionIds).toHaveLength(3)

    // All three enrich tasks exist (two running, one queued behind the lane cap).
    const enrichIds = await until(() => {
      const queued = eventsOf(capture, 'task.queued')
        .filter((e) => e.task.spec.kind === 'enrich-section')
        .map((e) => e.task.id)
      return queued.length === 3 ? queued : undefined
    }, 'three enrich tasks to be enqueued')
    // Undo only once both streams are genuinely in flight at the mock (1 boundary + 2).
    await until(() => ctx.llm.requests.length >= 3, 'both enrich requests to reach the mock')

    const undone = await ctx.app.inject({
      method: 'POST',
      url: `/api/works/${work.id}/consolidations/${applied.undoToken}/undo`,
    })
    expect(undone.statusCode, undone.body).toBe(204)

    // Every enrich task — running or queued — was cancelled by target id.
    await until(() => {
      const cancelled = new Set(eventsOf(capture, 'task.cancelled').map((e) => e.taskId))
      return enrichIds.every((id) => cancelled.has(id))
    }, 'all three enrich tasks to cancel')
    expect(eventsOf(capture, 'consolidation.undone')[0]?.sectionIds).toEqual(applied.sectionIds)

    // Byte-identical reversal: sections gone, every frontier file restored exactly.
    expect(await fetchSections(ctx, work.id)).toEqual([])
    expect((await fetchSnippets(ctx, work.id)).map((s) => s.id)).toEqual(snippets.map((s) => s.id))
    expect(await frontierSnapshot(open.handle.workDir)).toEqual(before)

    // The spent token answers a second undo with a clean 409 (03 §3.8).
    const again = await ctx.app.inject({
      method: 'POST',
      url: `/api/works/${work.id}/consolidations/${applied.undoToken}/undo`,
    })
    expect(again.statusCode).toBe(409)

    // Re-trigger: the same frontier re-consolidates cleanly after the undo.
    ctx.llm.scenario
      .respond(boundariesJson([[at(snippets, 5).id, 'Alpha Again']]), { model: 'mock-low' })
      .respond(ENRICH_OK, { model: 'mock-low' })
    const reTrigger = await ctx.app.inject({
      method: 'POST',
      url: `/api/works/${work.id}/consolidate`,
    })
    expect(reTrigger.statusCode, reTrigger.body).toBe(202)
    const reapplied = await until(
      () => eventsOf(capture, 'consolidation.applied')[1],
      'the re-triggered consolidation to apply',
    )
    expect(reapplied.sectionIds).toHaveLength(1)
    expect(reapplied.title).toBe('Alpha Again')
    await until(async () => {
      const rows = await fetchSections(ctx, work.id)
      return rows.length === 1 && rows[0]?.shortSummary !== null
    }, 'the re-frozen chapter to be enriched')
    expect((await fetchSnippets(ctx, work.id)).map((s) => s.id)).toEqual(
      snippets.slice(6).map((s) => s.id),
    )

    capture.detach()
    ctx.llm.scenario.assertDrained()
  }, 20_000)
})

describe('scene-break heuristic (02 §6.3 rule 1) at the harness level', () => {
  it('splits without the boundary agent; enrichment then names the chapter', async () => {
    const work = await createWork(ctx, 'Heuristic Split')
    await patchConsolidation(ctx, work.id, consolidation({ maxFrontierSnippets: 16 }))
    const open = await openWork(ctx, work.id)
    const capture = attachCapture(open.bus)
    const snippets: SnippetDto[] = []
    for (let i = 0; i < 21; i++) {
      // Snippet 10 ENDS with an explicit scene-break line — rule 1 splits after it.
      const text = i === 9 ? `${PAGE} (break ${i + 1})\n\n***` : `${PAGE} (scene ${i + 1})`
      snippets.push(await createSnippet(ctx, work.id, text))
    }
    ctx.llm.scenario.respond(ENRICH_OK, { model: 'mock-low' })

    const applied = await until(
      () => eventsOf(capture, 'consolidation.applied')[0],
      'the heuristic split to apply',
    )
    expect(applied.sectionIds).toHaveLength(1)
    expect(applied.title).toBe('') // untitled until the enrichment agent names it

    // No propose-boundaries task ever ran: the only background task is the enrich.
    expect(eventsOf(capture, 'task.started').map((e) => e.task.spec.kind)).toEqual([
      'enrich-section',
    ])
    // Snippets 1..10 consumed (through the marker); the marker text is preserved.
    expect((await fetchSnippets(ctx, work.id)).map((s) => s.id)).toEqual(
      snippets.slice(10).map((s) => s.id),
    )
    const sectionId = at(applied.sectionIds, 0)

    await until(async () => {
      const rows = await fetchSections(ctx, work.id)
      const row = rows.find((r) => r.id === sectionId)
      return row !== undefined && row.title === 'The Storm Cellar' && row.shortSummary !== null
    }, 'the enrichment agent to name and summarize the chapter')
    const content = await ctx.app.inject({
      method: 'GET',
      url: `/api/works/${work.id}/sections/${sectionId}/content`,
    })
    expect(content.statusCode).toBe(200)
    expect((content.json() as { markdown: string }).markdown).toContain('***')

    capture.detach()
    ctx.llm.scenario.assertDrained()
  }, 20_000)
})

describe('restart mid-pipeline (02 §6.5): journal replay + missing-counts-as-stale repair', () => {
  it('replays the applied op at open and the sweep enriches the recovered sections', async () => {
    // First life: a normal server seeds the work, then "crashes" after apply.
    const first = await makeHarnessCtx()
    const dataDir = first.dataDir
    let work: Awaited<ReturnType<typeof createWork>>
    let snippets: SnippetDto[]
    try {
      work = await createWork(first, 'Crash Recovery')
      snippets = []
      for (let i = 0; i < 6; i++) {
        snippets.push(await createSnippet(first, work.id, `${PAGE} (crash ${i + 1})`))
      }
    } finally {
      // Shut the first life down WITHOUT destroying the data dir. A clean close would
      // purge the journal (02 §9.4), so the crash state is written below, files-level.
      await first.works.closeAll()
      await first.app.close()
      await first.llm.close()
    }

    // Crash simulation between apply and enrich: journal at 'applied', two sections on
    // disk, consumed snippets staged for undo — and no enrichment ever ran.
    const workDir = path.join(dataDir, 'works', work.slug)
    const files = await listSnippetFiles(workDir)
    const op = await planConsolidation(
      workDir,
      files,
      [
        { afterSnippetId: at(snippets, 1).id, kind: 'chapter', title: 'Salvage One' },
        { afterSnippetId: at(snippets, 3).id, kind: 'chapter', title: 'Salvage Two' },
      ],
      { boundaryRunId: null },
    )
    await writePendingOp(workDir, op)
    await applyPlannedOp(workDir, op, 5 * 60_000)

    // Second life over the SAME data dir, with a fast sweep.
    const second = await makeHarnessCtx(
      {},
      { dataDir, scheduler: { sweepTickMs: 25, sweepIdleMs: 5 } },
    )
    try {
      second.llm.scenario.respond(ENRICH_OK).respond(ENRICH_OK)
      // Readying the app registers the route plugin, whose works.onOpen hook is what
      // attaches the background scheduler to the work opened below.
      await second.app.ready()
      const open = await openWork(second, work.id)

      // §9.2 replay at open: sections present, snippets consumed, grace window resumed.
      const rows = open.handle.listSections()
      expect(rows.map((r) => r.title)).toEqual(['Salvage One', 'Salvage Two'])
      expect(open.handle.listSnippets().map((s) => s.id)).toEqual(
        snippets.slice(4).map((s) => s.id),
      )
      const pending = await open.handle.pendingConsolidation()
      expect(pending?.opId).toBe(op.opId)

      // No enqueue survived the restart — none could have (in-memory queues, 05 §6.1).
      // The repair is the sweep: missing summaries on frozen leaves COUNT as stale.
      expect(rows.every((r) => r.shortSummaryStale && r.longSummaryStale)).toBe(true)
      second.works.retain(open.slug) // presence: the sweep gate sees a subscriber
      try {
        await until(async () => {
          const a = await open.handle.getSummaries(at(rows, 0).id)
          const b = await open.handle.getSummaries(at(rows, 1).id)
          return a.short !== null && a.long !== null && b.short !== null && b.long !== null
        }, 'the sweep to repair both recovered sections')
      } finally {
        second.works.release(open.slug)
      }
      second.llm.scenario.assertDrained()
    } finally {
      await destroyHarnessCtx(second) // removes the shared data dir
    }
  }, 20_000)
})
