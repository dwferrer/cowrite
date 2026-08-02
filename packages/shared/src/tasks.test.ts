import { describe, expect, it } from 'vitest'
import {
  HarnessKnobs,
  HarnessKnobsOverrides,
  Lane,
  QueueLane,
  Task,
  TaskKind,
  TaskSpec,
  TaskStatus,
} from './tasks.js'

const ulid = '01J2P7Q4V2M8Z6T1RD5FCW9XKB'
const snippetId = '01J2P7R9GT5W0ZNXK3M8QAB4CD'

describe('TaskKind', () => {
  it('is exactly the 8 kebab-case kinds of 02 §2.7', () => {
    expect(TaskKind.options).toEqual([
      'continue',
      'instructed-continue',
      'quick-edit',
      'edit-task',
      'enrich-section',
      'propose-boundaries',
      'illustrate-section',
      'world-image',
    ])
    expect(TaskKind.safeParse('quickEdit').success).toBe(false)
  })
})

describe('Lane', () => {
  it('is the high | low model-lane split', () => {
    expect(Lane.options).toEqual(['high', 'low'])
    expect(Lane.safeParse('interactive').success).toBe(false)
  })
})

describe('QueueLane / TaskStatus', () => {
  it('locks the scheduling vocabulary', () => {
    expect(QueueLane.options).toEqual(['interactive', 'background', 'illustration'])
    expect(TaskStatus.options).toEqual(['queued', 'running', 'done', 'error', 'cancelled'])
  })
})

describe('TaskSpec (05 §2.1)', () => {
  it('parses the M1 client-submittable variants', () => {
    expect(TaskSpec.parse({ kind: 'continue' }).kind).toBe('continue')
    expect(
      TaskSpec.parse({ kind: 'instructed-continue', instruction: 'Bring the storm in' }).kind,
    ).toBe('instructed-continue')
    const quickEdit = TaskSpec.parse({
      kind: 'quick-edit',
      instruction: 'tighten this',
      target: { type: 'snippet', snippetId, baseRev: 2 },
      selection: { text: 'the glass cracks', start: 10, end: 26 },
    })
    expect(quickEdit.kind).toBe('quick-edit')
    expect(TaskSpec.parse({ kind: 'enrich-section', sectionId: ulid }).kind).toBe('enrich-section')
  })

  it('edit-task defaults its pinned/selection arrays', () => {
    const spec = TaskSpec.parse({
      kind: 'edit-task',
      instruction: 'Rewrite for tension',
      targets: [{ type: 'snippet', snippetId, baseRev: 1 }],
    })
    expect(spec.kind === 'edit-task' && spec.pinnedWorldEntryIds).toEqual([])
    expect(spec.kind === 'edit-task' && spec.contextSelections).toEqual([])
  })

  it('rejects unknown kinds and an empty instruction', () => {
    expect(TaskSpec.safeParse({ kind: 'continue-writing' }).success).toBe(false)
    expect(TaskSpec.safeParse({ kind: 'instructed-continue', instruction: '' }).success).toBe(false)
    expect(TaskSpec.safeParse({ kind: 'propose-boundaries', eligibleSnippetIds: [] }).success).toBe(
      false,
    )
  })
})

describe('Task', () => {
  it('parses a queued task envelope', () => {
    const task = Task.parse({
      id: ulid,
      workId: snippetId,
      spec: { kind: 'continue' },
      lane: 'interactive',
      status: 'queued',
      queuedAt: '2026-07-06T14:00:00Z',
      startedAt: null,
      endedAt: null,
      error: null,
    })
    expect(task.status).toBe('queued')
    expect(Task.safeParse({ ...task, lane: 'high' }).success).toBe(false)
  })
})

describe('HarnessKnobs (05 §6.4)', () => {
  it('materializes every documented default from {}', () => {
    expect(HarnessKnobs.parse({})).toEqual({
      connectTimeoutMs: 15_000,
      firstTokenTimeoutMs: 60_000,
      idleTokenTimeoutMs: 30_000,
      totalTimeoutMs: { high: 300_000, low: 120_000 },
      illustrationBudgetMs: 600_000,
      retry: { maxAttempts: 3, backoffMs: 1_000, backoffMaxMs: 4_000 },
    })
  })

  it('overrides stay sparse — no re-materialized defaults (the zod 4 .partial() gotcha)', () => {
    expect(HarnessKnobsOverrides.parse({})).toEqual({})
    expect(HarnessKnobsOverrides.parse({ totalTimeoutMs: { high: 600_000 } })).toEqual({
      totalTimeoutMs: { high: 600_000 },
    })
  })
})
