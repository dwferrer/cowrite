import { describe, expect, it } from 'vitest'
import { WORK_EVENT_TYPES, WorkEvent } from './events.js'

const ulid = '01J2P7Q4V2M8Z6T1RD5FCW9XKB'
const taskId = '01J2P7R9GT5W0ZNXK3M8QAB4CD'

const snippetDto = {
  id: ulid,
  orderKey: 'a2',
  text: 'Mara pressed her palm against the storm glass...',
  rev: 1,
  authorship: 'agent',
  originRunId: taskId,
  updatedAt: '2026-07-06T14:02:11Z',
  revisionCount: 1,
} as const

const sectionRow = {
  id: ulid,
  parentId: null,
  kind: 'chapter',
  orderKey: 'a1',
  title: 'The Ferry',
  titleSource: 'agent',
  isLeaf: true,
  wordCount: 3200,
  contentHash: 'xxh64:0123456789abcdef',
  shortSummary: 'Mara crosses at night; the glass cracks.',
  longSummary: null,
  illustration: null,
  stale: { short: false, long: false, illustration: true },
} as const

describe('WorkEvent names (09 §shared: spellings locked — a rename is a contract change)', () => {
  it('is exactly the 03 §8.2 dot-case vocabulary, in union order', () => {
    expect(WORK_EVENT_TYPES).toEqual([
      'snippet.created',
      'snippet.revised',
      'snippet.deleted',
      'section.changed',
      'sections.restructured',
      'consolidation.applied',
      'consolidation.undone',
      'enrichment.updated',
      'world.changed',
      'situation.changed',
      'readonly.changed',
      'task.queued',
      'task.started',
      'task.stage',
      'task.tool',
      'task.delta',
      'task.snapshot',
      'task.retrying',
      'task.progress',
      'task.artifact',
      'task.usage',
      'task.completed',
      'task.cancelled',
      'task.failed',
      'hello',
      'resync',
    ])
  })

  it('every name is dot-case: lowercase segments joined by dots, no camelCase/underscores', () => {
    for (const name of WORK_EVENT_TYPES) {
      expect(name).toMatch(/^[a-z]+(\.[a-z]+)*$/)
    }
  })
})

describe('WorkEvent payloads', () => {
  it('domain events carry full patch payloads', () => {
    expect(WorkEvent.parse({ type: 'snippet.created', snippet: snippetDto }).type).toBe(
      'snippet.created',
    )
    expect(WorkEvent.parse({ type: 'section.changed', section: sectionRow }).type).toBe(
      'section.changed',
    )
    const enrichment = WorkEvent.parse({
      type: 'enrichment.updated',
      sectionId: ulid,
      kind: 'illustration',
      section: sectionRow,
    })
    expect(enrichment.type).toBe('enrichment.updated')
  })

  it('world.changed without entryId is the refetch-list signal', () => {
    const parsed = WorkEvent.parse({ type: 'world.changed' })
    expect(parsed.type === 'world.changed' && parsed.entryId).toBeUndefined()
  })

  it('task.started lifts lane and target for the reducer', () => {
    const parsed = WorkEvent.parse({
      type: 'task.started',
      task: {
        id: taskId,
        workId: ulid,
        spec: { kind: 'continue' },
        lane: 'interactive',
        status: 'running',
        queuedAt: '2026-07-06T14:00:00Z',
        startedAt: '2026-07-06T14:00:01Z',
        endedAt: null,
        error: null,
      },
      lane: 'interactive',
      target: { kind: 'frontier' },
    })
    expect(parsed.type === 'task.started' && parsed.lane).toBe('interactive')
    expect(
      WorkEvent.safeParse({ type: 'task.started', task: {}, lane: 'fast', target: {} }).success,
    ).toBe(false)
  })

  it('task.delta always carries a target string', () => {
    expect(
      WorkEvent.parse({ type: 'task.delta', taskId, target: 'frontier', text: 'and then' }).type,
    ).toBe('task.delta')
    expect(WorkEvent.safeParse({ type: 'task.delta', taskId, text: 'x' }).success).toBe(false)
  })

  it('task.progress speaks the illustration phase enum; pct null outside generating', () => {
    const parsed = WorkEvent.parse({
      type: 'task.progress',
      taskId,
      phase: 'critiquing',
      attempt: 2,
      maxAttempts: 3,
      pct: null,
    })
    expect(parsed.type === 'task.progress' && parsed.phase).toBe('critiquing')
    expect(
      WorkEvent.safeParse({
        type: 'task.progress',
        taskId,
        phase: 'generating',
        attempt: 1,
        maxAttempts: 3,
        pct: 101,
      }).success,
    ).toBe(false)
    expect(
      WorkEvent.safeParse({
        type: 'task.progress',
        taskId,
        phase: 'uploading',
        attempt: 1,
        maxAttempts: 3,
        pct: null,
      }).success,
    ).toBe(false)
  })

  it('task.failed reuses the closed ErrorCode taxonomy', () => {
    const parsed = WorkEvent.parse({
      type: 'task.failed',
      taskId,
      code: 'endpoint_unreachable',
      message: 'connection refused',
      partialText: null,
      retryable: true,
    })
    expect(parsed.type === 'task.failed' && parsed.code).toBe('endpoint_unreachable')
    expect(
      WorkEvent.safeParse({
        type: 'task.failed',
        taskId,
        code: 'ENOENT',
        message: 'x',
        partialText: null,
        retryable: false,
      }).success,
    ).toBe(false)
  })

  it('stream control: hello carries the resume identity; resync is bare', () => {
    // The SSE `id:` field is "<streamId>:<seq>" (03 §8.3); hello announces both parts.
    const hello = WorkEvent.parse({ type: 'hello', streamId: ulid, seq: 512 })
    expect(hello.type === 'hello' && `${hello.streamId}:${hello.seq}`).toBe(`${ulid}:512`)
    expect(WorkEvent.parse({ type: 'resync' })).toEqual({ type: 'resync' })
  })

  it('rejects unknown event types', () => {
    expect(WorkEvent.safeParse({ type: 'snippet.exploded', id: ulid }).success).toBe(false)
  })
})
