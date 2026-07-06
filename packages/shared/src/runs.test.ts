import { describe, expect, it } from 'vitest'
import { ContextSnapshot, RunArtifact, RunEvent, RunSummary } from './runs.js'

const runId = '01J2P7Q4V2M8Z6T1RD5FCW9XKB'
const snippetId = '01J2P7R9GT5W0ZNXK3M8QAB4CD'

// 02 §5.4 — runs/2026-07/<runId>.jsonl lines (spec/contextSnapshot filled in fully)
const metaLine = {
  type: 'meta',
  runId,
  kind: 'continue',
  lane: 'high',
  model: 'glm-5',
  spec: { kind: 'continue' },
  params: { maxTokens: 2048 },
  contextSnapshot: {
    regions: [
      { name: 'world-info', tokens: 2100 },
      { name: 'local-context', tokens: 4312 },
    ],
    items: [
      {
        id: snippetId,
        kind: 'snippet',
        fidelity: 'full',
        tokens: 512,
        source: 'default',
      },
    ],
  },
  startedAt: '2026-07-06T14:01:58Z',
} as const

const resultLine = {
  type: 'result',
  status: 'ok',
  usageTotal: { promptTokens: 6412, completionTokens: 388 },
  artifacts: [{ kind: 'snippet', snippetId, rev: 1, state: 'committed' }],
  endedAt: '2026-07-06T14:02:11Z',
} as const

describe('RunEvent', () => {
  it('round-trips the §5.4 meta line', () => {
    expect(RunEvent.parse(metaLine)).toEqual(metaLine)
  })

  it('parses message and output lines', () => {
    const message = {
      type: 'message',
      role: 'user',
      text: '<world-info>...</world-info><local-context>...</local-context>',
    } as const
    expect(RunEvent.parse(message)).toEqual(message)
    const output = { type: 'output', text: 'Mara pressed her palm...' } as const
    expect(RunEvent.parse(output)).toEqual(output)
  })

  it('parses the §5.4 result line, defaulting partialText to null', () => {
    const parsed = RunEvent.parse(resultLine)
    expect(parsed).toEqual({ ...resultLine, partialText: null })
  })

  it('accepts a null contextSnapshot for background/illustration runs', () => {
    const parsed = RunEvent.parse({ ...metaLine, contextSnapshot: null })
    expect(parsed.type === 'meta' && parsed.contextSnapshot).toBeNull()
  })

  it('defaults usage.estimated to false', () => {
    const parsed = RunEvent.parse({
      type: 'usage',
      promptTokens: 100,
      completionTokens: 20,
      call: 'writing',
    })
    expect(parsed.type === 'usage' && parsed.estimated).toBe(false)
  })

  it('parses a crash-finalized error result (02 §10.7)', () => {
    const parsed = RunEvent.parse({
      ...resultLine,
      status: 'error',
      error: { code: 'crash', message: 'finalized at work open' },
      partialText: 'Mara pressed',
    })
    expect(parsed.type === 'result' && parsed.error?.code).toBe('crash')
  })

  it('rejects unknown event types and unknown task kinds', () => {
    expect(RunEvent.safeParse({ type: 'checkpoint', at: '2026-07-06T14:02:11Z' }).success).toBe(
      false,
    )
    expect(RunEvent.safeParse({ ...metaLine, kind: 'summarize' }).success).toBe(false)
    expect(RunEvent.safeParse({ ...metaLine, lane: 'medium' }).success).toBe(false)
  })
})

describe('RunArtifact', () => {
  it('covers the 9-kind enum and defaults state to committed', () => {
    const parsed = RunArtifact.parse({ kind: 'boundary' })
    expect(parsed.state).toBe('committed')
    for (const kind of [
      'snippet',
      'snippet-revision',
      'section-span',
      'section-title',
      'summary-short',
      'summary-long',
      'illustration',
      'world-image',
      'boundary',
    ]) {
      expect(RunArtifact.safeParse({ kind }).success).toBe(true)
    }
    expect(RunArtifact.safeParse({ kind: 'summary' }).success).toBe(false)
    expect(RunArtifact.safeParse({ kind: 'snippet', state: 'pending' }).success).toBe(false)
  })
})

describe('ContextSnapshot & RunSummary', () => {
  it('parses a snapshot standalone', () => {
    expect(ContextSnapshot.parse(metaLine.contextSnapshot)).toEqual(metaLine.contextSnapshot)
  })

  it('parses a run summary', () => {
    const summary = {
      runId,
      kind: 'continue',
      lane: 'high',
      model: 'glm-5',
      status: 'ok',
      startedAt: '2026-07-06T14:01:58Z',
      endedAt: '2026-07-06T14:02:11Z',
      usageTotal: { promptTokens: 6412, completionTokens: 388 },
    } as const
    expect(RunSummary.parse(summary)).toEqual(summary)
  })
})
