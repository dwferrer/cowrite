import type { IllustrationMeta, RunArtifact } from '@cowrite/shared'
import { wordCount } from '../storage/lib/hash.js'
import type { ResolvedWorkflow } from './comfy/registry.js'
import { buildIntentBrief, type IntentSource } from './composer.js'
import { IllustrationAbortedError, IllustrationError, type RunContext } from './ctx.js'
import { type Candidate, runIllustration } from './loop.js'

/** The 8-byte PNG signature — bytes already in this shape need no transcode (§10). */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_SIGNATURE.length) return false
  return PNG_SIGNATURE.every((b, i) => bytes[i] === b)
}

/** A commit throw is a vanished target ONLY when storage says the section/entry is gone —
 *  a disk/permission/validation error is a real pipeline failure, not "target missing" (§15). */
function isVanishedTarget(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false
  const { name, code } = err as { name?: unknown; code?: unknown }
  return (
    name === 'SectionNotFoundError' || name === 'WorldEntryNotFoundError' || code === 'not_found'
  )
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * The illustration pipeline entry points (docs/08-illustration.md §4, §9; the harness contract is
 * 05 §13). `runSectionIllustration` / `runWorldImage` assemble the intent from storage, resolve
 * the route workflow (a broken/dangling route → `config_missing`), gate on ComfyUI health, run the
 * agentic loop, and commit the winning PNG with its full `IllustrationMeta` through the
 * ctx-provided storage — returning `RunArtifact[]` for the harness's run `result`. The
 * message/output/usage/`vlm.critique` run events and the `task.progress` phases are emitted by the
 * composer, critic, and loop through the same `RunContext`, so the provenance view replays the
 * whole loop.
 */

/** The winning workflow + loop config resolution shared by both kinds. */
function resolveWorkflow(ctx: RunContext, kind: 'section' | 'world'): ResolvedWorkflow {
  const resolved = ctx.registry.resolve(kind)
  if ('configMissing' in resolved)
    throw new IllustrationError('config_missing', resolved.configMissing)
  return resolved
}

/** Lazy health gate (§2.4): an unreachable box fails the run before any model spend. */
async function assertComfyReachable(ctx: RunContext): Promise<void> {
  const health = await ctx.comfy.health()
  if (!health.ok) throw new IllustrationError('pipeline', 'comfy_unreachable')
}

export interface IllustrationPipelineOptions {
  /** Injectable clock for the `generatedAt` stamp (tests). */
  now?: () => Date
  /** Where commit/transcode causes are logged (§15) — injectable for tests. */
  warn?: (message: string) => void
}

export class IllustrationPipeline {
  private readonly now: () => Date
  private readonly warn: (message: string) => void

  constructor(opts: IllustrationPipelineOptions = {}) {
    this.now = opts.now ?? (() => new Date())
    this.warn = opts.warn ?? ((m) => console.warn(`[illustration] ${m}`))
  }

  /**
   * Final pre-commit guards shared by both kinds (§6, §15, §16): re-check the abort signal so
   * a cancel that raced the final critique DROPS the candidate (never commits), and normalize
   * the winning bytes to PNG (transcoding exotic WebP/JPEG save-node output; a transcode
   * failure fails the run). Returns the PNG bytes to commit.
   */
  private ensureLive(ctx: RunContext): void {
    // §6: an abort racing the winner selection / commit must drop candidates, never commit.
    if (ctx.signal.aborted) throw new IllustrationAbortedError()
  }

  private async guardAndNormalize(ctx: RunContext, winner: Candidate): Promise<Uint8Array> {
    this.ensureLive(ctx)
    if (isPng(winner.png)) return winner.png
    try {
      return await ctx.imageOps.transcodeToPng(winner.png)
    } catch (err) {
      this.warn(`transcode to PNG failed: ${errText(err)}`)
      throw new IllustrationError('pipeline', 'transcode_failed', { cause: err })
    }
  }

  /** Map a commit throw (§15): a vanished target is `commit_target_missing`; anything else is a
   *  genuine pipeline failure with the cause logged — never swallowed as "target missing". */
  private commitError(err: unknown): never {
    if (isVanishedTarget(err)) throw new IllustrationError('pipeline', 'commit_target_missing')
    this.warn(`illustration commit failed: ${errText(err)}`)
    throw new IllustrationError('pipeline', 'commit_failed', { cause: err })
  }

  /** `illustrate-section` (05 §13). Commits `illustration.png` + the slot meta; returns the artifact. */
  async runSectionIllustration(
    sectionId: string,
    guidance: string | undefined,
    ctx: RunContext,
  ): Promise<RunArtifact[]> {
    const workflow = resolveWorkflow(ctx, 'section')
    await assertComfyReachable(ctx)

    const row = ctx.storage.getSection(sectionId)
    if (row === null) throw new IllustrationError('pipeline', 'commit_target_missing')
    let content: string
    let contentHash: string
    try {
      ;({ text: content, contentHash } = await ctx.storage.getSectionContent(sectionId))
    } catch {
      throw new IllustrationError('pipeline', 'commit_target_missing')
    }
    const { long } = await ctx.storage.getSummaries(sectionId)

    const intent: IntentSource = {
      kind: 'section',
      title: row.title ?? '',
      longSummary: long,
      content,
    }
    const brief = await buildIntentBrief(ctx.storage, intent, guidance)
    const result = await runIllustration(brief, workflow, ctx)
    if (!result.ok) throw new IllustrationError('pipeline', result.detail)

    const { winner, attemptsRun } = result
    const png = await this.guardAndNormalize(ctx, winner)
    this.ensureLive(ctx) // §6: an abort during transcode still drops the candidate
    ctx.progress({
      phase: 'committing',
      attempt: attemptsRun,
      maxAttempts: ctx.loop.maxAttempts,
      pct: null,
    })
    const meta: IllustrationMeta = {
      source: 'agent',
      runId: ctx.runId,
      generatedAt: this.now().toISOString(),
      sourceHash: contentHash,
      sourceWordCount: wordCount(content),
      entities: brief.entities,
      prompt: winner.prompt,
      workflow: workflow.name,
      workflowHash: workflow.contentHash,
      seed: winner.seed,
      attempts: attemptsRun,
      score: winner.score,
      guidance: guidance ?? null,
    }
    try {
      await ctx.storage.putIllustration(sectionId, png, meta)
    } catch (err) {
      // A vanished section is commit_target_missing; a disk/permission error is a real
      // pipeline failure with the cause logged (§15).
      this.commitError(err)
    }
    return [{ kind: 'illustration', sectionId, state: 'committed' }]
  }

  /** `world-image` (05 §13). Commits `world/images/<entryId>.png` + its sidecar meta. */
  async runWorldImage(
    entryId: string,
    guidance: string | undefined,
    ctx: RunContext,
  ): Promise<RunArtifact[]> {
    const workflow = resolveWorkflow(ctx, 'world')
    await assertComfyReachable(ctx)

    let entry: { meta: { id: string; name: string }; body: string }
    try {
      entry = await ctx.storage.getWorldEntry(entryId)
    } catch {
      throw new IllustrationError('pipeline', 'commit_target_missing')
    }

    const intent: IntentSource = {
      kind: 'world',
      entryId,
      name: entry.meta.name,
      body: entry.body,
    }
    const brief = await buildIntentBrief(ctx.storage, intent, guidance)
    const result = await runIllustration(brief, workflow, ctx)
    if (!result.ok) throw new IllustrationError('pipeline', result.detail)

    const { winner, attemptsRun } = result
    const png = await this.guardAndNormalize(ctx, winner)
    this.ensureLive(ctx) // §6: an abort during transcode still drops the candidate
    ctx.progress({
      phase: 'committing',
      attempt: attemptsRun,
      maxAttempts: ctx.loop.maxAttempts,
      pct: null,
    })
    const meta: IllustrationMeta = {
      source: 'agent',
      runId: ctx.runId,
      generatedAt: this.now().toISOString(),
      sourceHash: null, // world images have no section content (§6)
      sourceWordCount: null,
      entities: brief.entities,
      prompt: winner.prompt,
      workflow: workflow.name,
      workflowHash: workflow.contentHash,
      seed: winner.seed,
      attempts: attemptsRun,
      score: winner.score,
      guidance: guidance ?? null,
    }
    try {
      await ctx.storage.putWorldImage(entryId, png, meta)
    } catch (err) {
      this.commitError(err)
    }
    return [{ kind: 'world-image', entryId, state: 'committed' }]
  }
}

export type { RunContext } from './ctx.js'
export { IllustrationError } from './ctx.js'
