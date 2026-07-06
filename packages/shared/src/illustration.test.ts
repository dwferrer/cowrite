import { describe, expect, it } from 'vitest'
import { IllustrationMeta } from './illustration.js'

const agentMeta = {
  source: 'agent',
  runId: '01J2P7Q4V2M8Z6T1RD5FCW9XKB',
  generatedAt: '2026-07-05T22:20:00Z',
  sourceHash: 'xxh64:0123456789abcdef',
  sourceWordCount: 4100,
  entities: ['01J2N8W2KQ7F3AKQY9C4MHT6VP'],
  prompt: 'A lighthouse keeper braces against a rising storm, oil painting',
  workflow: 'default',
  workflowHash: 'xxh64:fedcba9876543210',
  seed: 42,
  attempts: 2,
  score: 8.5,
  guidance: 'moodier sky',
} as const

describe('IllustrationMeta', () => {
  it('round-trips an agent-generated meta', () => {
    expect(IllustrationMeta.parse(agentMeta)).toEqual(agentMeta)
  })

  it('accepts a user upload (all pipeline fields null) and defaults entities to []', () => {
    const parsed = IllustrationMeta.parse({
      source: 'user',
      runId: null,
      generatedAt: '2026-07-06T09:00:00Z',
      sourceHash: null,
      sourceWordCount: null,
      prompt: null,
      workflow: null,
      workflowHash: null,
      seed: null,
      attempts: null,
      score: null,
      guidance: null,
    })
    expect(parsed.entities).toEqual([])
    expect(parsed.runId).toBeNull()
  })

  it('rejects out-of-range score, zero attempts, negative word count', () => {
    expect(IllustrationMeta.safeParse({ ...agentMeta, score: 10.5 }).success).toBe(false)
    expect(IllustrationMeta.safeParse({ ...agentMeta, score: -1 }).success).toBe(false)
    expect(IllustrationMeta.safeParse({ ...agentMeta, attempts: 0 }).success).toBe(false)
    expect(IllustrationMeta.safeParse({ ...agentMeta, sourceWordCount: -5 }).success).toBe(false)
  })
})
