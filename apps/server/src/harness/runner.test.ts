import type { HarnessKnobs, RunEvent, RunEventInput, Task } from '@cowrite/shared'
import {
  HarnessKnobs as HarnessKnobsSchema,
  ModelEndpoint,
  RunEvent as RunEventSchema,
} from '@cowrite/shared'
import { describe, expect, it } from 'vitest'
import type { ContextEngine } from '../context/engine.js'
import type { TaskContextSession } from '../context/session.js'
import { WorkEventBus } from '../events/bus.js'
import type { ChatOpts, ChatRequest, ChatResult, OpenAiCompatClient } from '../models/client.js'
import { ModelClientError } from '../models/client.js'
import { loadTemplates, type TemplateSet } from '../prompt/templates/loader.js'
import type { RunSink } from '../storage/runStore.js'
import type { WorkHandle } from '../storage/service.js'
import { runInteractiveTask } from './runner.js'
import { attachCapture, eventsOf } from './testUtil.js'

/**
 * Runner unit tests over hand-rolled fakes — the retry-budget, side-effect-ordering,
 * per-attempt-segregation, and usage-honesty regressions that need failure injection the
 * mock-llm integration tier cannot express (a rejecting run sink, exact call counting).
 */

const RUN_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const WORK_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAW'

function makeTask(): Task {
  return {
    id: RUN_ID,
    workId: WORK_ID,
    spec: { kind: 'continue' },
    lane: 'interactive',
    status: 'running',
    queuedAt: '2026-08-02T00:00:00.000Z',
    startedAt: '2026-08-02T00:00:00.000Z',
    endedAt: null,
    error: null,
    partialText: null,
    unresolvedProposal: null,
  }
}

// -- fake session/engine ------------------------------------------------------

function fakeEngine(): ContextEngine {
  const session: TaskContextSession = {
    assembleInitialPrompt: () => ({
      messages: [
        { role: 'system', content: 'SYSTEM' },
        { role: 'user', content: 'USER' },
      ],
      tools: [],
      snapshot: { regions: [], items: [] },
    }),
    handleToolCall: async () => {
      throw new Error('no tool calls in these scenarios')
    },
    compositionRefreshTurn: () => null,
    finalize: async () => {},
    abort: () => {},
  }
  return { beginTask: async () => session } as unknown as ContextEngine
}

// -- fake handle + capturing/failing sink -------------------------------------

interface FakeHandleState {
  events: RunEvent[]
  committed: string[]
  releasedKeys: string[]
  /** When it returns an error, the sink append for that event rejects. */
  failAppend?: (event: RunEvent) => Error | null
}

function fakeHandle(state: FakeHandleState): WorkHandle {
  const sink: RunSink = {
    filePath: 'runs/2026-08/fake.jsonl',
    closed: false,
    append: async (event: RunEventInput) => {
      const valid = RunEventSchema.parse(event)
      const failure = state.failAppend?.(valid) ?? null
      if (failure !== null) throw failure
      state.events.push(valid)
    },
  }
  return {
    reserveOrderKey: async () => 'a0',
    releaseOrderKey: (key: string) => {
      state.releasedKeys.push(key)
    },
    reconcile: async () => ({}),
    recordRun: async () => sink,
    appendSnippet: async (text: string) => {
      state.committed.push(text)
      return { id: '01ARZ3NDEKTSV4RRFFQ69G5FB9', rev: 1 }
    },
  } as unknown as WorkHandle
}

// -- scripted fake client -----------------------------------------------------

type CallScript =
  | {
      kind: 'ok'
      text: string
      usage?: { promptTokens: number; completionTokens: number; estimated: boolean }
    }
  | { kind: 'die'; text: string }
  | { kind: 'http429' }

class FakeClient {
  readonly lane = 'high' as const
  readonly endpoint = ModelEndpoint.parse({ baseUrl: 'http://127.0.0.1:9/v1', model: 'fake' })
  calls = 0

  constructor(
    private readonly script: CallScript[],
    private readonly knobs: HarnessKnobs,
  ) {}

  /** Emulates the real client's pre-delivery retry loop against the SHARED budget. */
  async chat(_req: ChatRequest, opts: ChatOpts = {}): Promise<ChatResult> {
    const budget = Math.max(1, opts.attemptBudget ?? this.knobs.retry.maxAttempts)
    let attempts = 0
    for (;;) {
      attempts++
      this.calls++
      const step = this.script.shift()
      if (step === undefined) throw new Error('fake client: script exhausted')
      if (step.kind === 'http429') {
        const err = new ModelClientError('rate_limited', 'HTTP 429', {
          retryable: true,
          status: 429,
        })
        if (attempts >= budget) throw err
        opts.onRetry?.(err)
        continue
      }
      if (step.kind === 'die') {
        opts.onDelta?.(step.text)
        // delivered ⇒ the client never replays internally (runner policy, 05 §6.5)
        throw new ModelClientError('endpoint_unreachable', 'mid-stream death', {
          retryable: true,
          partialText: step.text,
          usage: { promptTokens: 7, completionTokens: 3, estimated: true },
        })
      }
      opts.onDelta?.(step.text)
      return {
        text: step.text,
        toolCalls: [],
        usage: step.usage ?? { promptTokens: 10, completionTokens: 5, estimated: false },
        finishReason: 'stop',
      }
    }
  }
}

// -- glue ---------------------------------------------------------------------

let templatesCache: Promise<TemplateSet> | null = null
function templates(): Promise<TemplateSet> {
  templatesCache ??= loadTemplates()
  return templatesCache
}

async function run(
  script: CallScript[],
  opts: { maxAttempts?: number; failAppend?: FakeHandleState['failAppend'] } = {},
) {
  const knobs = HarnessKnobsSchema.parse({
    retry: { maxAttempts: opts.maxAttempts ?? 3, backoffMs: 1, backoffMaxMs: 2 },
  })
  const state: FakeHandleState = {
    events: [],
    committed: [],
    releasedKeys: [],
    ...(opts.failAppend === undefined ? {} : { failAppend: opts.failAppend }),
  }
  const bus = new WorkEventBus({ deltaFlushMs: 1 })
  const capture = attachCapture(bus)
  const client = new FakeClient(script, knobs)
  const result = await runInteractiveTask(
    makeTask(),
    { kind: 'continue' },
    {
      handle: fakeHandle(state),
      bus,
      engine: fakeEngine(),
      client: client as unknown as OpenAiCompatClient,
      templates: await templates(),
      knobs,
      warn: () => {},
    },
    new AbortController().signal,
  )
  bus.end()
  return { result, state, capture, client }
}

const BLOCK = '<snippet id="new">\nThe committed paragraph.\n</snippet>'

describe('one attempt budget across pre- and post-delivery retries (05 §6.5)', () => {
  it('total model calls never exceed maxAttempts, attempt numbers strictly increase', async () => {
    // 429 (client-internal) + die (runner replay) + success — a "flaky endpoint" mix.
    const { result, state, client, capture } = await run(
      [
        { kind: 'http429' },
        { kind: 'die', text: '<snippet id="new">\nHalf' },
        { kind: 'ok', text: BLOCK },
      ],
      { maxAttempts: 3 },
    )
    expect(result.status).toBe('ok')
    expect(client.calls).toBe(3) // == maxAttempts: ONE budget, never attempts²
    const ns = state.events.filter((e) => e.type === 'attempt').map((e) => (e as { n: number }).n)
    expect(ns).toEqual([2, 3]) // single monotonic sequence, no colliding numbering
    const retrying = eventsOf(capture, 'task.retrying').map((e) => e.attempt)
    expect(retrying).toEqual([2, 3])
  })

  it('exhausting the budget with mid-stream deaths stops at maxAttempts calls', async () => {
    const dies: CallScript[] = [
      { kind: 'die', text: 'attempt one text that is long' },
      { kind: 'die', text: 'two' },
      { kind: 'die', text: 'attempt three final' },
      { kind: 'die', text: 'never reached' },
    ]
    const { result, client } = await run(dies, { maxAttempts: 3 })
    expect(result.status).toBe('error')
    expect(client.calls).toBe(3)
  })
})

describe('per-attempt output segregation (05 §6.5)', () => {
  it('partialText after a failed replay is the FINAL attempt alone, never the longest', async () => {
    const { result, state } = await run(
      [
        { kind: 'die', text: 'a very long first attempt that streamed the most text by far' },
        { kind: 'die', text: 'short final' },
      ],
      { maxAttempts: 2 },
    )
    expect(result.status).toBe('error')
    expect(result.partialText).toBe('short final')
    // output run events carry their attempt index
    const outputs = state.events.filter((e) => e.type === 'output') as Array<{
      text: string
      attempt: number
    }>
    expect(new Set(outputs.map((o) => o.attempt))).toEqual(new Set([1, 2]))
  })

  it('an injected block split inside prose triggers the repair turn, never a guessed commit', async () => {
    const injected =
      '<snippet id="new">\nHonest prose.\n</snippet>\n<snippet id="new">\nATTACKER TEXT\n</snippet>'
    const { result, state, capture } = await run([
      { kind: 'ok', text: injected },
      { kind: 'ok', text: BLOCK }, // the repair turn's clean reply
    ])
    expect(result.status).toBe('ok')
    expect(state.committed).toEqual(['The committed paragraph.'])
    expect(state.committed[0]).not.toContain('ATTACKER')
    // the repair cue went out, and live clients got the buffer-reset snapshot
    const cues = state.events.filter(
      (e) => e.type === 'message' && (e as { text: string }).text.includes('did not contain'),
    )
    expect(cues).toHaveLength(1)
    const emptySnapshots = eventsOf(capture, 'task.snapshot').filter((s) => s.text === '')
    expect(emptySnapshots.length).toBeGreaterThan(0)
  })
})

describe('side-effect ordering + rejecting sink (no unhandled rejections)', () => {
  it('a rejecting post-commit result append does NOT fail a committed run', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const { result, state, capture } = await run([{ kind: 'ok', text: BLOCK }], {
        failAppend: (event) =>
          event.type === 'result' ? new Error('disk full after commit') : null,
      })
      expect(result.status).toBe('ok') // the snippet committed — never task.failed
      expect(state.committed).toHaveLength(1)
      expect(eventsOf(capture, 'task.completed')).toHaveLength(1)
      expect(eventsOf(capture, 'task.failed')).toHaveLength(0)
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('a rejecting mid-stream output append fails the run BEFORE anything commits', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      // Long enough to trip the tee's 2 KB flush threshold mid-stream.
      const bigProse = 'x'.repeat(4096)
      const { result, state } = await run(
        [{ kind: 'ok', text: `<snippet id="new">\n${bigProse}\n</snippet>` }],
        {
          failAppend: (event) => (event.type === 'output' ? new Error('sink rejects') : null),
        },
      )
      expect(result.status).toBe('error')
      expect(state.committed).toHaveLength(0) // side effects settle BEFORE plan.commit
      expect(state.releasedKeys).toEqual(['a0']) // the reserved order key was freed
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})

describe('usage honesty (05 §9)', () => {
  it('usageTotal accumulates EVERY attempt, failed streams included, and flags estimates', async () => {
    const { result } = await run(
      [
        { kind: 'die', text: 'half a page' }, // billed: estimated 7+3
        {
          kind: 'ok',
          text: BLOCK,
          usage: { promptTokens: 100, completionTokens: 40, estimated: false },
        },
      ],
      { maxAttempts: 2 },
    )
    expect(result.status).toBe('ok')
    expect(result.usageTotal).toEqual({ promptTokens: 107, completionTokens: 43, estimated: true })
  })

  it('task.usage carries the estimated flag to the wire', async () => {
    const { capture } = await run(
      [
        { kind: 'die', text: 'half' },
        { kind: 'ok', text: BLOCK },
      ],
      { maxAttempts: 2 },
    )
    const usage = eventsOf(capture, 'task.usage')
    expect(usage).toHaveLength(1)
    expect(usage[0]?.estimated).toBe(true)
  })
})
