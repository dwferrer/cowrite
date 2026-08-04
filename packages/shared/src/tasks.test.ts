import { describe, expect, it } from 'vitest'
import {
  Lane,
  QUEUE_LANE_CAPACITY,
  QueueLane,
  TASK_KIND_LANE,
  Task,
  TaskCreateReq,
  TaskCreateRes,
  TaskEstimate,
  TaskKind,
  TaskSpec,
  TaskStatus,
} from './tasks.js'

const ulid = '01J2P7Q4V2M8Z6T1RD5FCW9XKB'
const snippetId = '01J2P7R9GT5W0ZNXK3M8QAB4CD'
const hash = 'xxh64:0123456789abcdef'

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

  it('TASK_KIND_LANE covers every kind with the 05 §2 lane column', () => {
    expect(Object.keys(TASK_KIND_LANE).sort()).toEqual([...TaskKind.options].sort())
    expect(TASK_KIND_LANE.continue).toBe('interactive')
    expect(TASK_KIND_LANE['instructed-continue']).toBe('interactive')
    expect(TASK_KIND_LANE['quick-edit']).toBe('interactive')
    expect(TASK_KIND_LANE['edit-task']).toBe('interactive')
    expect(TASK_KIND_LANE['enrich-section']).toBe('background')
    expect(TASK_KIND_LANE['propose-boundaries']).toBe('background')
    expect(TASK_KIND_LANE['illustrate-section']).toBe('illustration')
    expect(TASK_KIND_LANE['world-image']).toBe('illustration')
  })

  it('QUEUE_LANE_CAPACITY is the fixed 05 §6.1 policy (interactive 1 ⇒ 409 busy semantics)', () => {
    expect(QUEUE_LANE_CAPACITY).toEqual({ interactive: 1, background: 2, illustration: 1 })
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

  it('quick-edit also accepts the M2 section-span target shape', () => {
    const spec = TaskSpec.parse({
      kind: 'quick-edit',
      instruction: 'smooth the transition',
      target: {
        type: 'sectionSpan',
        span: { sectionId: ulid, startChar: 1180, endChar: 2440, baseContentHash: hash },
      },
      selection: { text: 'The ferry lurched.', start: 1180, end: 1198 },
    })
    expect(spec.kind === 'quick-edit' && spec.target.type).toBe('sectionSpan')
  })

  it('rejects unknown kinds and an empty instruction', () => {
    expect(TaskSpec.safeParse({ kind: 'continue-writing' }).success).toBe(false)
    expect(TaskSpec.safeParse({ kind: 'instructed-continue', instruction: '' }).success).toBe(false)
    expect(TaskSpec.safeParse({ kind: 'propose-boundaries', eligibleSnippetIds: [] }).success).toBe(
      false,
    )
  })

  it('enforces the per-kind instruction caps (4 000 / 500 / 20 000)', () => {
    expect(
      TaskSpec.safeParse({ kind: 'instructed-continue', instruction: 'x'.repeat(4001) }).success,
    ).toBe(false)
    expect(
      TaskSpec.safeParse({
        kind: 'quick-edit',
        instruction: 'x'.repeat(501),
        target: { type: 'snippet', snippetId, baseRev: 1 },
        selection: { text: 't', start: 0, end: 1 },
      }).success,
    ).toBe(false)
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

describe('TaskCreateReq / TaskCreateRes (03 §3.7 wire pair)', () => {
  it('are identity aliases of TaskSpec and Task — not copies that could drift', () => {
    expect(TaskCreateReq).toBe(TaskSpec)
    expect(TaskCreateRes).toBe(Task)
  })
})

describe('TaskEstimate (05 §9, M2 response shape)', () => {
  it('round-trips the estimate sample with a null cost when prices are unconfigured', () => {
    const estimate = {
      promptTokens: 28_400,
      perRegion: { 'world-info': 2_100, 'local-context': 9_300 },
      maxCompletionTokens: 2_048,
      overSoft: false,
      overHard: false,
      costUsd: null,
    } as const
    expect(TaskEstimate.parse(estimate)).toEqual(estimate)
  })
})
