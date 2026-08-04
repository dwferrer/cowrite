import fsp from 'node:fs/promises'
import path from 'node:path'
import { ContextState } from '@cowrite/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { EngineValidationError, resolveBudgetKnobs, SessionBusyError } from '../engine.js'
import { type EngineHarness, makeEngine, paragraphs, sampleWork, section, tid } from './fixtures.js'

/**
 * Engine + session lifecycle (docs/06-context-engine.md §9.3, §10, §13): persistence
 * round-trips, SessionBusyError, snapshot isolation under concurrent writes, queued
 * enrichment events, usage-log production, cache_break attribution, preview math, and
 * the knob override chain.
 */

let h: EngineHarness

afterEach(async () => {
  await h?.cleanup()
})

async function statePath(): Promise<string> {
  return path.join(h.dir, 'state.json')
}

describe('lifecycle', () => {
  it('beginTask → assemble → finalize persists state.json and bumps taskCounter', async () => {
    h = await makeEngine()
    const session = await h.engine.beginTask({ kind: 'continue' })
    const prompt = session.assembleInitialPrompt()
    expect(prompt.messages[0]?.role).toBe('system')
    expect(prompt.messages[1]?.content).toContain('<instructions>')
    expect(prompt.messages[1]?.content).toContain('<local-context>')
    expect(prompt.tools.map((t) => t.function.name)).toEqual([
      'context_expand',
      'context_search',
      'finish_planning',
    ])
    await session.finalize('completed')

    const raw = JSON.parse(await fsp.readFile(await statePath(), 'utf8'))
    const state = ContextState.parse(raw) // round-trips through the shared schema
    expect(state.taskCounter).toBe(1)
  })

  it('a second beginTask while a session is open throws SessionBusyError', async () => {
    h = await makeEngine()
    const session = await h.engine.beginTask({ kind: 'continue' })
    await expect(h.engine.beginTask({ kind: 'continue' })).rejects.toBeInstanceOf(SessionBusyError)
    session.abort()
    await expect(h.engine.beginTask({ kind: 'continue' })).resolves.toBeDefined()
  })

  it('background kinds never open a session', async () => {
    h = await makeEngine()
    await expect(
      h.engine.beginTask({ kind: 'enrich-section', sectionId: tid(1) }),
    ).rejects.toBeInstanceOf(EngineValidationError)
  })

  it('abort discards everything: no state.json write, no counter bump, no elevation', async () => {
    h = await makeEngine()
    const session = await h.engine.beginTask({ kind: 'continue' })
    session.assembleInitialPrompt()
    await session.handleToolCall({
      name: 'context_expand',
      args: { kind: 'world', id: tid(21), level: 'full' },
    })
    session.abort()
    await expect(fsp.access(await statePath())).rejects.toThrow() // never written
    // next task sees an empty ledger
    const next = await h.engine.beginTask({ kind: 'continue' })
    const prompt = next.assembleInitialPrompt()
    expect(
      prompt.snapshot.items.every((i) => i.source === 'default' || i.source === 'target'),
    ).toBe(true)
    next.abort()
  })

  it('assembleInitialPrompt is idempotent (same object back)', async () => {
    h = await makeEngine()
    const session = await h.engine.beginTask({ kind: 'continue' })
    expect(session.assembleInitialPrompt()).toBe(session.assembleInitialPrompt())
    session.abort()
  })

  it('corrupt state.json regenerates with a warning, never a fatal error', async () => {
    h = await makeEngine()
    const s = await h.engine.beginTask({ kind: 'continue' })
    s.assembleInitialPrompt()
    await s.finalize('completed')
    await h.engine.usageSettled()
    await h.cleanup()

    // hand-mangle, then reload the same dir
    const dir = h.dir
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(path.join(dir, 'state.json'), '{"version": 999, "nope": true}')
    const data = sampleWork()
    const { makeEngine: remake } = await import('./fixtures.js')
    h = await remake(data)
    // point the fresh engine at the mangled dir by writing there directly instead:
    // simpler — load again via a fresh harness sharing the dir
    await h.cleanup()
    const fresh = await remake(data, { contextDir: dir })
    h = fresh
    expect(fresh.warnings.some((w) => w.includes('regenerating'))).toBe(true)
    const session = await fresh.engine.beginTask({ kind: 'continue' })
    expect(session.assembleInitialPrompt().snapshot.regions.length).toBeGreaterThan(0)
    session.abort()
  })
})

describe('planning tools through the session', () => {
  it('expand elevates with ttl=3 when the model composes without finish_planning (pinned)', async () => {
    h = await makeEngine()
    const session = await h.engine.beginTask({ kind: 'continue' })
    session.assembleInitialPrompt()
    const result = await session.handleToolCall({
      name: 'context_expand',
      args: { kind: 'world', id: tid(21), level: 'full' },
    })
    expect(result.output).toContain('Mara Voss has kept the light')
    expect(result.output).toContain('soft budget')
    expect(result.finishedPlanning).toBe(false)
    await session.finalize('completed')

    const state = ContextState.parse(JSON.parse(await fsp.readFile(await statePath(), 'utf8')))
    expect(state.elevated).toHaveLength(1)
    expect(state.elevated[0]?.id).toBe(tid(21))
    expect(state.elevated[0]?.ttl).toBe(3) // NOT 1 — no cite list was given
    expect(state.elevated[0]?.source).toBe('tool')
  })

  it('handleToolCall is idempotent: a replayed call returns identical bytes, elevates once', async () => {
    h = await makeEngine()
    const session = await h.engine.beginTask({ kind: 'continue' })
    session.assembleInitialPrompt()
    const call = { name: 'context_expand', args: { kind: 'world', id: tid(21), level: 'full' } }
    const a = await session.handleToolCall(call)
    const b = await session.handleToolCall(call)
    expect(b.output).toBe(a.output)
    await session.finalize('completed')
    const state = ContextState.parse(JSON.parse(await fsp.readFile(await statePath(), 'utf8')))
    expect(state.elevated).toHaveLength(1)
    // only ONE tool_call usage event was recorded
    expect(h.usage.filter((e) => e.kind === 'tool_call')).toHaveLength(1)
  })

  it('unknown ids get a polite listing, never an exception', async () => {
    h = await makeEngine()
    const session = await h.engine.beginTask({ kind: 'continue' })
    session.assembleInitialPrompt()
    const result = await session.handleToolCall({
      name: 'context_expand',
      args: { kind: 'section', id: tid(404) },
    })
    expect(result.output).toContain('No section with id')
    expect(result.output).toContain(tid(1)) // nearest valid items listed
    session.abort()
  })

  it('expanding an un-enriched section serves full text and emits enrichment_wanted', async () => {
    h = await makeEngine()
    const session = await h.engine.beginTask({ kind: 'continue' })
    session.assembleInitialPrompt()
    const result = await session.handleToolCall({
      name: 'context_expand',
      args: { kind: 'section', id: tid(3), level: 'short' }, // tid(3) has no summaries
    })
    expect(result.output).toContain('no summary exists yet')
    expect(h.enrichmentWanted).toEqual([tid(3)])
    session.abort()
  })

  it('search finds matches across sections, snippets, and world bodies', async () => {
    h = await makeEngine()
    const session = await h.engine.beginTask({ kind: 'continue' })
    session.assembleInitialPrompt()
    const result = await session.handleToolCall({
      name: 'context_search',
      args: { query: 'frontier-one' },
    })
    expect(result.output).toContain(tid(11))
    const miss = await session.handleToolCall({
      name: 'context_search',
      args: { query: 'zzz-not-present-zzz' },
    })
    expect(miss.output).toContain('No matches')
    session.abort()
  })

  it('finish_planning carries citations; omission from the cite list penalizes to ttl=1', async () => {
    h = await makeEngine()
    const session = await h.engine.beginTask({ kind: 'continue' })
    session.assembleInitialPrompt()
    await session.handleToolCall({
      name: 'context_expand',
      args: { kind: 'world', id: tid(21), level: 'full' },
    })
    await session.handleToolCall({
      name: 'context_expand',
      args: { kind: 'section', id: tid(1), level: 'long' },
    })
    const fin = await session.handleToolCall({
      name: 'finish_planning',
      args: { cite: [{ kind: 'world', id: tid(21) }] },
    })
    expect(fin.finishedPlanning).toBe(true)
    await session.finalize('completed')
    const state = ContextState.parse(JSON.parse(await fsp.readFile(await statePath(), 'utf8')))
    expect(state.elevated.find((e) => e.id === tid(21))?.ttl).toBe(3)
    expect(state.elevated.find((e) => e.id === tid(1))?.ttl).toBe(1)
  })

  it('the tool-call cap trips planningCapReached; finish_planning still allowed', async () => {
    h = await makeEngine(sampleWork(), { knobs: { maxToolCalls: 2 } })
    const session = await h.engine.beginTask({ kind: 'continue' })
    session.assembleInitialPrompt()
    await session.handleToolCall({ name: 'context_search', args: { query: 'wind' }, id: 'c1' })
    await session.handleToolCall({ name: 'context_search', args: { query: 'water' }, id: 'c2' })
    const capped = await session.handleToolCall({
      name: 'context_search',
      args: { query: 'grey' },
      id: 'c3',
    })
    expect(capped.planningCapReached).toBe(true)
    const fin = await session.handleToolCall({ name: 'finish_planning', args: {} })
    expect(fin.finishedPlanning).toBe(true)
    session.abort()
  })

  it('the round cap trips when the harness supplies round indexes', async () => {
    h = await makeEngine(sampleWork(), { knobs: { maxPlanningRoundsQuickEdit: 1 } })
    const target = h.data.snippets[0]
    if (target === undefined) throw new Error('fixture')
    const session = await h.engine.beginTask({
      kind: 'quick-edit',
      instruction: 'Tighten.',
      target: { type: 'snippet', snippetId: target.id, baseRev: 1 },
      selection: { text: 'wind', start: 4, end: 8 },
    })
    session.assembleInitialPrompt()
    const ok = await session.handleToolCall({
      name: 'context_search',
      args: { query: 'wind' },
      round: 0,
    })
    expect(ok.planningCapReached).toBe(false)
    const capped = await session.handleToolCall({
      name: 'context_search',
      args: { query: 'water' },
      round: 1,
    })
    expect(capped.planningCapReached).toBe(true)
    session.abort()
  })

  it('an expansion that would blow past 0.9 × hardCap is refused with alternatives', async () => {
    h = await makeEngine(sampleWork(), { knobs: { hardCap: 1, softBudget: 1 } })
    const session = await h.engine.beginTask({ kind: 'continue' })
    session.assembleInitialPrompt()
    const result = await session.handleToolCall({
      name: 'context_expand',
      args: { kind: 'section', id: tid(1), level: 'full' },
    })
    expect(result.output).toContain('Too large to open in full')
    await session.finalize('completed')
    const state = ContextState.parse(JSON.parse(await fsp.readFile(await statePath(), 'utf8')))
    expect(state.elevated).toHaveLength(0) // a refusal elevates nothing
  })
})

describe('composition refresh turn (§5.3)', () => {
  it('returns null when no tools were used — the streamed prose IS the composition', async () => {
    h = await makeEngine()
    const session = await h.engine.beginTask({ kind: 'continue' })
    session.assembleInitialPrompt()
    expect(session.compositionRefreshTurn()).toBeNull()
    session.abort()
  })

  it('after tool use, returns the local-context tail wrapped in <local-context-refresh>', async () => {
    h = await makeEngine()
    const session = await h.engine.beginTask({ kind: 'continue' })
    session.assembleInitialPrompt()
    await session.handleToolCall({ name: 'context_search', args: { query: 'wind' } })
    const turn = session.compositionRefreshTurn()
    expect(turn).toContain('<local-context-refresh>')
    expect(turn).toContain('</local-context-refresh>')
    expect(turn).toContain('No tool calls')
    // the tail is the END of the local-context region, verbatim
    const lastSnippet = h.data.snippets[h.data.snippets.length - 1]
    expect(turn).toContain(lastSnippet?.text.slice(-40) ?? 'MISSING')
    session.abort()
  })
})

describe('snapshot isolation (§10)', () => {
  it('writes landing mid-task are invisible until the next beginTask', async () => {
    h = await makeEngine()
    const session = await h.engine.beginTask({ kind: 'continue' })
    // the work changes AFTER beginTask but BEFORE assembly
    h.data.snippets.push({ id: tid(14), orderKey: 'b9', text: 'A brand new mid-task snippet.' })
    h.data.situation = 'Everything changed.'
    const prompt = session.assembleInitialPrompt()
    expect(prompt.messages[1]?.content).not.toContain('A brand new mid-task snippet.')
    expect(prompt.messages[1]?.content).not.toContain('Everything changed.')
    // tool reads serve from the snapshot too
    const search = await session.handleToolCall({
      name: 'context_search',
      args: { query: 'brand new mid-task' },
    })
    expect(search.output).toContain('No matches')
    await session.finalize('completed')

    const next = await h.engine.beginTask({ kind: 'continue' })
    const nextPrompt = next.assembleInitialPrompt()
    expect(nextPrompt.messages[1]?.content).toContain('A brand new mid-task snippet.')
    expect(nextPrompt.messages[1]?.content).toContain('Everything changed.')
    next.abort()
  })

  it('enrichment.completed queues an anchor refresh applied at the NEXT beginTask', async () => {
    const data = sampleWork()
    h = await makeEngine(data)
    const first = await h.engine.beginTask({ kind: 'continue' })
    const anchors1 = first.assembleInitialPrompt().snapshot.items.filter((i) => i.kind === 'anchor')
    await first.finalize('completed')

    // a new chapter freezes + enriches; the completion event fires mid-second-task
    const second = await h.engine.beginTask({ kind: 'continue' })
    data.sections.push(
      section({
        id: tid(4),
        orderKey: 'a3',
        title: 'Four',
        content: paragraphs('fourth', 6),
        short: 'Short 4.',
      }),
    )
    h.fireEnrichmentCompleted(tid(4))
    const anchors2 = second
      .assembleInitialPrompt()
      .snapshot.items.filter((i) => i.kind === 'anchor')
    expect(anchors2).toEqual(anchors1) // pinned mid-task
    await second.finalize('completed')

    const third = await h.engine.beginTask({ kind: 'continue' })
    const anchors3 = third.assembleInitialPrompt().snapshot.items.filter((i) => i.kind === 'anchor')
    // the refresh ran: candidate set grew (chapter 3 now has an older sibling pool)
    expect(anchors3.length).toBeGreaterThanOrEqual(anchors1.length)
    expect(anchors3).not.toEqual(anchors1)
    third.abort()
  })
})

describe('usage log and cache_break (§8.4, §5.4)', () => {
  it('writes task_start / tool_call / task_end lines that round-trip the schema', async () => {
    h = await makeEngine()
    const session = await h.engine.beginTask({ kind: 'continue' })
    session.assembleInitialPrompt()
    await session.handleToolCall({ name: 'context_search', args: { query: 'wind' } })
    await session.finalize('completed')
    const served = await h.engine.usage(100)
    const kinds = served.map((e) => e.kind)
    expect(kinds).toContain('task_start')
    expect(kinds).toContain('tool_call')
    expect(kinds).toContain('task_end')
    const start = served.find((e) => e.kind === 'task_start')
    if (start?.kind !== 'task_start') throw new Error('missing task_start')
    expect(start.assembledTokens).toBeGreaterThan(0)
    expect(Object.keys(start.regions)).toContain('local-context')
    const end = served.find((e) => e.kind === 'task_end')
    if (end?.kind !== 'task_end') throw new Error('missing task_end')
    expect(end.planningRounds).toBeGreaterThanOrEqual(1)
  })

  it('usage(limit) is a bounded tail: only the last N events, oldest first', async () => {
    h = await makeEngine()
    for (let i = 0; i < 3; i++) {
      const session = await h.engine.beginTask({ kind: 'continue' })
      session.assembleInitialPrompt()
      await session.finalize('completed')
    }
    const last2 = await h.engine.usage(2)
    expect(last2).toHaveLength(2)
    // The final two events are task 3's start/end pair, in append order.
    expect(last2.map((e) => e.kind)).toEqual(['task_start', 'task_end'])
    expect(last2.every((e) => e.task === 3)).toBe(true)
  })

  it('rotates usage.jsonl at the size threshold and still serves recent events across generations', async () => {
    h = await makeEngine(sampleWork(), { usageRotateBytes: 400 })
    for (let i = 0; i < 4; i++) {
      const session = await h.engine.beginTask({ kind: 'continue' })
      session.assembleInitialPrompt()
      await session.finalize('completed')
    }
    await h.engine.usageSettled()
    const rotated = await fsp.readFile(path.join(h.dir, 'usage.jsonl.1'), 'utf8')
    expect(rotated.length).toBeGreaterThan(0) // one generation kept on disk
    // A wide read tops up from the rotated generation: events span the rotation seam
    // and stay oldest-first with the newest task's task_end last.
    const events = await h.engine.usage(50)
    expect(events.length).toBeGreaterThan(2)
    const last = events[events.length - 1]
    expect(last?.kind).toBe('task_end')
    if (last?.kind !== 'task_end') throw new Error('missing task_end')
    expect(last.task).toBe(4)
    const tasks = events.map((e) => ('task' in e ? e.task : 0))
    expect([...tasks].sort((a, b) => a - b)).toEqual(tasks) // monotonic across the seam
  })

  it('emits cache_break naming exactly the regions whose bytes changed between tasks', async () => {
    h = await makeEngine()
    const first = await h.engine.beginTask({ kind: 'continue' })
    first.assembleInitialPrompt()
    await first.finalize('completed')
    h.usage.length = 0

    h.data.situation = 'A completely new situation.'
    const second = await h.engine.beginTask({ kind: 'continue' })
    second.assembleInitialPrompt()
    await second.finalize('completed')
    const breaks = h.usage.filter((e) => e.kind === 'cache_break')
    expect(breaks.map((b) => (b.kind === 'cache_break' ? b.region : ''))).toEqual(['situation'])
  })
})

describe('REST queries (§11)', () => {
  it('candidates: per-fidelity token counts with absent fidelities omitted', async () => {
    h = await makeEngine()
    const candidates = await h.engine.candidates()
    const bare = candidates.find((c) => c.id === tid(3)) // no summaries
    expect(bare?.tokens.full).toBeGreaterThan(0)
    expect(bare?.tokens.short).toBeUndefined()
    expect(bare?.tokens.long).toBeUndefined()
    const withLong = candidates.find((c) => c.id === tid(1))
    expect(withLong?.tokens.long).toBeGreaterThan(0)
    const world = candidates.find((c) => c.id === tid(21))
    expect(world?.kind).toBe('world')
    expect(world?.tokens.full).toBeGreaterThan(0)
    // snippets are not candidates (always full, never elevated)
    expect(candidates.every((c) => c.kind !== 'snippet')).toBe(true)
  })

  it('candidates reflect elevations in currentFidelity after a completed task', async () => {
    h = await makeEngine()
    const session = await h.engine.beginTask({ kind: 'continue' })
    session.assembleInitialPrompt()
    await session.handleToolCall({
      name: 'context_expand',
      args: { kind: 'world', id: tid(21), level: 'full' },
    })
    await session.finalize('completed')
    const candidates = await h.engine.candidates()
    const mara = candidates.find((c) => c.id === tid(21))
    expect(mara?.currentFidelity).toBe('full')
    expect(mara?.defaultFidelity).toBe('short')
  })

  it('preview: totals, per-region, and server-fed effective budgets', async () => {
    h = await makeEngine()
    const res = await h.engine.preview({ taskType: 'continue', selections: [], targets: [] })
    expect(res.totalTokens).toBeGreaterThan(0)
    expect(res.perRegion['local-context']).toBeGreaterThan(0)
    expect(res.softBudget).toBe(32_000)
    expect(res.hardCap).toBe(64_000)
    expect(res.overSoft).toBe(false)
    expect(res.overHard).toBe(false)
  })

  it('preview overlays selections into expanded-context and flags overSoft', async () => {
    h = await makeEngine(sampleWork(), { knobs: { softBudget: 10 } })
    const base = await h.engine.preview({ taskType: 'continue', selections: [], targets: [] })
    const withSelection = await h.engine.preview({
      taskType: 'continue',
      selections: [{ id: tid(21), kind: 'world', fidelity: 'full' }],
      targets: [],
    })
    expect(withSelection.perRegion['expanded-context']).toBeGreaterThan(0)
    expect(withSelection.totalTokens).toBeGreaterThan(base.totalTokens)
    expect(withSelection.overSoft).toBe(true)
    expect(withSelection.softBudget).toBe(10) // effective override served back
  })

  it('preview rejects non-interactive kinds with a validation error', async () => {
    h = await makeEngine()
    await expect(
      h.engine.preview({ taskType: 'enrich-section', selections: [], targets: [] }),
    ).rejects.toBeInstanceOf(EngineValidationError)
  })

  it('preview never disturbs the persisted ledger or the cache_break baseline', async () => {
    h = await makeEngine()
    await h.engine.preview({
      taskType: 'continue',
      selections: [{ id: tid(21), kind: 'world', fidelity: 'full' }],
      targets: [],
    })
    const stateRes = await h.engine.stateRes()
    expect(stateRes.state.elevated).toHaveLength(0)
  })

  it('state: ledger + computed default map (sections and world entries)', async () => {
    h = await makeEngine()
    const res = await h.engine.stateRes()
    expect(res.state.taskCounter).toBe(0)
    const rows = new Map(res.defaultMap.map((r) => [r.id, r]))
    expect(rows.get(tid(3))?.fidelity).toBe('full') // rule-2 un-enriched leaf
    expect(rows.get(tid(21))?.fidelity).toBe('short')
    expect(rows.get(tid(22))?.fidelity).toBe('name')
  })

  it('reset wipes ledger + anchors and refuses while a session is open', async () => {
    h = await makeEngine()
    const session = await h.engine.beginTask({ kind: 'continue' })
    session.assembleInitialPrompt()
    await session.handleToolCall({
      name: 'context_expand',
      args: { kind: 'world', id: tid(21), level: 'full' },
    })
    await expect(h.engine.reset()).rejects.toBeInstanceOf(SessionBusyError)
    await session.finalize('completed')
    await h.engine.reset()
    const state = ContextState.parse(JSON.parse(await fsp.readFile(await statePath(), 'utf8')))
    expect(state.elevated).toHaveLength(0)
    expect(state.taskCounter).toBe(0)
  })
})

describe('knob resolution (§8.1)', () => {
  it('schema defaults ← overrides, sparse and layered', () => {
    expect(resolveBudgetKnobs({}).softBudget).toBe(32_000)
    const merged = resolveBudgetKnobs({ softBudget: 1000, maxToolCalls: 2 })
    expect(merged.softBudget).toBe(1000)
    expect(merged.maxToolCalls).toBe(2)
    expect(merged.hardCap).toBe(64_000) // untouched default
  })

  it('per-work overrides re-resolve per task via the knobs thunk', async () => {
    let soft = 32_000
    h = await makeEngine(sampleWork(), { knobs: () => ({ softBudget: soft }) })
    const a = await h.engine.preview({ taskType: 'continue', selections: [], targets: [] })
    expect(a.softBudget).toBe(32_000)
    soft = 500
    const b = await h.engine.preview({ taskType: 'continue', selections: [], targets: [] })
    expect(b.softBudget).toBe(500) // a PATCH between tasks applies immediately
  })
})
