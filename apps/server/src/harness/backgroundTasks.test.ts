import type { RunEvent, Task } from '@cowrite/shared'
import { AppConfig } from '@cowrite/shared'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildClients, resolveHarnessKnobs } from '../models/lanes.js'
import { loadTemplates } from '../prompt/templates/loader.js'
import { runBackgroundTask } from './backgroundTasks.js'
import { buildTask } from './tasks.js'
import {
  attachCapture,
  createSnippet,
  createWork,
  destroyHarnessCtx,
  eventsOf,
  type HarnessTestCtx,
  makeHarnessCtx,
  openWork,
  seedFrozenSection,
  until,
  waitForTerminal,
} from './testUtil.js'

/**
 * Mock-llm-backed integration of the Stage-4 background handlers (docs/05 §4.4, §12
 * tier 2): `enrich-section` through the real REST + SSE + storage stack; the internal
 * `propose-boundaries` handler driven directly (clients cannot submit it — the full
 * scheduler path lives in consolidation.test.ts). Scenarios are strictly ordered;
 * `assertDrained()` closes each test.
 */

const ENRICH_OK =
  '<title>\nThe Fog Watch\n</title>\n' +
  '<summary-short>\nThe keeper counts ships in fog.\n</summary-short>\n' +
  '<summary-long>\nThe keeper counts the ships while the fog rolls in over the harbor.\n</summary-long>'

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

async function submitEnrich(workId: string, sectionId: string): Promise<Task> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/works/${workId}/tasks`,
    payload: { kind: 'enrich-section', sectionId },
  })
  expect(res.statusCode, res.body).toBe(202)
  return res.json() as Task
}

async function readRunEvents(workId: string, runId: string): Promise<RunEvent[]> {
  const res = await ctx.app.inject({ method: 'GET', url: `/api/works/${workId}/runs/${runId}` })
  expect(res.statusCode, res.body).toBe(200)
  return res.json() as RunEvent[]
}

describe('enrich-section', () => {
  it('commits title + short + long from ONE low-lane run, with full run record', async () => {
    const work = await createWork(ctx, 'Enrich Happy')
    const sectionId = await seedFrozenSection(ctx, work.id)
    const open = await openWork(ctx, work.id)
    const capture = attachCapture(open.bus)
    ctx.llm.scenario.respond(ENRICH_OK, { model: 'mock-low' })

    const task = await submitEnrich(work.id, sectionId)
    expect(task.lane).toBe('background')
    const done = await waitForTerminal(ctx, work.id, task.id)
    expect(done.status, JSON.stringify(done.error)).toBe('done')

    // THREE commits (05 §2): title (agent source), summary-short.md, summary-long.md.
    const row = open.handle.getSection(sectionId)
    expect(row?.title).toBe('The Fog Watch')
    expect(row?.titleSource).toBe('agent')
    const summaries = await open.handle.getSummaries(sectionId)
    expect(summaries.short).toContain('counts ships in fog')
    expect(summaries.long).toContain('fog rolls in over the harbor')
    // Staleness clears: the enrichment now carries the current sourceHash (02 §6.5).
    expect(row?.shortSummaryStale).toBe(false)
    expect(row?.longSummaryStale).toBe(false)

    // One run file: meta (contextSnapshot null — no engine session), prompt message,
    // usage, result with the three artifacts.
    const events = await readRunEvents(work.id, task.id)
    const meta = events.find((e): e is Extract<RunEvent, { type: 'meta' }> => e.type === 'meta')
    expect(meta?.kind).toBe('enrich-section')
    expect(meta?.lane).toBe('low')
    expect(meta?.model).toBe('mock-low')
    expect(meta?.contextSnapshot).toBeNull()
    expect(meta?.params.maxOutputTokens).toBe(16_384)
    const result = events.find(
      (e): e is Extract<RunEvent, { type: 'result' }> => e.type === 'result',
    )
    expect(result?.status).toBe('ok')
    expect(result?.artifacts.map((a) => `${a.kind}:${a.state}`)).toEqual([
      'section-title:committed',
      'summary-short:committed',
      'summary-long:committed',
    ])

    // task.* SSE like interactive kinds, on the background lane (05 §8).
    const started = eventsOf(capture, 'task.started').find((e) => e.task.id === task.id)
    expect(started?.lane).toBe('background')
    expect(started?.target).toEqual({ kind: 'section', id: sectionId })
    await until(
      () => eventsOf(capture, 'task.completed').some((e) => e.taskId === task.id),
      'task.completed on the stream',
    )
    // The stateless prompt carried the section content, no tools.
    const req = ctx.llm.requests[0]
    expect(req?.tools).toBeUndefined()
    expect(JSON.stringify(req?.messages)).toContain('keeper counted the ships')
    capture.detach()
    ctx.llm.scenario.assertDrained()
  })

  it('respects a user-pinned title: instruction line dropped, stray <title> ignored', async () => {
    const work = await createWork(ctx, 'Enrich Pinned')
    const sectionId = await seedFrozenSection(ctx, work.id, {
      title: 'My Own Name',
      titleSource: 'user',
    })
    const open = await openWork(ctx, work.id)
    // The model emits a <title> anyway — the parser must treat it as unexpected.
    ctx.llm.scenario.respond(ENRICH_OK, { model: 'mock-low' })

    const task = await submitEnrich(work.id, sectionId)
    const done = await waitForTerminal(ctx, work.id, task.id)
    expect(done.status, JSON.stringify(done.error)).toBe('done')

    // Prompt: the <title> instruction line was dropped (07 §6.5).
    const promptText = JSON.stringify(ctx.llm.requests[0]?.messages)
    expect(promptText).not.toContain('<title> —')
    expect(promptText).toContain('<summary-short>')

    // The pin held; summaries still committed; no section-title artifact.
    const row = open.handle.getSection(sectionId)
    expect(row?.title).toBe('My Own Name')
    expect(row?.titleSource).toBe('user')
    expect((await open.handle.getSummaries(sectionId)).short).not.toBeNull()
    const events = await readRunEvents(work.id, task.id)
    const result = events.find(
      (e): e is Extract<RunEvent, { type: 'result' }> => e.type === 'result',
    )
    expect(result?.artifacts.map((a) => a.kind)).toEqual(['summary-short', 'summary-long'])
    ctx.llm.scenario.assertDrained()
  })

  // BUG regression (02 §6.5): summaries used to be stamped with the COMMIT-time
  // content hash — an edit landing while the run was in flight made a summary of the
  // OLD prose read as fresh. The stamp is the ASSEMBLY-time hash: the summary still
  // commits, but derived staleness correctly reads stale and the sweep repairs it.
  it('stamps summaries with the assembly-time hash: a mid-run edit lands stale', async () => {
    const work = await createWork(ctx, 'Enrich Stale Race')
    const sectionId = await seedFrozenSection(ctx, work.id)
    const open = await openWork(ctx, work.id)
    ctx.llm.scenario.respondStream(ENRICH_OK, {
      chunkSize: 8,
      delayMs: 25,
      match: { model: 'mock-low' },
    })

    const task = await submitEnrich(work.id, sectionId)
    await until(() => ctx.llm.requests.length >= 1, 'the enrich request to reach the mock')
    // the run is in flight: edit the prose out from under it
    const { contentHash } = await open.handle.getSectionContent(sectionId)
    const edited = await open.handle.replaceSectionContent(
      sectionId,
      'Rewritten prose while the enrich run was still streaming.\n',
      { baseHash: contentHash },
    )
    expect(edited.ok).toBe(true)

    const done = await waitForTerminal(ctx, work.id, task.id)
    expect(done.status, JSON.stringify(done.error)).toBe('done')
    const row = open.handle.getSection(sectionId)
    expect(row?.shortSummary).not.toBeNull() // the commit still landed…
    expect(row?.shortSummaryStale).toBe(true) // …but honestly marked stale
    expect(row?.longSummaryStale).toBe(true)

    // the sweep's repair path (a fresh enrich over the NEW prose) clears it
    ctx.llm.scenario.respond(ENRICH_OK, { model: 'mock-low' })
    const repair = await submitEnrich(work.id, sectionId)
    expect((await waitForTerminal(ctx, work.id, repair.id)).status).toBe('done')
    const repaired = open.handle.getSection(sectionId)
    expect(repaired?.shortSummaryStale).toBe(false)
    expect(repaired?.longSummaryStale).toBe(false)
    ctx.llm.scenario.assertDrained()
  })

  it('deduplicates: a second submit for the same section returns the live task', async () => {
    const work = await createWork(ctx, 'Enrich Dedupe')
    const sectionId = await seedFrozenSection(ctx, work.id)
    // Slow stream so the first task is still running when the second submit lands.
    ctx.llm.scenario.respondStream(ENRICH_OK, { chunkSize: 24, delayMs: 20 })

    const first = await submitEnrich(work.id, sectionId)
    const second = await submitEnrich(work.id, sectionId)
    expect(second.id).toBe(first.id) // (kind, targetId) dedupe is a no-op (05 §6.1)
    const done = await waitForTerminal(ctx, work.id, first.id)
    expect(done.status).toBe('done')
    ctx.llm.scenario.assertDrained()
  })

  it('runs the one repair turn when a mandatory block is missing', async () => {
    const work = await createWork(ctx, 'Enrich Repair')
    const sectionId = await seedFrozenSection(ctx, work.id)
    ctx.llm.scenario
      .respond('Sure! Here is a summary: the keeper counts ships.', { model: 'mock-low' })
      .respond(ENRICH_OK, { lastMessageIncludes: 'did not contain the required' })

    const task = await submitEnrich(work.id, sectionId)
    const done = await waitForTerminal(ctx, work.id, task.id)
    expect(done.status, JSON.stringify(done.error)).toBe('done')
    const open = await openWork(ctx, work.id)
    expect((await open.handle.getSummaries(sectionId)).short).not.toBeNull()
    ctx.llm.scenario.assertDrained()
  })
})

// ---------------------------------------------------------------------------
// propose-boundaries — the handler, driven directly (internal-only kind).
// ---------------------------------------------------------------------------

async function runBoundaries(
  workId: string,
  eligibleSnippetIds: string[],
): Promise<{ result: Awaited<ReturnType<typeof runBackgroundTask>>; task: Task }> {
  const open = await openWork(ctx, workId)
  const config = AppConfig.parse({
    models: { low: { baseUrl: `${ctx.llm.url}/v1`, model: 'mock-low' } },
  })
  const client = buildClients(config, { sleepImpl: async () => {} }).low
  if (client === null) throw new Error('low lane unconfigured')
  const spec = { kind: 'propose-boundaries', eligibleSnippetIds } as const
  const task = buildTask('01JGZZZZZZZZZZZZZZZZZZZZZZ', workId, spec, new Date().toISOString())
  task.status = 'running'
  task.startedAt = new Date().toISOString()
  const result = await runBackgroundTask(
    task,
    spec,
    {
      handle: open.handle,
      bus: open.bus,
      client,
      templates: await loadTemplates(),
      knobs: resolveHarnessKnobs({}),
    },
    new AbortController().signal,
  )
  return { result, task }
}

describe('propose-boundaries', () => {
  it('parses a valid <boundaries> proposal and records the run (commits nothing)', async () => {
    const work = await createWork(ctx, 'Boundaries Happy')
    await seedFrozenSection(ctx, work.id, { shortSummary: 'Previously: fog.\n' })
    const s1 = await createSnippet(ctx, work.id, 'The tide gnawed the pilings all night long.')
    const s2 = await createSnippet(ctx, work.id, 'Salt wind carried the bell across the water.')
    ctx.llm.scenario.respond(
      `<boundaries>\n{"boundaries":[{"afterSnippetId":"${s1.id}","kind":"chapter","title":"The Tide"}]}\n</boundaries>`,
      { model: 'mock-low' },
    )

    const { result, task } = await runBoundaries(work.id, [s1.id, s2.id])
    expect(result.status, JSON.stringify(result.error)).toBe('ok')
    expect(result.proposal).toEqual({
      boundaries: [{ afterSnippetId: s1.id, kind: 'chapter', title: 'The Tide' }],
    })
    expect(result.artifacts).toEqual([{ kind: 'boundary', state: 'committed' }])

    // The stateless assembly: eligible snippet texts with ids + frozen shorts (05 §4.4).
    const promptText = JSON.stringify(ctx.llm.requests[0]?.messages)
    expect(promptText).toContain(s1.id)
    expect(promptText).toContain('tide gnawed the pilings')
    expect(promptText).toContain('Previously: fog.')

    const open = await openWork(ctx, work.id)
    const events = await open.handle.readRun(task.id)
    const result2 = events.find(
      (e): e is Extract<RunEvent, { type: 'result' }> => e.type === 'result',
    )
    expect(result2?.status).toBe('ok')
    // No storage writes happened: the frontier is untouched.
    expect(open.handle.listSnippets().map((r) => r.id)).toEqual([s1.id, s2.id])
    ctx.llm.scenario.assertDrained()
  })

  it('fails cleanly with output_invalid on garbage JSON — the scheduler defers', async () => {
    const work = await createWork(ctx, 'Boundaries Garbage')
    const s1 = await createSnippet(ctx, work.id, 'Some frontier prose to divide.')
    ctx.llm.scenario.respond('<boundaries>\nnot json at all\n</boundaries>', {
      model: 'mock-low',
    })

    const { result } = await runBoundaries(work.id, [s1.id])
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('output_invalid')
    expect(result.error?.retryable).toBe(false)
    expect(result.proposal).toBeNull()
    ctx.llm.scenario.assertDrained()
  })

  it('fails output_invalid when the JSON parses but violates BoundaryProposal', async () => {
    const work = await createWork(ctx, 'Boundaries Zod')
    const s1 = await createSnippet(ctx, work.id, 'More frontier prose to divide.')
    ctx.llm.scenario.respond(
      '<boundaries>\n{"boundaries":[{"afterSnippetId":"not-a-ulid","kind":"chapter","title":"X"}]}\n</boundaries>',
    )

    const { result } = await runBoundaries(work.id, [s1.id])
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('output_invalid')
    ctx.llm.scenario.assertDrained()
  })
})
