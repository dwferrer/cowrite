import { describe, expect, it } from 'vitest'
import {
  ComfyConfig,
  CritiqueResult,
  IllustrationHealthRes,
  IllustrationMeta,
  PipelinePhase,
} from './illustration.js'

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

describe('PipelinePhase', () => {
  it('locks the 08 §8 pipeline vocabulary (task.progress speaks it)', () => {
    expect(PipelinePhase.options).toEqual([
      'composing',
      'submitting',
      'queued',
      'generating',
      'critiquing',
      'revising',
      'committing',
    ])
  })
})

describe('CritiqueResult (08 §4.3)', () => {
  const sample = {
    verdict: 'revise',
    scores: { subject: 4, consistency: 3, craft: 5, mood: 2 },
    overall: 6.5,
    problems: ['the lighthouse is absent', 'sky reads midday, not dusk'],
    promptAdvice: 'add the lighthouse on the far headland; dim the sky to storm-dusk',
  } as const

  it('round-trips a sample critique', () => {
    expect(CritiqueResult.parse(sample)).toEqual(sample)
  })

  it('accepts the neutral repair fallback shape', () => {
    const parsed = CritiqueResult.parse({
      verdict: 'revise',
      scores: { subject: 2, consistency: 2, craft: 3, mood: 2 },
      overall: 5,
      problems: [],
      promptAdvice: '',
    })
    expect(parsed.verdict).toBe('revise')
  })

  it('rejects out-of-range axis scores', () => {
    expect(
      CritiqueResult.safeParse({ ...sample, scores: { ...sample.scores, subject: 6 } }).success,
    ).toBe(false)
    expect(
      CritiqueResult.safeParse({ ...sample, scores: { ...sample.scores, mood: -1 } }).success,
    ).toBe(false)
  })

  it('rejects out-of-range overall, >5 problems, overlong promptAdvice, bad verdict', () => {
    expect(CritiqueResult.safeParse({ ...sample, overall: 11 }).success).toBe(false)
    expect(
      CritiqueResult.safeParse({ ...sample, problems: ['a', 'b', 'c', 'd', 'e', 'f'] }).success,
    ).toBe(false)
    expect(CritiqueResult.safeParse({ ...sample, promptAdvice: 'x'.repeat(601) }).success).toBe(
      false,
    )
    expect(CritiqueResult.safeParse({ ...sample, verdict: 'accepted' }).success).toBe(false)
  })
})

describe('ComfyConfig (08 §3, embedded by AppConfig)', () => {
  it('a bare baseUrl parses with route/loop/timeout defaults', () => {
    const parsed = ComfyConfig.parse({ baseUrl: 'http://127.0.0.1:8188' })
    expect(parsed.route).toEqual({ section: 'default', world: 'default' })
    expect(parsed.loop).toEqual({ maxAttempts: 3, acceptScore: 7 })
    expect(parsed.timeouts).toEqual({
      healthTimeoutMs: 3_000,
      connectTimeoutMs: 5_000,
      queueTimeoutMs: 120_000,
      execTimeoutMs: 300_000,
      wsFallbackMs: 10_000,
    })
    expect(parsed.workflows).toEqual({})
    expect(parsed.workflowsDir).toBeUndefined() // resolved to <configDir>/workflows at load
  })

  it('workflow registry entries: kebab-case names, per-entry exec timeout override', () => {
    const parsed = ComfyConfig.parse({
      baseUrl: 'http://127.0.0.1:8188',
      workflows: {
        default: { file: 'default.json', label: 'Default (SDXL scene)' },
        hq: { file: 'hq.json', label: 'Hi-res 2-pass', execTimeoutMs: 600_000 },
      },
      route: { section: 'hq', world: 'default' },
    })
    expect(parsed.workflows.hq?.execTimeoutMs).toBe(600_000)
    expect(parsed.route.section).toBe('hq')
    expect(
      ComfyConfig.safeParse({
        baseUrl: 'http://127.0.0.1:8188',
        workflows: { 'Bad Name': { file: 'x.json', label: 'x' } },
      }).success,
    ).toBe(false)
    expect(
      ComfyConfig.safeParse({
        baseUrl: 'http://127.0.0.1:8188',
        loop: { maxAttempts: 7 },
      }).success,
    ).toBe(false)
  })
})

describe('IllustrationHealthRes', () => {
  it('parses the 08 §8 registry/reachability report', () => {
    const parsed = IllustrationHealthRes.parse({
      ok: false,
      comfy: { ok: true },
      workflows: [
        { name: 'default', label: 'Default (SDXL scene)', ok: true },
        { name: 'hq', label: 'Hi-res 2-pass', ok: false, error: 'no %seed% node' },
      ],
      route: {
        section: { name: 'hq', ok: false },
        world: { name: 'default', ok: true },
      },
    })
    expect(parsed.workflows[1]?.error).toBe('no %seed% node')
  })
})
