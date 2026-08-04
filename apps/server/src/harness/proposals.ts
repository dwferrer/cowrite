import fsp from 'node:fs/promises'
import path from 'node:path'
import type { ProposalApplyRes, RunEvent, TaskSpec } from '@cowrite/shared'
import { toSnippetDto } from '../events/adapter.js'
import { AppError } from '../http/errors.js'
import { parseTaskOutput } from '../prompt/outputParser.js'
import { runsDir } from '../storage/lib/paths.js'
import type { WorkHandle } from '../storage/service.js'
import { cleanPartialText } from './runner.js'
import { isInteractiveSpec, planFor } from './tasks.js'

/**
 * Keep-partial / conflict recovery (docs/05-agents.md §5.1, §6.5; 03 §3.7): the proposal
 * is reconstructed ON DEMAND from the run JSONL — durable, no TTL, survives restarts;
 * nothing here keeps an in-memory copy. Apply commits through the SAME storage paths as
 * a live run (`appendSnippet`/`reviseSnippet` with `author: "agent"` + originRunId), and
 * the resolution is appended to the run file so apply/discard is idempotent (second
 * apply → 409 conflict).
 */

export interface ReconstructedProposal {
  kind: 'keep-partial' | 'conflict'
  spec: TaskSpec
  /** The text a resolution would commit: partial prose, or the conflicted rewrite. */
  text: string
  /** The run's recorded start instant (locates the month shard for the marker append). */
  startedAt: string
  /** The run's terminal status/instant/error — feeds post-restart Task reconstruction. */
  status: 'ok' | 'error' | 'cancelled'
  endedAt: string
  error: { code: string; message: string } | null
  resolved: 'applied' | 'discarded' | null
  /** Present for conflict proposals: the snippet the rewrite targets. */
  targetSnippetId: string | null
}

const RUN_FILE_RE = /^([0-9A-HJKMNP-TV-Z]{26})\.jsonl$/
const MONTH_SHARD_RE = /^\d{4}-\d{2}$/

export interface RunFileRef {
  runId: string
  /** Absolute path of the run's JSONL file — the seam for boundary-line reads. */
  fileAbs: string
}

/** Every recorded run file for a work, oldest first (ULIDs sort chronologically). */
export async function listRunFiles(workDirPath: string): Promise<RunFileRef[]> {
  const root = runsDir(workDirPath)
  let shards: string[]
  try {
    const entries = await fsp.readdir(root, { withFileTypes: true })
    shards = entries
      .filter((e) => e.isDirectory() && MONTH_SHARD_RE.test(e.name))
      .map((e) => path.join(root, e.name))
      .sort()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const refs: RunFileRef[] = []
  for (const shard of shards) {
    for (const name of (await fsp.readdir(shard)).sort()) {
      const match = RUN_FILE_RE.exec(name)
      if (match?.[1] !== undefined) refs.push({ runId: match[1], fileAbs: path.join(shard, name) })
    }
  }
  return refs.sort((a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0))
}

/** Every recorded runId for a work, oldest first (ULIDs sort chronologically). */
export async function listRunIds(workDirPath: string): Promise<string[]> {
  return (await listRunFiles(workDirPath)).map((ref) => ref.runId)
}

/** Reconstruct the proposal a run offers, or null when the run offers none. */
export async function reconstructProposal(
  handle: WorkHandle,
  runId: string,
): Promise<ReconstructedProposal | null> {
  const events = await handle.readRun(runId) // RunNotFoundError → 404 at the route
  const meta = events.find((e): e is Extract<RunEvent, { type: 'meta' }> => e.type === 'meta')
  const result = events.find((e): e is Extract<RunEvent, { type: 'result' }> => e.type === 'result')
  if (meta === undefined || result === undefined) return null
  if (!isInteractiveSpec(meta.spec)) return null

  let resolved: 'applied' | 'discarded' | null = null
  for (const event of events) {
    if (event.type === 'proposal') resolved = event.resolution
  }
  // ONLY the final attempt's output (05 §6.5): retried/abandoned attempts recorded their
  // own tagged `output` events; joining across attempts would double the prose and let
  // first-block-wins resurrect a stale attempt's composition.
  const outputs = events.filter(
    (e): e is Extract<RunEvent, { type: 'output' }> => e.type === 'output',
  )
  const finalAttempt = outputs.reduce((max, e) => Math.max(max, e.attempt), 1)
  const outputText = outputs
    .filter((e) => e.attempt === finalAttempt)
    .map((e) => e.text)
    .join('')

  const outcome = {
    status: result.status,
    endedAt: result.endedAt,
    error: result.error ?? null,
  }

  if (meta.spec.kind === 'quick-edit') {
    // §5.6 conflict fallback: the run completed OK but the commit degraded to a proposal.
    if (result.status !== 'ok') return null
    const conflicted = result.artifacts.find((a) => a.state === 'conflict')
    if (conflicted === undefined) return null
    const plan = planFor(meta.spec)
    const parsed = parseTaskOutput(outputText, plan.expectedBlocks)
    const block = parsed.blocks[0]
    if (block === undefined) return null
    return {
      kind: 'conflict',
      spec: meta.spec,
      text: block.content,
      startedAt: meta.startedAt,
      ...outcome,
      resolved,
      targetSnippetId: conflicted.snippetId ?? null,
    }
  }

  // Continue kinds: keep-partial-as-draft after error/cancel/crash (§6.5, 03 §8.4).
  if (result.status === 'ok') return null
  // Live runs record cleaned prose; crash-finalized runs record raw streamed output —
  // clean either way (already-clean prose passes through the gate untouched).
  const plan = planFor(meta.spec)
  const text = cleanPartialText(
    result.partialText ?? outputText,
    new Set(plan.expectedBlocks.map((b) => b.tag)),
  )
  if (text === null) return null
  return {
    kind: 'keep-partial',
    spec: meta.spec,
    text,
    startedAt: meta.startedAt,
    ...outcome,
    resolved,
    targetSnippetId: null,
  }
}

async function appendResolution(
  handle: WorkHandle,
  runId: string,
  startedAt: string,
  resolution: 'applied' | 'discarded',
): Promise<void> {
  const sink = await handle.recordRun(runId, startedAt)
  await sink.append({ type: 'proposal', resolution, at: new Date().toISOString() })
}

function requireProposal(proposal: ReconstructedProposal | null): ReconstructedProposal {
  if (proposal === null) {
    throw new AppError('not_found', 'this run offers no proposal to apply or discard')
  }
  return proposal
}

/**
 * POST /works/:w/tasks/:t/proposal/apply — commit the reconstructed text with agent
 * provenance. Keep-partial appends a fresh frontier snippet (the original order-key
 * reservation was released with the failed run); conflict applies the rewrite as a
 * normal revision ON TOP of the current text (§5.6 "apply anyway").
 */
export async function applyProposal(handle: WorkHandle, runId: string): Promise<ProposalApplyRes> {
  const proposal = requireProposal(await reconstructProposal(handle, runId))
  if (proposal.resolved !== null) {
    throw new AppError('conflict', `this proposal was already ${proposal.resolved}`)
  }

  if (proposal.kind === 'keep-partial') {
    const meta = await handle.appendSnippet(proposal.text, { author: 'agent', runId })
    await appendResolution(handle, runId, proposal.startedAt, 'applied')
    return { snippet: toSnippetDto(await handle.getSnippet(meta.id)) }
  }

  const snippetId = proposal.targetSnippetId
  if (snippetId === null) throw new AppError('internal', 'conflict proposal lost its target id')
  const current = await handle.getSnippet(snippetId) // NotFound → 404 (target deleted since)
  const res = await handle.reviseSnippet(snippetId, proposal.text, {
    author: 'agent',
    runId,
    baseRev: current.rev,
  })
  if (!res.ok) {
    throw new AppError('conflict', 'the snippet changed again while applying the proposal', {
      currentRev: res.conflict.currentRev,
    })
  }
  await appendResolution(handle, runId, proposal.startedAt, 'applied')
  return { snippet: toSnippetDto(await handle.getSnippet(snippetId)) }
}

/** POST …/proposal/discard — durable marker only; idempotent (a re-discard is a no-op). */
export async function discardProposal(handle: WorkHandle, runId: string): Promise<void> {
  const proposal = requireProposal(await reconstructProposal(handle, runId))
  if (proposal.resolved !== null) return
  await appendResolution(handle, runId, proposal.startedAt, 'discarded')
}
