import type { Task, TaskSpec } from '@cowrite/shared'
import { beforeEach, describe, expect, it } from 'vitest'
import { findIllustrationTask, specTarget, useTaskStore } from './taskStore.js'

/**
 * Lane routing + slot lifecycle (docs/04-frontend.md §4.4): one interactive slot, a
 * background map, keep-partial/conflict proposals. A background task.started mid-stream
 * must never touch the interactive slot.
 */

const W = '01ARZ3NDEKTSV4RRFFQ69G5FA0'
const T1 = '01ARZ3NDEKTSV4RRFFQ69G5FA1'
const T2 = '01ARZ3NDEKTSV4RRFFQ69G5FA2'
const S1 = '01ARZ3NDEKTSV4RRFFQ69G5FA3'
const NOW = '2026-08-02T00:00:00.000Z'

function task(id: string, spec: TaskSpec, lane: Task['lane'] = 'interactive'): Task {
  return {
    id,
    workId: W,
    spec,
    lane,
    status: 'running',
    queuedAt: NOW,
    startedAt: NOW,
    endedAt: null,
    error: null,
    partialText: null,
    unresolvedProposal: null,
  }
}

const CONTINUE: TaskSpec = { kind: 'continue' }
const ENRICH: TaskSpec = { kind: 'enrich-section', sectionId: S1 }
const QUICK_EDIT: TaskSpec = {
  kind: 'quick-edit',
  instruction: 'tighten it',
  target: { type: 'snippet', snippetId: S1, baseRev: 2 },
  selection: { text: 'abc', start: 0, end: 3 },
}

beforeEach(() => {
  useTaskStore.getState().reset()
})

describe('taskStore lane routing (04 §4.4)', () => {
  it('routes interactive task.started into the slot with planning stage', () => {
    useTaskStore.getState().started(task(T1, CONTINUE), 'interactive', { kind: 'frontier' })
    const s = useTaskStore.getState()
    expect(s.interactive?.taskId).toBe(T1)
    expect(s.interactive?.runId).toBe(T1) // 1 task : 1 run
    expect(s.interactive?.stage).toBe('planning')
    expect(s.interactive?.instruction).toBeNull()
    expect(s.background.size).toBe(0)
  })

  it('carries the instruction for instructed/quick-edit specs', () => {
    useTaskStore
      .getState()
      .started(task(T1, QUICK_EDIT), 'interactive', { kind: 'snippet', id: S1 })
    expect(useTaskStore.getState().interactive?.instruction).toBe('tighten it')
    expect(useTaskStore.getState().interactive?.target).toEqual({ kind: 'snippet', id: S1 })
  })

  it('a background task.started mid-stream never touches the interactive slot', () => {
    const store = useTaskStore.getState()
    store.started(task(T1, CONTINUE), 'interactive', { kind: 'frontier' })
    store.appendDeltas(T1, [{ target: 'frontier', text: 'Mara pressed' }])

    useTaskStore
      .getState()
      .started(task(T2, ENRICH, 'background'), 'background', { kind: 'section', id: S1 })

    const s = useTaskStore.getState()
    expect(s.interactive?.taskId).toBe(T1)
    expect(s.interactive?.buffers.get('frontier')).toBe('Mara pressed')
    expect(s.background.get(T2)).toEqual({
      kind: 'enrich-section',
      target: { kind: 'section', id: S1 },
    })
  })

  it('task.queued lands in the background map with its position; interactive never queues', () => {
    const store = useTaskStore.getState()
    store.queued(task(T2, ENRICH, 'background'), 1)
    expect(useTaskStore.getState().background.get(T2)?.queuedPosition).toBe(1)

    store.queued(task(T1, CONTINUE), 0)
    expect(useTaskStore.getState().interactive).toBeNull()
    expect(useTaskStore.getState().background.has(T1)).toBe(false)
  })

  it('later events are routed by taskId lookup — unknown ids are no-ops', () => {
    useTaskStore.getState().started(task(T1, CONTINUE), 'interactive', { kind: 'frontier' })
    useTaskStore.getState().setStage(T2, 'writing')
    useTaskStore.getState().appendDeltas(T2, [{ target: 'frontier', text: 'nope' }])
    const s = useTaskStore.getState()
    expect(s.interactive?.stage).toBe('planning')
    expect(s.interactive?.buffers.size).toBe(0)
  })
})

describe('interactive stream state', () => {
  beforeEach(() => {
    useTaskStore.getState().started(task(T1, CONTINUE), 'interactive', { kind: 'frontier' })
  })

  it('stage flips, tool notes accumulate', () => {
    useTaskStore.getState().addToolNote(T1, 'opened Chapter 7')
    useTaskStore.getState().setStage(T1, 'writing')
    const s = useTaskStore.getState()
    expect(s.interactive?.stage).toBe('writing')
    expect(s.interactive?.toolNotes).toEqual(['opened Chapter 7'])
  })

  it('deltas append per target; snapshot replaces the buffer wholesale', () => {
    const store = useTaskStore.getState()
    store.appendDeltas(T1, [
      { target: 'frontier', text: 'Mara ' },
      { target: 'frontier', text: 'pressed' },
    ])
    expect(useTaskStore.getState().interactive?.buffers.get('frontier')).toBe('Mara pressed')

    useTaskStore.getState().snapshotBuffer(T1, 'frontier', 'Mara pressed her palm')
    expect(useTaskStore.getState().interactive?.buffers.get('frontier')).toBe(
      'Mara pressed her palm',
    )
  })

  it('retrying resets the buffers and records the attempt', () => {
    useTaskStore.getState().appendDeltas(T1, [{ target: 'frontier', text: 'half a sentence' }])
    useTaskStore.getState().retrying(T1, 2, 'output_invalid')
    const s = useTaskStore.getState()
    expect(s.interactive?.buffers.size).toBe(0)
    expect(s.interactive?.retrying).toEqual({ attempt: 2, reason: 'output_invalid' })
  })

  it('the retrying badge CLEARS on the first post-retry delta (04 §8.3)', () => {
    useTaskStore.getState().retrying(T1, 2, 'rate_limited')
    expect(useTaskStore.getState().interactive?.retrying).not.toBeNull()
    useTaskStore.getState().appendDeltas(T1, [{ target: 'frontier', text: 'fresh attempt' }])
    expect(useTaskStore.getState().interactive?.retrying).toBeNull()
  })

  it('the retrying badge CLEARS on a post-retry snapshot too (reconnect path)', () => {
    useTaskStore.getState().retrying(T1, 3, 'endpoint_unreachable')
    useTaskStore.getState().snapshotBuffer(T1, 'frontier', 'replayed text')
    expect(useTaskStore.getState().interactive?.retrying).toBeNull()
  })

  it('usage lands on the status line', () => {
    useTaskStore
      .getState()
      .setUsage(T1, { promptTokens: 6412, completionTokens: 388, estimated: false, costUsd: null })
    expect(useTaskStore.getState().interactive?.usage?.promptTokens).toBe(6412)
  })

  it('completed clears the slot (the committed snippet rides its own domain event)', () => {
    useTaskStore.getState().completed(T1)
    const s = useTaskStore.getState()
    expect(s.interactive).toBeNull()
    expect(s.proposal).toBeNull()
  })
})

describe('keep-partial and conflict proposals (04 §8.4)', () => {
  it('failed with partialText offers the keep-partial proposal', () => {
    useTaskStore.getState().started(task(T1, CONTINUE), 'interactive', { kind: 'frontier' })
    useTaskStore.getState().failed(T1, {
      code: 'timeout',
      message: 'upstream timeout',
      partialText: 'The storm arrived',
      retryable: true,
    })
    const s = useTaskStore.getState()
    expect(s.interactive).toBeNull()
    expect(s.proposal).toEqual({
      taskId: T1,
      kind: 'continue',
      target: { kind: 'frontier' },
      text: 'The storm arrived',
      reason: 'failed',
      message: 'upstream timeout',
      retryable: true,
    })
  })

  it('failed without partialText clears silently (nothing to keep)', () => {
    useTaskStore.getState().started(task(T1, CONTINUE), 'interactive', { kind: 'frontier' })
    useTaskStore
      .getState()
      .failed(T1, { code: 'auth', message: 'bad key', partialText: null, retryable: false })
    expect(useTaskStore.getState().proposal).toBeNull()
  })

  it('cancelled with partialText offers keep-partial', () => {
    useTaskStore.getState().started(task(T1, CONTINUE), 'interactive', { kind: 'frontier' })
    useTaskStore.getState().cancelled(T1, 'partial prose')
    expect(useTaskStore.getState().proposal?.reason).toBe('cancelled')
    expect(useTaskStore.getState().proposal?.text).toBe('partial prose')
  })

  it('a conflict artifact + completion surfaces apply-anyway with the buffered rewrite', () => {
    useTaskStore
      .getState()
      .started(task(T1, QUICK_EDIT), 'interactive', { kind: 'snippet', id: S1 })
    useTaskStore.getState().appendDeltas(T1, [{ target: S1, text: 'the rewritten passage' }])
    useTaskStore
      .getState()
      .artifact(T1, { kind: 'snippet-revision', snippetId: S1, rev: 3, state: 'conflict' })
    useTaskStore.getState().completed(T1)

    const s = useTaskStore.getState()
    expect(s.interactive).toBeNull()
    expect(s.proposal?.reason).toBe('conflict')
    expect(s.proposal?.target).toEqual({ kind: 'snippet', id: S1 })
    expect(s.proposal?.text).toBe('the rewritten passage')
  })

  it('committed artifacts do not arm a conflict', () => {
    useTaskStore.getState().started(task(T1, CONTINUE), 'interactive', { kind: 'frontier' })
    useTaskStore
      .getState()
      .artifact(T1, { kind: 'snippet', snippetId: S1, rev: 1, state: 'committed' })
    useTaskStore.getState().completed(T1)
    expect(useTaskStore.getState().proposal).toBeNull()
  })

  it('background failures stay quiet — entry removed, no proposal', () => {
    useTaskStore
      .getState()
      .started(task(T2, ENRICH, 'background'), 'background', { kind: 'section', id: S1 })
    useTaskStore
      .getState()
      .failed(T2, { code: 'timeout', message: 'slow', partialText: 'x', retryable: true })
    const s = useTaskStore.getState()
    expect(s.background.has(T2)).toBe(false)
    expect(s.proposal).toBeNull()
  })
})

describe('task.state attach-frame hydration (03 §8.3)', () => {
  it('a running frame seeds an empty slot (reload during planning: empty accumulator)', () => {
    useTaskStore.getState().stateFrame(task(T1, CONTINUE), 'interactive', { kind: 'frontier' })
    const s = useTaskStore.getState()
    expect(s.interactive?.taskId).toBe(T1)
    expect(s.interactive?.stage).toBe('planning') // no snapshot text yet — planning line
  })

  it('a running illustration frame seeds the background map so the caption resumes (§19)', () => {
    const spec: TaskSpec = { kind: 'illustrate-section', sectionId: S1 }
    // A reconnect replays the illustration task.state, then its latest task.progress.
    useTaskStore.getState().stateFrame(task(T2, spec, 'illustration'), 'illustration', {
      kind: 'section',
      id: S1,
    })
    useTaskStore
      .getState()
      .progress(T2, { phase: 'generating', attempt: 2, maxAttempts: 3, pct: 64 })
    const view = findIllustrationTask(useTaskStore.getState().background, 'section', S1)
    expect(view).not.toBeNull()
    expect(view?.taskId).toBe(T2)
    expect(view?.phase).toBe('generating')
    expect(view?.pct).toBe(64)
    // it must not touch the interactive slot
    expect(useTaskStore.getState().interactive).toBeNull()
  })

  it('a running frame never clobbers the live slot for the same task', () => {
    useTaskStore.getState().started(task(T1, CONTINUE), 'interactive', { kind: 'frontier' })
    useTaskStore.getState().appendDeltas(T1, [{ target: 'frontier', text: 'kept text' }])
    useTaskStore.getState().stateFrame(task(T1, CONTINUE), 'interactive', { kind: 'frontier' })
    expect(useTaskStore.getState().interactive?.buffers.get('frontier')).toBe('kept text')
  })

  it('a terminal frame clears a stale slot (reload milliseconds before completion)', () => {
    useTaskStore.getState().started(task(T1, CONTINUE), 'interactive', { kind: 'frontier' })
    useTaskStore
      .getState()
      .stateFrame({ ...task(T1, CONTINUE), status: 'done', endedAt: NOW }, 'interactive', {
        kind: 'frontier',
      })
    expect(useTaskStore.getState().interactive).toBeNull()
    expect(useTaskStore.getState().proposal).toBeNull()
  })

  it('a terminal frame with an unresolved proposal re-offers the KeepPartialCard', () => {
    useTaskStore.getState().stateFrame(
      {
        ...task(T1, CONTINUE),
        status: 'error',
        endedAt: NOW,
        error: { code: 'timeout', message: 'the model went away' },
        partialText: 'The storm arrived before',
        unresolvedProposal: { kind: 'keep-partial' },
      },
      'interactive',
      { kind: 'frontier' },
    )
    const proposal = useTaskStore.getState().proposal
    expect(proposal).toMatchObject({
      taskId: T1,
      reason: 'failed',
      text: 'The storm arrived before',
      message: 'the model went away',
    })
  })

  it('a terminal frame WITHOUT the proposal clears a stale offer (resolved elsewhere)', () => {
    useTaskStore.getState().stateFrame(
      {
        ...task(T1, CONTINUE),
        status: 'error',
        endedAt: NOW,
        partialText: 'partial',
        unresolvedProposal: { kind: 'keep-partial' },
      },
      'interactive',
      { kind: 'frontier' },
    )
    expect(useTaskStore.getState().proposal).not.toBeNull()
    useTaskStore
      .getState()
      .stateFrame({ ...task(T1, CONTINUE), status: 'error', endedAt: NOW }, 'interactive', {
        kind: 'frontier',
      })
    expect(useTaskStore.getState().proposal).toBeNull()
  })
})

describe('background progress + reset', () => {
  it('task.progress patches the illustration caption fields', () => {
    useTaskStore
      .getState()
      .started(task(T2, ENRICH, 'background'), 'background', { kind: 'section', id: S1 })
    useTaskStore
      .getState()
      .progress(T2, { phase: 'generating', attempt: 2, maxAttempts: 3, pct: 64 })
    expect(useTaskStore.getState().background.get(T2)).toMatchObject({
      phase: 'generating',
      attempt: 2,
      maxAttempts: 3,
      pct: 64,
    })
  })

  it('reset clears everything on work switch', () => {
    useTaskStore.getState().started(task(T1, CONTINUE), 'interactive', { kind: 'frontier' })
    useTaskStore.getState().queued(task(T2, ENRICH, 'background'), 0)
    useTaskStore.getState().reset()
    const s = useTaskStore.getState()
    expect(s.interactive).toBeNull()
    expect(s.background.size).toBe(0)
    expect(s.proposal).toBeNull()
  })
})

describe('specTarget', () => {
  it('derives targets for queued specs', () => {
    expect(specTarget({ kind: 'continue' })).toEqual({ kind: 'frontier' })
    expect(specTarget(ENRICH)).toEqual({ kind: 'section', id: S1 })
    expect(specTarget(QUICK_EDIT)).toEqual({ kind: 'snippet', id: S1 })
    expect(specTarget({ kind: 'world-image', entryId: S1 })).toEqual({ kind: 'entry', id: S1 })
  })
})
