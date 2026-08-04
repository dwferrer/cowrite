import type { RunEvent, SnippetDto, Task } from '@cowrite/shared'
import { AppConfig } from '@cowrite/shared'
import { ulid } from 'ulid'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AgentHarness } from './service.js'
import {
  attachCapture,
  createSnippet,
  createWork,
  destroyHarnessCtx,
  eventsOf,
  type HarnessTestCtx,
  makeHarnessCtx,
  openWork,
  until,
  waitForTerminal,
} from './testUtil.js'

/**
 * Mock-llm-backed integration of the Stage-3 agent loop (docs/05 §12 tier 2): REST + SSE
 * + run-file + storage assertions per golden scenario. Every scenario is strictly
 * ordered; `assertDrained()` closes each test.
 */

const CONTINUE_BLOCK =
  '<snippet id="new">\nThe rain kept falling on the tin roof, and nobody spoke.\n</snippet>'

// ONE app/storage/mock boot for the whole file (E6): booting Fastify + storage + the
// mock per test dominated suite time. Tests isolate by WORK (each creates its own), and
// the shared scenario + captured requests reset per test; nothing else in the shared
// context carries cross-test state (the shared config has no prices, so the spend guard
// never accumulates — the spend suites below boot dedicated contexts).
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

async function submitTask(workId: string, spec: Record<string, unknown>): Promise<Task> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/works/${workId}/tasks`,
    payload: spec,
  })
  expect(res.statusCode, res.body).toBe(202)
  return res.json() as Task
}

async function readRunEvents(workId: string, runId: string): Promise<RunEvent[]> {
  const res = await ctx.app.inject({ method: 'GET', url: `/api/works/${workId}/runs/${runId}` })
  expect(res.statusCode, res.body).toBe(200)
  return (res.json() as unknown[]).map((e) => e as RunEvent)
}

function metaOf(events: RunEvent[]): Extract<RunEvent, { type: 'meta' }> {
  const meta = events.find((e) => e.type === 'meta')
  expect(meta).toBeDefined()
  return meta as Extract<RunEvent, { type: 'meta' }>
}

function resultOf(events: RunEvent[]): Extract<RunEvent, { type: 'result' }> {
  const result = events.find((e) => e.type === 'result')
  expect(result).toBeDefined()
  return result as Extract<RunEvent, { type: 'result' }>
}

describe('continue end-to-end', () => {
  it('streams, commits with provenance, records the run, and rejects a second submit busy', async () => {
    const work = await createWork(ctx, 'Continue Work')
    const open = await openWork(ctx, work.id)
    const capture = attachCapture(open.bus)

    const longProse = 'A long page of prose. '.repeat(20)
    ctx.llm.scenario.respondStream(`<snippet id="new">\n${longProse}\n</snippet>`, {
      chunkSize: 16,
      delayMs: 10,
      match: { model: 'mock-high', hasTools: true },
    })

    const task = await submitTask(work.id, { kind: 'continue' })
    expect(task.lane).toBe('interactive')

    // A second interactive submit while one runs → 409 busy {runningTaskId} (05 §6.1).
    await until(() => eventsOf(capture, 'task.delta').length > 0, 'first delta')
    const busy = await ctx.app.inject({
      method: 'POST',
      url: `/api/works/${work.id}/tasks`,
      payload: { kind: 'continue' },
    })
    expect(busy.statusCode).toBe(409)
    const busyBody = busy.json() as { error: { code: string; details: { runningTaskId: string } } }
    expect(busyBody.error.code).toBe('busy')
    expect(busyBody.error.details.runningTaskId).toBe(task.id)

    const terminal = await waitForTerminal(ctx, work.id, task.id)
    expect(terminal.status).toBe('done')

    // Snippet committed with agent provenance (05 §5.3).
    const snippets = (await ctx.app
      .inject({ method: 'GET', url: `/api/works/${work.id}/snippets` })
      .then((r) => r.json())) as SnippetDto[]
    expect(snippets).toHaveLength(1)
    const snippet = snippets[0] as SnippetDto
    expect(snippet.authorship).toBe('agent')
    expect(snippet.originRunId).toBe(task.id)
    expect(snippet.text).toBe(longProse)

    // Run readable, parsed, complete (05 §7.1).
    const events = await readRunEvents(work.id, task.id)
    const meta = metaOf(events)
    expect(meta.kind).toBe('continue')
    expect(meta.lane).toBe('high')
    expect(meta.model).toBe('mock-high')
    expect(meta.contextSnapshot).not.toBeNull()
    expect(typeof meta.params.promptsHash).toBe('string')
    expect(events.some((e) => e.type === 'output')).toBe(true)
    expect(events.some((e) => e.type === 'usage' && e.call === 'writing')).toBe(true)
    const result = resultOf(events)
    expect(result.status).toBe('ok')
    expect(result.artifacts[0]).toMatchObject({ kind: 'snippet', snippetId: snippet.id })

    // Provenance by artifact (03 §3.9).
    const byArtifact = await ctx.app.inject({
      method: 'GET',
      url: `/api/works/${work.id}/runs?artifact=snippet:${snippet.id}`,
    })
    expect(byArtifact.statusCode).toBe(200)
    const summaries = byArtifact.json() as Array<{ runId: string; status: string }>
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({ runId: task.id, status: 'ok' })

    // SSE family (03 §8.2).
    await until(() => eventsOf(capture, 'task.completed').length > 0, 'task.completed')
    expect(eventsOf(capture, 'task.queued')).toHaveLength(1)
    const started = eventsOf(capture, 'task.started')[0]
    expect(started?.lane).toBe('interactive')
    expect(started?.target.kind).toBe('frontier')
    const deltas = eventsOf(capture, 'task.delta')
    expect(deltas.length).toBeGreaterThan(0)
    expect(deltas.every((d) => d.target === 'frontier')).toBe(true)
    expect(deltas.map((d) => d.text).join('')).toContain('A long page of prose.')
    expect(eventsOf(capture, 'task.stage').some((e) => e.stage === 'writing')).toBe(true)
    expect(eventsOf(capture, 'task.artifact')).toHaveLength(1)
    expect(eventsOf(capture, 'task.usage')).toHaveLength(1)
    await until(() => eventsOf(capture, 'snippet.created').length > 0, 'snippet.created')

    capture.detach()
    ctx.llm.scenario.assertDrained()
  })

  it('instructed-continue carries the instruction in the <task> region, never as prose', async () => {
    const work = await createWork(ctx, 'Instructed Work')
    ctx.llm.scenario.respondStream(CONTINUE_BLOCK, { match: { model: 'mock-high' } })

    const task = await submitTask(work.id, {
      kind: 'instructed-continue',
      instruction: 'Introduce the lighthouse keeper.',
    })
    const terminal = await waitForTerminal(ctx, work.id, task.id)
    expect(terminal.status).toBe('done')

    // The instruction travels in the prompt's <task> region (05 §2, 07 §regions).
    const request = ctx.llm.requests[0]
    const userMessage = request?.messages.find((m) => m.role === 'user') as { content: string }
    expect(userMessage.content).toContain('<user-instructions>')
    expect(userMessage.content).toContain('Introduce the lighthouse keeper.')
    expect(metaOf(await readRunEvents(work.id, task.id)).kind).toBe('instructed-continue')
    ctx.llm.scenario.assertDrained()
  })

  it('replays one snapshot then live deltas on a mid-stream reconnect (03 §8.3)', async () => {
    const work = await createWork(ctx, 'Snapshot Work')
    const open = await openWork(ctx, work.id)
    const capture = attachCapture(open.bus)

    const prose = 'Snow settled over the orchard, one branch at a time. '.repeat(12)
    ctx.llm.scenario.respondStream(`<snippet id="new">\n${prose}\n</snippet>`, {
      chunkSize: 12,
      delayMs: 12,
    })
    const task = await submitTask(work.id, { kind: 'continue' })

    await until(() => eventsOf(capture, 'task.delta').length >= 2, 'a few deltas')
    // Fresh connection mid-generation: hello, then one synthetic task.snapshot.
    const reconnect = attachCapture(open.bus)
    const snapshot = await until(
      () => eventsOf(reconnect, 'task.snapshot')[0],
      'task.snapshot on reconnect',
    )
    expect(reconnect.events[0]?.type).toBe('hello')
    expect(snapshot.taskId).toBe(task.id)
    expect(snapshot.target).toBe('frontier')
    expect(snapshot.text.length).toBeGreaterThan(0)
    expect(prose.startsWith(snapshot.text.slice(0, 20))).toBe(true)

    await waitForTerminal(ctx, work.id, task.id)
    // Snapshot + subsequent live deltas reassemble the full streamed text.
    await until(() => eventsOf(reconnect, 'task.completed').length > 0, 'completion on reconnect')
    const reassembled =
      snapshot.text +
      eventsOf(reconnect, 'task.delta')
        .map((d) => d.text)
        .join('')
    expect(reassembled).toBe(`${prose}\n`)

    capture.detach()
    reconnect.detach()
    ctx.llm.scenario.assertDrained()
  })
})

describe('planning tool-call loop', () => {
  it('dispatches tool calls to the engine, keeps tools byte-stable, then composes', async () => {
    const work = await createWork(ctx, 'Planning Work')
    const entryRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/works/${work.id}/world`,
      payload: { name: 'Maple', body: 'A tree spirit living in the orchard.' },
    })
    expect(entryRes.statusCode).toBe(201)
    const entry = entryRes.json() as { id: string }
    const open = await openWork(ctx, work.id)
    const capture = attachCapture(open.bus)

    ctx.llm.scenario
      .respond(
        { toolCall: { name: 'context_expand', arguments: { kind: 'world', id: entry.id } } },
        { model: 'mock-high', hasTools: true },
      )
      .respond({
        toolCall: {
          name: 'finish_planning',
          arguments: { cite: [{ kind: 'world', id: entry.id }] },
        },
      })
      .respondStream(CONTINUE_BLOCK, { match: { model: 'mock-high', hasTools: true } })

    const task = await submitTask(work.id, { kind: 'continue' })
    const terminal = await waitForTerminal(ctx, work.id, task.id)
    expect(terminal.status).toBe('done')

    // Engine expansion happened and is on the record + the wire.
    const events = await readRunEvents(work.id, task.id)
    const toolCalls = events.filter((e) => e.type === 'toolCall')
    expect(toolCalls.map((t) => (t as { name: string }).name)).toEqual([
      'context_expand',
      'finish_planning',
    ])
    const stages = events.filter((e) => e.type === 'stage')
    expect(stages.some((s) => (s as { stage: string }).stage === 'planning')).toBe(true)
    expect(stages.some((s) => (s as { stage: string }).stage === 'writing')).toBe(true)
    expect(eventsOf(capture, 'task.tool')).toHaveLength(2)

    // §4.1 rule 1: identical tools array + byte-identical prefix on the composition call.
    expect(ctx.llm.requests).toHaveLength(3)
    const [first, , composition] = ctx.llm.requests
    expect(composition?.toolChoice).toBe('none')
    expect(first?.toolChoice).toBeUndefined()
    expect(JSON.stringify(composition?.tools)).toBe(JSON.stringify(first?.tools))
    expect(JSON.stringify(composition?.messages.slice(0, 2))).toBe(
      JSON.stringify(first?.messages.slice(0, 2)),
    )
    const lastMessage = composition?.messages[composition.messages.length - 1] as {
      role: string
      content: string
    }
    expect(lastMessage.role).toBe('user')
    expect(lastMessage.content).toContain('<local-context-refresh>')

    // The composition committed (prose after planning is never discarded).
    const snippets = (await ctx.app
      .inject({ method: 'GET', url: `/api/works/${work.id}/snippets` })
      .then((r) => r.json())) as SnippetDto[]
    expect(snippets).toHaveLength(1)
    expect(snippets[0]?.text).toContain('rain kept falling')

    capture.detach()
    ctx.llm.scenario.assertDrained()
  })
})

describe('quick-edit', () => {
  it('commits a whole-target rewrite as a revision with agent provenance', async () => {
    const work = await createWork(ctx, 'Edit Work')
    const snippet = await createSnippet(ctx, work.id, 'The old house stood at the end of the lane.')
    const open = await openWork(ctx, work.id)
    const capture = attachCapture(open.bus)

    const rewritten = 'The ancient house loomed at the end of the lane.'
    ctx.llm.scenario.respondStream(`<snippet id="${snippet.id}">\n${rewritten}\n</snippet>`, {
      match: { model: 'mock-high' },
    })

    const task = await submitTask(work.id, {
      kind: 'quick-edit',
      instruction: 'Make it more foreboding',
      target: { type: 'snippet', snippetId: snippet.id, baseRev: 1 },
      selection: { text: 'old house', start: 4, end: 13 },
    })
    const terminal = await waitForTerminal(ctx, work.id, task.id)
    expect(terminal.status).toBe('done')

    const after = (await ctx.app
      .inject({ method: 'GET', url: `/api/works/${work.id}/snippets` })
      .then((r) => r.json())) as SnippetDto[]
    expect(after[0]?.rev).toBe(2)
    expect(after[0]?.text).toBe(rewritten)
    // Revision provenance rides the revision log (02 §10.4: runId per agent revision).
    const revisions = (await ctx.app
      .inject({ method: 'GET', url: `/api/works/${work.id}/snippets/${snippet.id}/revisions` })
      .then((r) => r.json())) as Array<{ rev: number; author: string; runId?: string }>
    expect(revisions.find((r) => r.rev === 2)).toMatchObject({ author: 'agent', runId: task.id })

    const events = await readRunEvents(work.id, task.id)
    expect(resultOf(events).artifacts[0]).toMatchObject({
      kind: 'snippet-revision',
      snippetId: snippet.id,
      rev: 2,
      state: 'committed',
    })
    // Targeted edits stream against the target's id, not the frontier (05 §4.3).
    const deltas = eventsOf(capture, 'task.delta')
    expect(deltas.length).toBeGreaterThan(0)
    expect(deltas.every((d) => d.target === snippet.id)).toBe(true)

    capture.detach()
    ctx.llm.scenario.assertDrained()
  })

  it('rejects a selection outside the snippet (400 validation)', async () => {
    const work = await createWork(ctx, 'Validation Work')
    const snippet = await createSnippet(ctx, work.id, 'Short text.')
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/works/${work.id}/tasks`,
      payload: {
        kind: 'quick-edit',
        instruction: 'x',
        target: { type: 'snippet', snippetId: snippet.id, baseRev: 1 },
        selection: { text: 'way beyond', start: 0, end: 500 },
      },
    })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { error: { code: string } }).error.code).toBe('validation')
    ctx.llm.scenario.assertDrained()
  })

  it('degrades a stale-baseRev commit to a durable conflict proposal: apply path', async () => {
    const work = await createWork(ctx, 'Conflict Work')
    const snippet = await createSnippet(ctx, work.id, 'First version of the paragraph.')
    // The user edits while the task will be in flight: rev 1 → 2, so baseRev 1 is stale.
    const patch = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/works/${work.id}/snippets/${snippet.id}`,
      payload: { text: 'Second version, edited by the user.', baseRev: 1 },
    })
    expect(patch.statusCode).toBe(200)

    const rewrite = 'Agent rewrite of the first version.'
    ctx.llm.scenario.respondStream(`<snippet id="${snippet.id}">\n${rewrite}\n</snippet>`)

    const task = await submitTask(work.id, {
      kind: 'quick-edit',
      instruction: 'Rewrite it',
      target: { type: 'snippet', snippetId: snippet.id, baseRev: 1 },
      selection: { text: 'First', start: 0, end: 5 },
    })
    const terminal = await waitForTerminal(ctx, work.id, task.id)
    expect(terminal.status).toBe('done') // run ends ok; the ARTIFACT is the conflict (05 §5.6)

    const events = await readRunEvents(work.id, task.id)
    expect(resultOf(events).status).toBe('ok')
    expect(resultOf(events).artifacts[0]).toMatchObject({
      kind: 'snippet-revision',
      snippetId: snippet.id,
      state: 'conflict',
    })

    // Apply-anyway commits a normal revision on top with agent provenance.
    const apply = await ctx.app.inject({
      method: 'POST',
      url: `/api/works/${work.id}/tasks/${task.id}/proposal/apply`,
    })
    expect(apply.statusCode, apply.body).toBe(200)
    const applied = (apply.json() as { snippet: SnippetDto }).snippet
    expect(applied.text).toBe(rewrite)
    expect(applied.rev).toBe(3)
    const revisions = (await ctx.app
      .inject({ method: 'GET', url: `/api/works/${work.id}/snippets/${snippet.id}/revisions` })
      .then((r) => r.json())) as Array<{ rev: number; author: string; runId?: string }>
    expect(revisions.find((r) => r.rev === 3)).toMatchObject({ author: 'agent', runId: task.id })

    // The resolution is durable in the run file; a second apply conflicts (03 §3.7).
    const afterEvents = await readRunEvents(work.id, task.id)
    expect(afterEvents.some((e) => e.type === 'proposal')).toBe(true)
    const again = await ctx.app.inject({
      method: 'POST',
      url: `/api/works/${work.id}/tasks/${task.id}/proposal/apply`,
    })
    expect(again.statusCode).toBe(409)
    ctx.llm.scenario.assertDrained()
  })

  it('conflict proposal: discard path (idempotent 204, then apply refuses)', async () => {
    const work = await createWork(ctx, 'Discard Work')
    const snippet = await createSnippet(ctx, work.id, 'Original text to be edited.')
    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/works/${work.id}/snippets/${snippet.id}`,
      payload: { text: 'User edit landing first.', baseRev: 1 },
    })
    ctx.llm.scenario.respondStream(`<snippet id="${snippet.id}">\nDiscarded rewrite.\n</snippet>`)
    const task = await submitTask(work.id, {
      kind: 'quick-edit',
      instruction: 'Rewrite it',
      target: { type: 'snippet', snippetId: snippet.id, baseRev: 1 },
      selection: { text: 'Original', start: 0, end: 8 },
    })
    await waitForTerminal(ctx, work.id, task.id)

    const url = `/api/works/${work.id}/tasks/${task.id}/proposal/discard`
    expect((await ctx.app.inject({ method: 'POST', url })).statusCode).toBe(204)
    expect((await ctx.app.inject({ method: 'POST', url })).statusCode).toBe(204) // idempotent
    const apply = await ctx.app.inject({
      method: 'POST',
      url: `/api/works/${work.id}/tasks/${task.id}/proposal/apply`,
    })
    expect(apply.statusCode).toBe(409)

    // The snippet kept the user's text.
    const after = (await ctx.app
      .inject({ method: 'GET', url: `/api/works/${work.id}/snippets` })
      .then((r) => r.json())) as SnippetDto[]
    expect(after[0]?.text).toBe('User edit landing first.')
    ctx.llm.scenario.assertDrained()
  })
})

describe('failure and recovery paths', () => {
  it('cancel mid-stream records the partial and offers keep-partial (05 §6.3/§6.5)', async () => {
    const work = await createWork(ctx, 'Cancel Work')
    const open = await openWork(ctx, work.id)
    const capture = attachCapture(open.bus)

    const prose = 'The letter arrived on a Tuesday, and everything changed after that. '.repeat(10)
    ctx.llm.scenario.respondStream(`<snippet id="new">\n${prose}\n</snippet>`, {
      chunkSize: 10,
      delayMs: 15,
    })
    const task = await submitTask(work.id, { kind: 'continue' })
    await until(() => eventsOf(capture, 'task.delta').length >= 2, 'streaming underway')

    const cancel = await ctx.app.inject({
      method: 'POST',
      url: `/api/works/${work.id}/tasks/${task.id}/cancel`,
    })
    expect(cancel.statusCode).toBe(202)
    const terminal = await waitForTerminal(ctx, work.id, task.id)
    expect(terminal.status).toBe('cancelled')

    const cancelledEvent = await until(
      () => eventsOf(capture, 'task.cancelled')[0],
      'task.cancelled',
    )
    expect(cancelledEvent.partialText).not.toBeNull()

    const events = await readRunEvents(work.id, task.id)
    const result = resultOf(events)
    expect(result.status).toBe('cancelled')
    expect(result.partialText).not.toBeNull()

    // Keep-partial-as-draft commits with agent provenance (05 §6.5).
    const apply = await ctx.app.inject({
      method: 'POST',
      url: `/api/works/${work.id}/tasks/${task.id}/proposal/apply`,
    })
    expect(apply.statusCode, apply.body).toBe(200)
    const applied = (apply.json() as { snippet: SnippetDto }).snippet
    expect(applied.authorship).toBe('agent')
    expect(applied.originRunId).toBe(task.id)
    expect(prose.startsWith(applied.text.slice(0, 30))).toBe(true)
    expect(applied.text).not.toContain('<snippet') // partial is prose, not markup

    capture.detach()
    ctx.llm.scenario.assertDrained()
  })

  it('die-mid-stream: replays up to the attempt budget, then keep-partial (05 §6.5)', async () => {
    const work = await createWork(ctx, 'Death Work')
    const open = await openWork(ctx, work.id)
    const capture = attachCapture(open.bus)

    const dying = '<snippet id="new">\nHalf a page of prose that will never finish arriving'
    ctx.llm.scenario
      .dieMidStream({ text: dying, afterChars: dying.length })
      .dieMidStream({ text: dying, afterChars: dying.length })
      .dieMidStream({ text: dying, afterChars: dying.length })

    const task = await submitTask(work.id, { kind: 'continue' })
    const terminal = await waitForTerminal(ctx, work.id, task.id)
    expect(terminal.status).toBe('error')
    // Proposal discovery (05 §6.5): the terminal Task DTO carries the offer.
    expect(terminal.partialText).toContain('Half a page of prose')
    expect(terminal.unresolvedProposal).toEqual({ kind: 'keep-partial' })

    const failed = await until(() => eventsOf(capture, 'task.failed')[0], 'task.failed')
    expect(failed.retryable).toBe(true)
    expect(failed.partialText).toContain('Half a page of prose')
    expect(eventsOf(capture, 'task.retrying')).toHaveLength(2) // attempts 2 and 3

    const events = await readRunEvents(work.id, task.id)
    expect(events.filter((e) => e.type === 'attempt')).toHaveLength(2)
    expect(resultOf(events).partialText).toContain('Half a page of prose')
    // Usage honesty (05 §9): all three billed attempts count, flagged estimated.
    const usageTotal = resultOf(events).usageTotal
    expect(usageTotal.estimated).toBe(true)
    expect(usageTotal.completionTokens).toBeGreaterThan(0)

    const apply = await ctx.app.inject({
      method: 'POST',
      url: `/api/works/${work.id}/tasks/${task.id}/proposal/apply`,
    })
    expect(apply.statusCode, apply.body).toBe(200)
    const applied = (apply.json() as { snippet: SnippetDto }).snippet
    expect(applied.text).toContain('Half a page of prose')
    expect(applied.text).not.toContain('<snippet')

    capture.detach()
    ctx.llm.scenario.assertDrained()
  })

  it('429 with Retry-After is retried inside the call and succeeds (05 §6.4)', async () => {
    const work = await createWork(ctx, 'Rate Limit Work')
    const open = await openWork(ctx, work.id)
    const capture = attachCapture(open.bus)
    ctx.llm.scenario
      .http(429, undefined, { retryAfterMs: 1000 })
      .respondStream(CONTINUE_BLOCK, { match: { model: 'mock-high' } })

    const task = await submitTask(work.id, { kind: 'continue' })
    const terminal = await waitForTerminal(ctx, work.id, task.id)
    expect(terminal.status).toBe('done')
    expect(ctx.llm.requests).toHaveLength(2)
    // the pre-delivery retry is the client's to replay, but it still surfaces to the UI
    const retrying = eventsOf(capture, 'task.retrying')
    expect(retrying).toHaveLength(1)
    expect(retrying[0]).toMatchObject({ taskId: task.id, attempt: 2 })
    capture.detach()
    ctx.llm.scenario.assertDrained()
  })

  it('one missing-block reply triggers exactly one repair turn (05 §5.5)', async () => {
    const work = await createWork(ctx, 'Repair Work')
    ctx.llm.scenario
      .respond('Here is a lovely reply with no block at all.')
      .respondStream(CONTINUE_BLOCK, {
        match: { lastMessageIncludes: 'did not contain the required' },
      })

    const task = await submitTask(work.id, { kind: 'continue' })
    const terminal = await waitForTerminal(ctx, work.id, task.id)
    expect(terminal.status).toBe('done')

    const snippets = (await ctx.app
      .inject({ method: 'GET', url: `/api/works/${work.id}/snippets` })
      .then((r) => r.json())) as SnippetDto[]
    expect(snippets[0]?.text).toContain('rain kept falling')
    expect(ctx.llm.requests).toHaveLength(2)
    ctx.llm.scenario.assertDrained()
  })

  it('answers 409 config_missing when the routed lane has no endpoint', async () => {
    // A harness over an all-defaults config: no models configured, task never enqueued.
    const unconfigured = new AgentHarness({ config: () => AppConfig.parse({}) })
    const work = await createWork(ctx, 'Unconfigured Work')
    const open = await openWork(ctx, work.id)
    await expect(unconfigured.submit(open, { kind: 'continue' })).rejects.toMatchObject({
      code: 'config_missing',
    })
    ctx.llm.scenario.assertDrained()
  })
})

describe('restart / crash interplay', () => {
  it('finalizes an interrupted run as crash on reopen and still serves keep-partial', async () => {
    const work = await createWork(ctx, 'Crash Work')
    const open = await openWork(ctx, work.id)
    const runId = ulid()
    const startedAt = new Date().toISOString()

    // Simulate a run that died mid-stream: meta + streamed output, no result line.
    const sink = await open.handle.recordRun(runId, startedAt)
    await sink.append({
      type: 'meta',
      runId,
      kind: 'continue',
      lane: 'high',
      model: 'mock-high',
      spec: { kind: 'continue' },
      params: {},
      contextSnapshot: null,
      startedAt,
    })
    await sink.append({ type: 'output', text: '<snippet id="new">\nProse that survived the crash' })

    // "Restart": close the work, then reopen — the startup finalizer runs (02 §10.7).
    await ctx.works.closeWork(open.slug)
    const reopened = await openWork(ctx, work.id)
    void reopened

    const events = await readRunEvents(work.id, runId)
    const result = resultOf(events)
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('crash')
    expect(result.partialText).toContain('Prose that survived the crash')

    // Keep-partial works identically before and after a restart (03 §8.4).
    const apply = await ctx.app.inject({
      method: 'POST',
      url: `/api/works/${work.id}/tasks/${runId}/proposal/apply`,
    })
    expect(apply.statusCode, apply.body).toBe(200)
    const applied = (apply.json() as { snippet: SnippetDto }).snippet
    expect(applied.text).toBe('Prose that survived the crash')
    expect(applied.originRunId).toBe(runId)
    ctx.llm.scenario.assertDrained()
  })

  it('attach frames hydrate a fresh connection: live task DURING streaming (03 §8.3)', async () => {
    const work = await createWork(ctx, 'Attach Live Work')
    const open = await openWork(ctx, work.id)
    const prose = 'The tide argued with the pilings for an hour. '.repeat(12)
    ctx.llm.scenario.respondStream(`<snippet id="new">\n${prose}\n</snippet>`, {
      chunkSize: 12,
      delayMs: 12,
    })
    const task = await submitTask(work.id, { kind: 'continue' })
    const first = attachCapture(open.bus)
    await until(() => eventsOf(first, 'task.delta').length >= 2, 'streaming underway')

    // A brand-new EventSource: hello → task.state (running) → task.snapshot — no
    // pre-fetch needed, the stream alone seeds the slot.
    const fresh = attachCapture(open.bus)
    const state = await until(() => eventsOf(fresh, 'task.state')[0], 'task.state frame')
    expect(state.task.id).toBe(task.id)
    expect(state.task.status).toBe('running')
    expect(state.lane).toBe('interactive')
    expect(state.target).toEqual({ kind: 'frontier' })
    const stateAt = fresh.events.findIndex((e) => e.type === 'task.state')
    const snapshotAt = fresh.events.findIndex((e) => e.type === 'task.snapshot')
    expect(stateAt).toBeGreaterThan(-1)
    if (snapshotAt !== -1) expect(stateAt).toBeLessThan(snapshotAt) // slot exists first

    await waitForTerminal(ctx, work.id, task.id)
    first.detach()
    fresh.detach()
    ctx.llm.scenario.assertDrained()
  })

  it('attach frames re-offer an unresolved keep-partial after "reload" and after "restart"', async () => {
    const work = await createWork(ctx, 'Attach Offer Work')
    const dying = '<snippet id="new">\nProse that keeps not arriving'
    ctx.llm.scenario
      .dieMidStream({ text: dying, afterChars: dying.length })
      .dieMidStream({ text: dying, afterChars: dying.length })
      .dieMidStream({ text: dying, afterChars: dying.length })
    const task = await submitTask(work.id, { kind: 'continue' })
    await waitForTerminal(ctx, work.id, task.id)

    // "Reload": a fresh attach on the SAME open work sees the terminal state frame.
    const open = await openWork(ctx, work.id)
    const reload = attachCapture(open.bus)
    const frame = await until(() => eventsOf(reload, 'task.state')[0], 'reload task.state')
    expect(frame.task.id).toBe(task.id)
    expect(frame.task.status).toBe('error')
    expect(frame.task.unresolvedProposal).toEqual({ kind: 'keep-partial' })
    expect(frame.task.partialText).toContain('Prose that keeps not arriving')
    reload.detach()

    // "Restart": close and reopen the work — in-memory task state is gone; the frame is
    // reconstructed lazily from the last run file (03 §8.4).
    await ctx.works.closeWork(open.slug)
    const reopened = await openWork(ctx, work.id)
    const restart = attachCapture(reopened.bus)
    const lazy = await until(() => eventsOf(restart, 'task.state')[0], 'post-restart task.state')
    expect(lazy.task.id).toBe(task.id)
    expect(lazy.task.unresolvedProposal).toEqual({ kind: 'keep-partial' })
    expect(lazy.task.partialText).toContain('Prose that keeps not arriving')

    // Discarding stops the offer: the next attach carries no state frame.
    const discard = await ctx.app.inject({
      method: 'POST',
      url: `/api/works/${work.id}/tasks/${task.id}/proposal/discard`,
    })
    expect(discard.statusCode).toBe(204)
    const after = attachCapture(reopened.bus)
    await new Promise((resolve) => setTimeout(resolve, 100)) // lazy provider settles
    expect(eventsOf(after, 'task.state')).toHaveLength(0)

    restart.detach()
    after.detach()
    ctx.llm.scenario.assertDrained()
  })

  it('conflict proposal after a mid-stream retry applies the LAST composition (05 §6.5)', async () => {
    const work = await createWork(ctx, 'Retry Conflict Work')
    const snippet = await createSnippet(ctx, work.id, 'Original paragraph, first version.')
    // The user edits mid-flight: baseRev 1 goes stale, the commit degrades to a proposal.
    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/works/${work.id}/snippets/${snippet.id}`,
      payload: { text: 'User edit that lands first.', baseRev: 1 },
    })
    // Attempt 1 streams a COMPLETE stale block, then dies before [DONE]; the replay
    // streams the fresh rewrite. Reconstruction must use ONLY the final attempt.
    const stale = `<snippet id="${snippet.id}">\nSTALE first-attempt rewrite.\n</snippet>`
    const fresh = 'FRESH final-attempt rewrite.'
    ctx.llm.scenario
      .dieMidStream({ text: stale, afterChars: stale.length })
      .respondStream(`<snippet id="${snippet.id}">\n${fresh}\n</snippet>`)

    const task = await submitTask(work.id, {
      kind: 'quick-edit',
      instruction: 'Rewrite it',
      target: { type: 'snippet', snippetId: snippet.id, baseRev: 1 },
      selection: { text: 'Original', start: 0, end: 8 },
    })
    const terminal = await waitForTerminal(ctx, work.id, task.id)
    expect(terminal.status).toBe('done')
    expect(terminal.unresolvedProposal).toEqual({ kind: 'conflict' })

    const apply = await ctx.app.inject({
      method: 'POST',
      url: `/api/works/${work.id}/tasks/${task.id}/proposal/apply`,
    })
    expect(apply.statusCode, apply.body).toBe(200)
    const applied = (apply.json() as { snippet: SnippetDto }).snippet
    expect(applied.text).toBe(fresh) // never the stale attempt, never a doubled join
    ctx.llm.scenario.assertDrained()
  })

  it('GET /tasks/:t is 404 for unknown ids; GET /tasks lists terminal history', async () => {
    const work = await createWork(ctx, 'Listing Work')
    ctx.llm.scenario.respondStream(CONTINUE_BLOCK)
    const task = await submitTask(work.id, { kind: 'continue' })
    await waitForTerminal(ctx, work.id, task.id)

    const list = await ctx.app.inject({ method: 'GET', url: `/api/works/${work.id}/tasks` })
    expect(list.statusCode).toBe(200)
    expect((list.json() as Task[]).map((t) => t.id)).toEqual([task.id])

    const missing = await ctx.app.inject({
      method: 'GET',
      url: `/api/works/${work.id}/tasks/${ulid()}`,
    })
    expect(missing.statusCode).toBe(404)
    ctx.llm.scenario.assertDrained()
  })
})

describe('retry-after abort + spend guard (dedicated contexts)', () => {
  const CONTINUE_OK = CONTINUE_BLOCK

  it('cancel during a 3600 s Retry-After wait settles fast and frees the lane (05 §6.3)', async () => {
    // REAL timer sleeps: only the abort race may settle the wait early.
    const slow = await makeHarnessCtx(
      {},
      { laneDeps: { sleepImpl: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } },
    )
    try {
      const work = await createWork(slow, 'Abort Wait Work')
      slow.llm.scenario.http(429, undefined, { retryAfterMs: 3_600_000 })
      const task = await submitTask2(slow, work.id, { kind: 'continue' })
      // let the 429 land and the retry sleep begin
      await new Promise((resolve) => setTimeout(resolve, 100))
      const t0 = Date.now()
      const cancel = await slow.app.inject({
        method: 'POST',
        url: `/api/works/${work.id}/tasks/${task.id}/cancel`,
      })
      expect(cancel.statusCode).toBe(202)
      const terminal = await waitForTerminal(slow, work.id, task.id)
      expect(terminal.status).toBe('cancelled')
      expect(Date.now() - t0).toBeLessThan(2_000) // never the capped 30 s, never 3600 s

      // the interactive lane is free immediately: a new submit succeeds
      slow.llm.scenario.respondStream(CONTINUE_OK)
      const next = await submitTask2(slow, work.id, { kind: 'continue' })
      expect((await waitForTerminal(slow, work.id, next.id)).status).toBe('done')
      slow.llm.scenario.assertDrained()
    } finally {
      await destroyHarnessCtx(slow)
    }
  })

  it('crossing spendWarnUsd emits ONE spend.warning; later runs stay quiet', async () => {
    // 1 000 000 $/MTok ⇒ every token costs $1 — one run blows straight past the knob.
    const spendy = await makeHarnessCtx(
      { spendWarnUsd: 0.5 },
      { modelPricesPerMTok: { prompt: 1_000_000, completion: 1_000_000 } },
    )
    try {
      const work = await createWork(spendy, 'Spend Warn Work')
      const open = await spendy.works.open(work.id)
      const capture = attachCapture(open.bus)

      spendy.llm.scenario.respondStream(CONTINUE_OK)
      const first = await submitTask2(spendy, work.id, { kind: 'continue' })
      await waitForTerminal(spendy, work.id, first.id)
      await until(() => eventsOf(capture, 'spend.warning').length > 0, 'spend.warning')
      const warning = eventsOf(capture, 'spend.warning')[0]
      expect(warning?.thresholdUsd).toBe(0.5)
      expect(warning?.spentUsd).toBeGreaterThanOrEqual(0.5)

      spendy.llm.scenario.respondStream(CONTINUE_OK)
      const second = await submitTask2(spendy, work.id, { kind: 'continue' })
      await waitForTerminal(spendy, work.id, second.id)
      expect(eventsOf(capture, 'spend.warning')).toHaveLength(1) // one-time per process

      capture.detach()
      spendy.llm.scenario.assertDrained()
    } finally {
      await destroyHarnessCtx(spendy)
    }
  })

  it('crossing spendStopUsd fails NEW submissions with 409 spend_stop until restart', async () => {
    const stopper = await makeHarnessCtx(
      { spendStopUsd: 0.5 },
      { modelPricesPerMTok: { prompt: 1_000_000, completion: 1_000_000 } },
    )
    try {
      const work = await createWork(stopper, 'Spend Stop Work')
      stopper.llm.scenario.respondStream(CONTINUE_OK)
      const first = await submitTask2(stopper, work.id, { kind: 'continue' })
      expect((await waitForTerminal(stopper, work.id, first.id)).status).toBe('done')
      expect(stopper.harness.spentUsd).toBeGreaterThanOrEqual(0.5)

      const refused = await stopper.app.inject({
        method: 'POST',
        url: `/api/works/${work.id}/tasks`,
        payload: { kind: 'continue' },
      })
      expect(refused.statusCode).toBe(409)
      expect((refused.json() as { error: { code: string } }).error.code).toBe('spend_stop')
      stopper.llm.scenario.assertDrained()
    } finally {
      await destroyHarnessCtx(stopper)
    }
  })
})

/** submitTask against an explicit context (the dedicated-context suites above). */
async function submitTask2(
  context: HarnessTestCtx,
  workId: string,
  spec: Record<string, unknown>,
): Promise<Task> {
  const res = await context.app.inject({
    method: 'POST',
    url: `/api/works/${workId}/tasks`,
    payload: spec,
  })
  expect(res.statusCode, res.body).toBe(202)
  return res.json() as Task
}
