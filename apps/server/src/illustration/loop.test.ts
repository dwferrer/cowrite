import { beforeAll, describe, expect, it } from 'vitest'
import { loadTemplates, type TemplateSet } from '../prompt/templates/loader.js'
import type { IntentBrief } from './composer.js'
import { IllustrationAbortedError } from './ctx.js'
import { attemptEstimateMs, runIllustration, selectWinner } from './loop.js'
import { critiqueText, type FakeComfy, fakeWorkflow, imagePromptText, makeCtx } from './testkit.js'

let templates: TemplateSet
beforeAll(async () => {
  templates = await loadTemplates()
})

function brief(): IntentBrief {
  return {
    kind: 'section',
    title: 'The Storm Glass',
    targetText: 'Mara retrieves the storm glass.',
    worldEntries: [],
    establishedImagery: [],
    guidance: null,
    entities: [],
  }
}

/** Returns the next value each call, holding the last value once the list runs out. */
function queued(values: number[]): () => number {
  let i = 0
  return () => values[Math.min(i++, values.length - 1)] ?? 0
}

/** Pull the injected prompt out of a captured generate call's node 6. */
function injectedPrompt(comfy: FakeComfy, i: number): string {
  const node = comfy.generateCalls[i]?.workflow['6'] as { inputs?: { text?: string } } | undefined
  return node?.inputs?.text ?? ''
}

describe('attemptEstimateMs (§4.4 budget arithmetic)', () => {
  it('floors at 30 s with no completed attempts', () => {
    expect(attemptEstimateMs([])).toBe(30_000)
  })
  it('is 1.5× the slowest completed attempt above the floor', () => {
    expect(attemptEstimateMs([40_000, 25_000])).toBe(60_000)
    expect(attemptEstimateMs([10_000])).toBe(30_000) // 1.5×10k < floor
  })
})

describe('selectWinner (§4.5 best-of)', () => {
  it('picks the highest score, ties toward the latest attempt', () => {
    const c = (n: number, score: number) => ({
      n,
      prompt: '',
      seed: 0,
      score,
      crit: {} as never,
      png: Buffer.of(),
    })
    expect(selectWinner([c(1, 6), c(2, 8), c(3, 4)])?.n).toBe(2)
    expect(selectWinner([c(1, 7), c(2, 7)])?.n).toBe(2)
    expect(selectWinner([])).toBeNull()
  })
})

describe('runIllustration (§4.1)', () => {
  it('accept-first: one attempt, early accept, no revise', async () => {
    const h = makeCtx(templates)
    h.comfy.pngs = [Buffer.from('A')]
    h.lowClient.promptResponses = [imagePromptText('a lantern in fog')]
    h.lowClient.critiqueResponses = [critiqueText({ verdict: 'accept', overall: 8 })]

    const res = await runIllustration(brief(), fakeWorkflow(), h.ctx)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.attemptsRun).toBe(1)
      expect(res.winner.score).toBe(8)
      expect(res.winner.png.toString()).toBe('A')
    }
    expect(h.comfy.generateCalls).toHaveLength(1)
    // no revise prompt call — only the compose call
    expect(h.lowClient.promptResponses).toHaveLength(0)
    expect(h.progress.some((p) => p.phase === 'revising')).toBe(false)
  })

  it('revise-then-accept: the revised prompt drives the second generate', async () => {
    const h = makeCtx(templates)
    h.comfy.pngs = [Buffer.from('A'), Buffer.from('B')]
    h.lowClient.promptResponses = [
      imagePromptText('first prompt'),
      imagePromptText('revised prompt'),
    ]
    h.lowClient.critiqueResponses = [
      critiqueText({ verdict: 'revise', overall: 5, promptAdvice: 'add lighthouse' }),
      critiqueText({ verdict: 'accept', overall: 8 }),
    ]

    const res = await runIllustration(brief(), fakeWorkflow(), h.ctx)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.winner.score).toBe(8)
      expect(res.winner.n).toBe(2)
    }
    expect(injectedPrompt(h.comfy, 0)).toBe('first prompt')
    expect(injectedPrompt(h.comfy, 1)).toBe('revised prompt')
  })

  it('best-of-three: no accept, scores [6,8,4] → attempt 2 wins', async () => {
    const h = makeCtx(templates)
    h.comfy.pngs = [Buffer.from('A'), Buffer.from('B'), Buffer.from('C')]
    h.lowClient.promptResponses = [
      imagePromptText('p1'),
      imagePromptText('p2'),
      imagePromptText('p3'),
    ]
    h.lowClient.critiqueResponses = [
      critiqueText({ verdict: 'revise', overall: 6 }),
      critiqueText({ verdict: 'revise', overall: 8 }),
      critiqueText({ verdict: 'revise', overall: 4 }),
    ]

    const res = await runIllustration(brief(), fakeWorkflow(), h.ctx)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.attemptsRun).toBe(3)
      expect(res.winner.n).toBe(2)
      expect(res.winner.png.toString()).toBe('B')
    }
    expect(h.comfy.generateCalls).toHaveLength(3)
  })

  it('budget-exhausted mid-loop commits the best scored candidate so far', async () => {
    const h = makeCtx(templates, {
      // pre-compose gate + n=1 deadline see full budget; the n=2 gate sees too little to fit
      // another attempt (§4.4, §8 pre-compose budget check draws the first value).
      remainingMs: queued([600_000, 600_000, 50_000]),
    })
    h.comfy.pngs = [Buffer.from('A'), Buffer.from('B')]
    h.lowClient.promptResponses = [imagePromptText('p1'), imagePromptText('p2')]
    h.lowClient.critiqueResponses = [
      critiqueText({ verdict: 'revise', overall: 6 }),
      critiqueText({ verdict: 'revise', overall: 9 }),
    ]

    // attempt 1 takes 40 s → estimate 60 s > remaining 50 s → gate stops before attempt 2.
    const res = await runIllustration(brief(), fakeWorkflow(), h.ctx, {
      now: queued([0, 40_000]),
    })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.winner.n).toBe(1)
      expect(res.winner.png.toString()).toBe('A')
    }
    expect(h.comfy.generateCalls).toHaveLength(1)
  })

  it('all attempts fail to generate → pipeline error with the last detail', async () => {
    const h = makeCtx(templates)
    const err = Object.assign(new Error('OOM'), { name: 'ComfyExecError' })
    // Each of the 3 attempts retries an exec_error ONCE (§4.1): 3 attempts × 2 tries = 6 calls,
    // but only 3 consumed-slot attempt events.
    h.comfy.failWith = [err, err, err, err, err, err]
    h.lowClient.promptResponses = [imagePromptText('p1')]

    const res = await runIllustration(brief(), fakeWorkflow(), h.ctx)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.detail).toBe('comfy_exec_error')
    expect(h.comfy.generateCalls).toHaveLength(6)
    // a failed attempt (incl. its one retry) consumes the slot with no critique
    expect(h.events.filter((e) => e.type === 'attempt')).toHaveLength(3)
  })

  it('exec-error-then-ok: a single exec_error retries once with a fresh seed and succeeds', async () => {
    const h = makeCtx(templates)
    // try 0 fails (exec_error), try 1 (fresh seed) succeeds — one attempt, no slot consumed.
    h.comfy.failWith = [Object.assign(new Error('OOM'), { name: 'ComfyExecError' }), null]
    h.comfy.pngs = [Buffer.from('unused'), Buffer.from('A')]
    h.lowClient.promptResponses = [imagePromptText('the only prompt')]
    h.lowClient.critiqueResponses = [critiqueText({ verdict: 'accept', overall: 8 })]

    const res = await runIllustration(brief(), fakeWorkflow(), h.ctx, {
      randSeed: queued([111, 222, 333]),
    })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.attemptsRun).toBe(1)
      expect(res.winner.png.toString()).toBe('A')
      // the winner's recorded seed is the RETRY's seed (222), not the failed first try (111).
      expect(res.winner.seed).toBe(222)
    }
    expect(h.comfy.generateCalls).toHaveLength(2)
    // both tries carried the SAME prompt (no revise between them)
    expect(injectedPrompt(h.comfy, 0)).toBe('the only prompt')
    expect(injectedPrompt(h.comfy, 1)).toBe('the only prompt')
  })

  it('exec-error-consumes-slot: two exec_errors consume the slot; the prompt carries over unchanged', async () => {
    const h = makeCtx(templates)
    const err = Object.assign(new Error('x'), { name: 'ComfyExecError' })
    // attempt 1: try 0 + retry both fail → slot consumed. attempt 2: succeeds.
    h.comfy.failWith = [err, err, null]
    h.comfy.pngs = [Buffer.from('unused'), Buffer.from('unused'), Buffer.from('B')]
    h.lowClient.promptResponses = [imagePromptText('the only prompt')]
    h.lowClient.critiqueResponses = [critiqueText({ verdict: 'accept', overall: 8 })]

    const res = await runIllustration(brief(), fakeWorkflow(), h.ctx)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.attemptsRun).toBe(2)
    // attempt 2 (generate call index 2) used the SAME prompt the failed attempt 1 carried —
    // no revise happens on a consumed slot (§4.1).
    expect(injectedPrompt(h.comfy, 2)).toBe('the only prompt')
    // exactly one consumed-slot attempt event (attempt 1), plus attempt 2's scored event.
    const attemptEvents = h.events.filter((e) => e.type === 'attempt')
    expect(attemptEvents).toHaveLength(2)
  })

  it('workflow_invalid fails fast and records ComfyUI node errors (§2)', async () => {
    const h = makeCtx(templates)
    const err = Object.assign(new Error('bad graph'), {
      name: 'WorkflowInvalidError',
      nodeErrors: { '6': { errors: [{ message: 'text: value is not a string' }] } },
    })
    h.comfy.failWith = [err, err, err, err, err, err]
    h.lowClient.promptResponses = [imagePromptText('p1')]

    const res = await runIllustration(brief(), fakeWorkflow(), h.ctx)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.detail).toBe('workflow_invalid')
    // one submit only — no retry-once, no remaining attempts.
    expect(h.comfy.generateCalls).toHaveLength(1)
    // the opaque code is accompanied by the node-level reason for diagnosis
    const rejected = h.events.find(
      (e) => e.type === 'message' && e.text.includes('ComfyUI rejected the workflow'),
    )
    expect(rejected).toBeDefined()
    if (rejected?.type === 'message') expect(rejected.text).toContain('not a string')
  })

  it('a scored candidate survives a later downscale/critique failure (§7)', async () => {
    const err = new Error('sharp blew up')
    const failingImageOps = {
      downscalePng: (() => {
        let calls = 0
        return (png: Uint8Array) => {
          calls++
          return calls >= 2 ? Promise.reject(err) : Promise.resolve(png)
        }
      })(),
      transcodeToPng: (png: Uint8Array) => Promise.resolve(png),
    }
    const h = makeCtx(templates, { imageOps: failingImageOps })
    h.comfy.pngs = [Buffer.from('A'), Buffer.from('B')]
    h.lowClient.promptResponses = [imagePromptText('p1'), imagePromptText('p2')]
    // attempt 1 scores 6; attempt 2 generates but its downscale throws.
    h.lowClient.critiqueResponses = [critiqueText({ verdict: 'revise', overall: 6 })]

    const res = await runIllustration(brief(), fakeWorkflow(), h.ctx)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.winner.n).toBe(1)
      expect(res.winner.png.toString()).toBe('A')
    }
  })

  it('a stalled composer that ate the budget reports budget_exhausted, not comfy_exec_error (§8)', async () => {
    const h = makeCtx(templates, { remainingMs: () => 0 })
    h.lowClient.promptResponses = [imagePromptText('p1')]
    const res = await runIllustration(brief(), fakeWorkflow(), h.ctx)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.detail).toBe('budget_exhausted')
    // zero attempts ran — no fabricated comfy failure.
    expect(h.comfy.generateCalls).toHaveLength(0)
  })

  it('a compose (low-lane) failure surfaces as a pipeline detail, not the generic classifier (§8)', async () => {
    const h = makeCtx(templates)
    // no scripted prompt response → FakeLowClient throws inside compose.
    const res = await runIllustration(brief(), fakeWorkflow(), h.ctx)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.detail).toBe('compose_failed')
    expect(h.comfy.generateCalls).toHaveLength(0)
  })

  it('per-attempt seed/score run events are emitted (§10)', async () => {
    const h = makeCtx(templates)
    h.comfy.pngs = [Buffer.from('A')]
    h.lowClient.promptResponses = [imagePromptText('p1')]
    h.lowClient.critiqueResponses = [critiqueText({ verdict: 'accept', overall: 8 })]

    await runIllustration(brief(), fakeWorkflow(), h.ctx, { randSeed: queued([777]) })
    const attempt = h.events.find((e) => e.type === 'attempt')
    expect(attempt).toMatchObject({ type: 'attempt', n: 1, seed: 777, score: 8 })
  })

  it('user cancel drops candidates: the run throws and never returns a winner', async () => {
    const h = makeCtx(templates)
    // attempt 1 succeeds and scores; attempt 2 aborts mid-generate.
    h.comfy.failWith = [null, Object.assign(new Error('aborted'), { name: 'AbortError' })]
    h.comfy.pngs = [Buffer.from('A'), Buffer.from('B')]
    h.lowClient.promptResponses = [imagePromptText('p1'), imagePromptText('p2')]
    h.lowClient.critiqueResponses = [critiqueText({ verdict: 'revise', overall: 6 })]

    await expect(runIllustration(brief(), fakeWorkflow(), h.ctx)).rejects.toBeInstanceOf(
      IllustrationAbortedError,
    )
    expect(h.storage.puts).toHaveLength(0)
  })
})
