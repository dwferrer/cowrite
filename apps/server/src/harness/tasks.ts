import type {
  AppConfig,
  Lane,
  RunArtifact,
  Task,
  TaskKind,
  TaskSpec,
  WorkEventOf,
} from '@cowrite/shared'
import { TASK_KIND_LANE } from '@cowrite/shared'
import { AppError } from '../http/errors.js'
import type { ExpectedBlockSpec, ParsedBlock } from '../prompt/outputParser.js'
import type { WorkHandle } from '../storage/service.js'
import { SnippetNotFoundError } from '../storage/snippetStore.js'

/**
 * Task lifecycle + per-kind specs (docs/05-agents.md §2, §5): which blocks each Stage-3
 * interactive kind expects, what its streaming target is, and its commit function. The
 * runner is kind-agnostic (§ "one runner, many task kinds"); everything kind-specific
 * lives in the `TaskPlan` built here.
 *
 * Stage-3 scope (docs/10): `continue`, `instructed-continue`, `quick-edit` (one-snippet
 * target). Background/illustration kinds keep their queue-lane seams (queue.ts) but have
 * no handlers yet — submitting them answers 501 until Stage 4/5 fill the producers.
 */

export type InteractiveKind = 'continue' | 'instructed-continue' | 'quick-edit'
export type InteractiveSpec = Extract<TaskSpec, { kind: InteractiveKind }>

const STAGE3_KINDS: ReadonlySet<TaskKind> = new Set([
  'continue',
  'instructed-continue',
  'quick-edit',
])

export function isInteractiveSpec(spec: TaskSpec): spec is InteractiveSpec {
  return STAGE3_KINDS.has(spec.kind)
}

/** Model-lane routing: config override per kind, else the §2 table (interactive ⇒ high). */
export function modelLaneFor(config: AppConfig, kind: TaskKind): Lane {
  const override = config.routing[kind]
  if (override !== undefined) return override
  return TASK_KIND_LANE[kind] === 'interactive' ? 'high' : 'low'
}

/** The `task.started` target payload (03 §8.2). */
export type StartTarget = WorkEventOf<'task.started'>['target']

/** Everything the runner needs that differs per kind (docs/05 §5.3–§5.4). */
export interface TaskPlan {
  expectedBlocks: ExpectedBlockSpec[]
  /** `task.started` target descriptor. */
  target: StartTarget
  /** `task.delta`/`task.snapshot` target string: `"frontier"` or the target's ULID. */
  deltaTarget: string
  /** Keep-partial-as-draft is offered on failure (continue kinds only, §6.5). */
  offersPartial: boolean
  /** Continue kinds reserve their order key at task start (02 §ordering). */
  needsOrderKey: boolean
  /** Live target ids for `cancelByTarget` / `maybeConsolidate` guards (§5.6). */
  targetIds: string[]
  commit(args: {
    handle: WorkHandle
    blocks: ParsedBlock[]
    runId: string
    orderKey: string | null
  }): Promise<RunArtifact[]>
}

function requireBlock(blocks: ParsedBlock[], spec: ExpectedBlockSpec): ParsedBlock {
  const found = blocks.find(
    (b) =>
      b.tag === spec.tag &&
      Object.entries(spec.attrs ?? {}).every(([name, value]) => b.attrs[name] === value),
  )
  if (found === undefined) {
    // parseTaskOutput guarantees mandatory blocks exist on the ok path; this is a bug trap.
    throw new AppError('internal', `commit reached without the mandatory <${spec.tag}> block`)
  }
  return found
}

export function planFor(spec: InteractiveSpec): TaskPlan {
  if (spec.kind === 'continue' || spec.kind === 'instructed-continue') {
    const expected: ExpectedBlockSpec = { tag: 'snippet', attrs: { id: 'new' } }
    return {
      expectedBlocks: [expected],
      target: { kind: 'frontier' },
      deltaTarget: 'frontier',
      offersPartial: true,
      needsOrderKey: true,
      targetIds: [],
      commit: async ({ handle, blocks, runId, orderKey }) => {
        const block = requireBlock(blocks, expected)
        const meta = await handle.appendSnippet(block.content, {
          author: 'agent',
          runId,
          ...(orderKey === null ? {} : { orderKey }),
        })
        return [{ kind: 'snippet', snippetId: meta.id, rev: meta.rev, state: 'committed' }]
      },
    }
  }

  // quick-edit — M1 targets exactly one snippet (docs/05 §2, 06 §9.1).
  const target = spec.target
  if (target.type !== 'snippet') {
    throw new AppError('validation', 'quick-edit targets one snippet in M1; section spans are M2')
  }
  const snippetId = target.snippetId
  const expected: ExpectedBlockSpec = { tag: 'snippet', attrs: { id: snippetId } }
  return {
    expectedBlocks: [expected],
    target: { kind: 'snippet', id: snippetId },
    deltaTarget: snippetId,
    offersPartial: false,
    needsOrderKey: false,
    targetIds: [snippetId],
    commit: async ({ handle, blocks, runId }) => {
      const block = requireBlock(blocks, expected)
      try {
        const res = await handle.reviseSnippet(snippetId, block.content, {
          author: 'agent',
          runId,
          baseRev: target.baseRev,
        })
        if (res.ok) {
          return [{ kind: 'snippet-revision', snippetId, rev: res.rev, state: 'committed' }]
        }
      } catch (err) {
        // The target vanished under the run (deleted / consolidated away) — the §5.6
        // guard degrades this to a conflict proposal, never a hard failure.
        if (!(err instanceof SnippetNotFoundError)) throw err
      }
      return [{ kind: 'snippet-revision', snippetId, state: 'conflict' }]
    },
  }
}

/**
 * POST-time validation (docs/05 §2: the quick-edit selection rule; 03 §3.7 `400
 * validation`). The selection must lie entirely within the one target snippet.
 */
export async function validateInteractiveSpec(
  handle: WorkHandle,
  spec: InteractiveSpec,
): Promise<void> {
  if (spec.kind !== 'quick-edit') return
  if (spec.target.type !== 'snippet') {
    throw new AppError(
      'validation',
      'quick-edit selections must lie within one snippet in M1 — use edit-task (M2) for spans',
    )
  }
  const snippet = await handle.getSnippet(spec.target.snippetId) // NotFound → 404
  const { start, end } = spec.selection
  if (start < 0 || end < start || end > snippet.text.length) {
    throw new AppError(
      'validation',
      `quick-edit selection ${start}..${end} is outside the target snippet (0..${snippet.text.length})`,
    )
  }
}

/** A fresh queued `Task` envelope (05 §2.1); taskId == runId once started. */
export function buildTask(id: string, workId: string, spec: TaskSpec, queuedAt: string): Task {
  return {
    id,
    workId,
    spec,
    lane: TASK_KIND_LANE[spec.kind],
    status: 'queued',
    queuedAt,
    startedAt: null,
    endedAt: null,
    error: null,
    partialText: null,
    unresolvedProposal: null,
  }
}
