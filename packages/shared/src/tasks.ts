import { z } from 'zod'
import { Fidelity } from './context.js'
import { Hash, IsoTime, Ulid } from './ids.js'
import type { TaskKind } from './task-kind.js'

/**
 * Task primitives (docs/02-data-model.md §2.7, docs/05-agents.md §2.1, §6.1, §9).
 *
 * OWNER: 05-agents.md (the harness, Stage 3). The wire shapes are the spec's verbatim; the
 * route registry (api.ts) and the SSE union (events.ts) reference them. Handler semantics
 * (selection-rule validation, lane scheduling, commits) live in the harness, not here.
 */

// Defined in the task-kind.ts leaf module (see its header for the cycle rationale);
// re-exported here because tasks.ts is its public home (05 §10).
export { TaskKind } from './task-kind.js'

/** Model lane — the cost split the usage panel needs (02 §7.1). */
export const Lane = z.enum(['high', 'low'])
export type Lane = z.infer<typeof Lane>

/** A contiguous character span inside a frozen section, valid against baseContentHash's text.
 *  The harness expands a user selection to enclosing paragraph boundaries before building this. */
export const SectionSpan = z.object({
  sectionId: Ulid,
  startChar: z.number().int().nonnegative(),
  endChar: z.number().int().nonnegative(), // exclusive
  baseContentHash: Hash, // section content.md hash at selection time
})
export type SectionSpan = z.infer<typeof SectionSpan>

export const EditTarget = z.discriminatedUnion('type', [
  z.object({ type: z.literal('snippet'), snippetId: Ulid, baseRev: z.number().int().positive() }),
  z.object({ type: z.literal('sectionSpan'), span: SectionSpan }), // commits ship M2
])
export type EditTarget = z.infer<typeof EditTarget>

export const ContextSelection = z.object({
  id: Ulid,
  kind: z.enum(['section', 'snippet', 'world']), // bare ULIDs + explicit kind, no id prefixes
  fidelity: Fidelity, // validated against engine candidates (06)
})
export type ContextSelection = z.infer<typeof ContextSelection>

export const TaskSpec = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('continue') }),
  z.object({
    kind: z.literal('instructed-continue'),
    instruction: z.string().min(1).max(4000),
  }),
  z.object({
    kind: z.literal('quick-edit'),
    instruction: z.string().min(1).max(500),
    target: EditTarget,
    /** exact selected text + char offsets within the target, for the prompt's selection marker */
    selection: z.object({
      text: z.string(),
      start: z.number().int(),
      end: z.number().int(),
    }),
  }),
  z.object({
    kind: z.literal('edit-task'), // M2
    instruction: z.string().min(1).max(20_000),
    targets: z.array(EditTarget).min(1).max(12),
    pinnedWorldEntryIds: z.array(Ulid).max(20).default([]),
    contextSelections: z.array(ContextSelection).default([]),
  }),
  z.object({ kind: z.literal('enrich-section'), sectionId: Ulid }),
  z.object({
    kind: z.literal('propose-boundaries'), // internal-only kind (03 §3.8)
    eligibleSnippetIds: z.array(Ulid).min(1),
  }),
  z.object({
    kind: z.literal('illustrate-section'),
    sectionId: Ulid,
    guidance: z.string().max(500).optional(), // regenerate-with-guidance (08)
  }),
  z.object({
    kind: z.literal('world-image'),
    entryId: Ulid,
    guidance: z.string().max(500).optional(),
  }),
])
export type TaskSpec = z.infer<typeof TaskSpec>

export const TaskStatus = z.enum(['queued', 'running', 'done', 'error', 'cancelled'])
export type TaskStatus = z.infer<typeof TaskStatus>

/** Queue lane (scheduling) — distinct from the model Lane (cost split). */
export const QueueLane = z.enum(['interactive', 'background', 'illustration'])
export type QueueLane = z.infer<typeof QueueLane>

/** Which queue lane each kind runs on (05 §2 table / §6.1) — the scheduler's routing table. */
export const TASK_KIND_LANE = {
  continue: 'interactive',
  'instructed-continue': 'interactive',
  'quick-edit': 'interactive',
  'edit-task': 'interactive',
  'enrich-section': 'background',
  'propose-boundaries': 'background',
  'illustrate-section': 'illustration',
  'world-image': 'illustration',
} as const satisfies Record<TaskKind, QueueLane>

/**
 * Fixed lane capacities (05 §6.1) — policy, not config: `interactive: 1` is precisely what
 * makes the `409 busy` contract true (no queueing of writing tasks), so these are constants
 * rather than `HarnessKnobs` fields. `interactive`/`background` are per work; `illustration`
 * is one app-wide queue (ComfyUI is one box).
 */
export const QUEUE_LANE_CAPACITY = {
  interactive: 1,
  background: 2,
  illustration: 1,
} as const satisfies Record<QueueLane, number>

export const Task = z.object({
  id: Ulid, // taskId == runId once started (1 task : 1 run)
  workId: Ulid,
  spec: TaskSpec,
  lane: QueueLane,
  status: TaskStatus,
  queuedAt: IsoTime,
  startedAt: IsoTime.nullable(),
  endedAt: IsoTime.nullable(),
  // `code` is an ErrorCode spelling at runtime (05 §11: one taxonomy with task.failed), but
  // the doc types it z.string() — importing api.ts's enum here would cycle (api → tasks).
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  /** Cleaned partial prose from an unfinished run (terminal tasks only; display + re-offer). */
  partialText: z.string().nullable().default(null),
  /** Set while the run's keep-partial/conflict proposal awaits apply/discard (05 §6.5). */
  unresolvedProposal: z
    .object({ kind: z.enum(['keep-partial', 'conflict']) })
    .nullable()
    .default(null),
})
export type Task = z.infer<typeof Task>

/**
 * POST /works/:w/tasks wire pair (03 §3.7): the spec IS the create request; the response is
 * the queued `Task` envelope (`202`). Identity aliases, not copies — the registry and the
 * Fastify routes must stay identity-equal to these. Cancel (POST …/tasks/:t/cancel, `202`,
 * idempotent) reuses `Task` as its response; it has no request body.
 */
export const TaskCreateReq = TaskSpec
export type TaskCreateReq = TaskSpec
export const TaskCreateRes = Task
export type TaskCreateRes = Task

// POST /tasks/estimate response (05 §9; the route itself is M2 and deliberately unregistered).
export const TaskEstimate = z.object({
  promptTokens: z.number().int(), // engine preview total
  perRegion: z.record(z.string(), z.number().int()),
  maxCompletionTokens: z.number().int(), // Σ target sizes + headroom
  overSoft: z.boolean(),
  overHard: z.boolean(),
  costUsd: z.number().nullable(), // null when prices unconfigured
})
export type TaskEstimate = z.infer<typeof TaskEstimate>

// HarnessKnobs (05 §6.4) moved to config.ts — 05 §15 places it there as the `config.harness`
// fragment, next to the BudgetKnobs overrides it sits beside in AppConfig.
