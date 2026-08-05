import { randomBytes } from 'node:crypto'
import type { CritiqueResult } from '@cowrite/shared'
import { inject } from './comfy/inject.js'
import type { ResolvedWorkflow } from './comfy/registry.js'
import { compose, type IntentBrief, revise } from './composer.js'
import { asRevise, CRITIC_MAX_EDGE, critique } from './critic.js'
import { type ComfyResult, IllustrationAbortedError, type RunContext } from './ctx.js'

/**
 * The agentic round loop (docs/08-illustration.md §4.1, §4.4, §4.5): compose once, then up to
 * `maxAttempts` budget-gated attempts — fresh seed, `comfy.generate`, critique, early accept —
 * committing the best-scored candidate. A failed generate consumes the slot (prompt carries over,
 * no critique/revise). Budget exhaustion or an all-failed run never discards a scored winner:
 * best-of selection returns whichever candidate scored highest (ties → the latest attempt), and
 * only an empty `scored` set fails the run. User cancel throws `IllustrationAbortedError` (discard
 * semantics — nothing commits). Commit itself is the pipeline entry point's job (index.ts).
 */

/** 10 s reserved on the final attempt to interrupt ComfyUI and still commit (§4.4). */
export const COMMIT_MARGIN_MS = 10_000
/** `attemptEstimateMs` floor: a slow box always gets at least this much runway (§4.4). */
export const ATTEMPT_ESTIMATE_FLOOR_MS = 30_000
/** `attemptEstimateMs` = 1.5 × the slowest completed attempt (§4.4). */
export const ATTEMPT_ESTIMATE_MULTIPLIER = 1.5

/** A successful, critiqued attempt held in memory for best-of selection (§4.5). */
export interface Candidate {
  n: number
  prompt: string
  seed: number
  score: number
  crit: CritiqueResult
  png: Buffer
}

export type LoopResult =
  | { ok: true; winner: Candidate; attemptsRun: number }
  /** Every attempt failed to generate: `code 'pipeline'` with the last ComfyUI detail (§4.1). */
  | { ok: false; detail: string }

export interface LoopOptions {
  /** Injectable clock (ms) for deterministic budget tests. */
  now?: () => number
  /** Injectable seed source for deterministic tests. */
  randSeed?: () => number
}

/** Uniform integer in `[0, 2^53)` from `crypto`, recorded per attempt (§2.2). */
export function randSeed(): number {
  const n = randomBytes(8).readBigUInt64BE()
  return Number(n & ((1n << 53n) - 1n))
}

/** The budget gate's per-attempt estimate: 1.5 × the slowest completed attempt, floored 30 s. */
export function attemptEstimateMs(durations: readonly number[]): number {
  if (durations.length === 0) return ATTEMPT_ESTIMATE_FLOOR_MS
  return Math.max(
    ATTEMPT_ESTIMATE_FLOOR_MS,
    Math.ceil(ATTEMPT_ESTIMATE_MULTIPLIER * Math.max(...durations)),
  )
}

/** The in-attempt retry-once applies ONLY to transient generate failures (§10): an
 *  `execution_error` (VRAM OOM etc.) or a `comfy_timeout`. A `workflow_invalid` (ComfyUI 400)
 *  is non-retryable and fails the whole run; any other transient consumes the slot without an
 *  inner retry. */
function isInAttemptRetryable(detail: string): boolean {
  return detail === 'comfy_exec_error' || detail === 'comfy_timeout'
}

/** Map a ComfyUI client failure to its §8 badge detail; unknown shapes read as `comfy_exec_error`. */
function comfyDetail(err: unknown): string {
  if (err !== null && typeof err === 'object') {
    const { name, code, detail } = err as { name?: unknown; code?: unknown; detail?: unknown }
    if (typeof detail === 'string') return detail
    if (typeof code === 'string') return code
    if (name === 'WorkflowInvalidError') return 'workflow_invalid'
    if (name === 'ComfyTimeoutError' || name === 'TimeoutError') return 'comfy_timeout'
    if (name === 'ComfyUnreachableError' || name === 'ComfyRequestError') return 'comfy_unreachable'
    if (name === 'ComfyExecError') return 'comfy_exec_error'
  }
  return 'comfy_exec_error'
}

/** True when the failure is a cancellation — the abort signal fired or the client threw an abort
 *  (`ComfyAborted` from comfy/client.ts, or a standard `AbortError`). */
function isAbort(err: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true
  const name = (err as { name?: unknown } | null)?.name
  return (
    name === 'AbortError' ||
    name === 'ComfyAborted' ||
    name === 'IllustrationAbortedError' ||
    name === 'Aborted'
  )
}

/** Best-of selection (§4.5): highest score, ties toward the latest attempt. */
export function selectWinner(scored: readonly Candidate[]): Candidate | null {
  if (scored.length === 0) return null
  return scored.reduce((best, c) =>
    c.score > best.score || (c.score === best.score && c.n >= best.n) ? c : best,
  )
}

export async function runIllustration(
  brief: IntentBrief,
  workflow: ResolvedWorkflow,
  ctx: RunContext,
  opts: LoopOptions = {},
): Promise<LoopResult> {
  const now = opts.now ?? (() => Date.now())
  const nextSeed = opts.randSeed ?? randSeed
  const { maxAttempts, acceptScore } = ctx.loop

  const throwIfAborted = (): void => {
    if (ctx.signal.aborted) throw new IllustrationAbortedError()
  }

  throwIfAborted()
  // Budget gate BEFORE compose (§8): a stalled composer must not burn the whole budget and
  // then fabricate a `comfy_exec_error` with zero attempts — report an honest budget detail.
  if (ctx.remainingMs() <= COMMIT_MARGIN_MS) return { ok: false, detail: 'budget_exhausted' }
  ctx.progress({ phase: 'composing', attempt: 1, maxAttempts, pct: null })
  let prompt: string
  try {
    prompt = await compose(ctx, brief)
  } catch (err) {
    if (isAbort(err, ctx.signal)) throw new IllustrationAbortedError()
    // §8: a low-lane failure surfaces as an honest pipeline detail, not the generic classifier.
    return { ok: false, detail: 'compose_failed' }
  }

  const scored: Candidate[] = []
  const durations: number[] = []
  let lastDetail = 'comfy_exec_error'
  let attemptsRun = 0

  for (let n = 1; n <= maxAttempts; n++) {
    throwIfAborted()
    // Budget gate (§4.4): after the first attempt, stop unless a whole attempt still fits.
    if (n > 1 && ctx.remainingMs() <= attemptEstimateMs(durations)) break
    // Cap the generate deadline so a stall still leaves the commit margin (§4.4).
    const deadlineMs = Math.min(workflow.execTimeoutMs, ctx.remainingMs() - COMMIT_MARGIN_MS)
    if (deadlineMs <= 0) break

    attemptsRun = n
    const attemptStart = now()

    // Generate with retry-once (§4.1, §10). A single transient failure (exec_error/timeout)
    // is retried ONCE within the same attempt with the SAME prompt and a FRESH seed; the
    // second failure consumes the slot (prompt carries over, no critique/revise). A
    // `workflow_invalid` (ComfyUI 400) is non-retryable — the identical graph is never
    // resubmitted; the whole run fails fast (§2). Any other transient consumes the slot
    // without an inner retry.
    let img: ComfyResult | undefined
    let usedSeed = 0
    let failDetail = 'comfy_exec_error'
    for (let tryN = 0; tryN < 2; tryN++) {
      const seed = nextSeed()
      usedSeed = seed
      ctx.progress({ phase: 'submitting', attempt: n, maxAttempts, pct: null })
      try {
        img = await ctx.comfy.generate({
          workflow: inject(workflow, { prompt, seed }),
          outputNodeId: workflow.injections.outputNodeId,
          deadlineMs,
          // The workflow's own exec deadline drives the client's internal exec timeout (§3),
          // so a slow hq graph isn't killed at the global 300 s.
          execTimeoutMs: workflow.execTimeoutMs,
          signal: ctx.signal,
          onProgress: (p) =>
            ctx.progress({
              phase: p.phase === 'queued' ? 'queued' : 'generating',
              attempt: n,
              maxAttempts,
              pct: p.pct,
            }),
        })
        break
      } catch (err) {
        if (isAbort(err, ctx.signal)) throw new IllustrationAbortedError()
        failDetail = comfyDetail(err)
        // Non-retryable (400): fail the run fast, never resubmit the identical graph (§2).
        if (failDetail === 'workflow_invalid') {
          // Record ComfyUI's per-node rejection reason — 'workflow_invalid' alone is opaque, and
          // this is the message that tells the user which node/field their workflow got wrong.
          const nodeErrors = (err as { nodeErrors?: unknown } | null)?.nodeErrors
          if (nodeErrors !== undefined) {
            ctx.emit({
              type: 'message',
              role: 'assistant',
              text: `ComfyUI rejected the workflow (400): ${JSON.stringify(nodeErrors).slice(0, 2000)}`,
            })
          }
          return { ok: false, detail: failDetail }
        }
        // Only exec_error / timeout get the in-attempt retry-once; others consume the slot.
        if (!isInAttemptRetryable(failDetail)) break
      }
    }

    if (img === undefined) {
      // A failed attempt (incl. its one retry) consumes the slot: no critique, no revise,
      // prompt carries over (§4.1). The seed of the last try is recorded (§10).
      lastDetail = failDetail
      ctx.emit({ type: 'attempt', n, reason: lastDetail, seed: usedSeed })
      continue
    }

    throwIfAborted()

    // A downscale/critique failure on this attempt must NOT discard an earlier scored
    // candidate (§7): wrap it and treat it as a failed attempt — best-of-so-far still
    // commits. `critique` never throws (neutral fallback), so this catches `downscalePng`.
    let crit: CritiqueResult
    try {
      ctx.progress({ phase: 'critiquing', attempt: n, maxAttempts, pct: null })
      const small = await ctx.imageOps.downscalePng(img.png, CRITIC_MAX_EDGE)
      crit = await critique(ctx, small, brief, prompt)
    } catch (err) {
      if (isAbort(err, ctx.signal)) throw new IllustrationAbortedError()
      lastDetail = 'critique_failed'
      ctx.emit({ type: 'attempt', n, reason: lastDetail, seed: usedSeed })
      durations.push(now() - attemptStart)
      continue
    }

    scored.push({ n, prompt, seed: usedSeed, score: crit.overall, crit, png: img.png })
    // Per-attempt seed + score (§10): reproducibility from the recorded seed, not just the
    // winner's. RunViewer replays these per attempt.
    ctx.emit({ type: 'attempt', n, reason: crit.verdict, seed: usedSeed, score: crit.overall })

    const accept = crit.verdict === 'accept' && crit.overall >= acceptScore
    if (!accept && n < maxAttempts) {
      ctx.progress({ phase: 'revising', attempt: n, maxAttempts, pct: null })
      try {
        prompt = await revise(ctx, brief, prompt, asRevise(crit))
      } catch (err) {
        if (isAbort(err, ctx.signal)) throw new IllustrationAbortedError()
        // §8: a reviser failure never discards the scored candidate — stop and commit best-of.
        durations.push(now() - attemptStart)
        break
      }
    }
    // Whole-attempt duration (generate + critique + optional revise) feeds the budget gate.
    durations.push(now() - attemptStart)
    if (accept) break
  }

  // An abort that raced the final critique / budget exit must DROP candidates — never commit
  // a winner past a user cancel (§6). Budget exhaustion (signal not aborted) still commits best.
  throwIfAborted()

  const winner = selectWinner(scored)
  if (winner === null) {
    // Zero attempts ran ⇒ the budget was gone before/at the first generate (a stalled
    // composer), not a comfy failure — report an honest budget detail (§8).
    return { ok: false, detail: attemptsRun === 0 ? 'budget_exhausted' : lastDetail }
  }
  return { ok: true, winner, attemptsRun }
}
