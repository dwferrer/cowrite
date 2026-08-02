import { z } from 'zod'
import { Fidelity } from './context.js'
import { Hash, IsoTime, Ulid } from './ids.js'

/**
 * Task primitives (docs/02-data-model.md §2.7, docs/05-agents.md §2.1, §6.4, §9).
 *
 * OWNER: 05-agents.md (the harness, Stage 3). Stage 2 defines the wire shapes verbatim from
 * the spec so the route registry (api.ts) and the SSE union (events.ts) can reference them;
 * nothing executes tasks yet. Handler semantics land with the harness.
 */

export const TaskKind = z.enum([
  'continue',
  'instructed-continue',
  'quick-edit',
  'edit-task',
  'enrich-section',
  'propose-boundaries',
  'illustrate-section',
  'world-image',
])
export type TaskKind = z.infer<typeof TaskKind>

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

export const Task = z.object({
  id: Ulid, // taskId == runId once started (1 task : 1 run)
  workId: Ulid,
  spec: TaskSpec,
  lane: QueueLane,
  status: TaskStatus,
  queuedAt: IsoTime,
  startedAt: IsoTime.nullable(),
  endedAt: IsoTime.nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
})
export type Task = z.infer<typeof Task>

// POST /tasks/estimate response (05 §9; M2 — registered as a stub in Stage 2).
export const TaskEstimate = z.object({
  promptTokens: z.number().int(), // engine preview total
  perRegion: z.record(z.string(), z.number().int()),
  maxCompletionTokens: z.number().int(), // Σ target sizes + headroom
  overSoft: z.boolean(),
  overHard: z.boolean(),
  costUsd: z.number().nullable(), // null when prices unconfigured
})
export type TaskEstimate = z.infer<typeof TaskEstimate>

// ---------------------------------------------------------------------------
// Harness knobs (05 §6.4) — `config.harness`.
// OWNER: 05. Minimal placeholder until the harness lands; exactly the knobs the
// timeouts/retries table shows. AppConfig stores the sparse *overrides* shape below.
// ---------------------------------------------------------------------------

export const HarnessKnobs = z.object({
  connectTimeoutMs: z.number().int().positive().default(15_000),
  firstTokenTimeoutMs: z.number().int().positive().default(60_000),
  idleTokenTimeoutMs: z.number().int().positive().default(30_000),
  totalTimeoutMs: z
    .object({
      high: z.number().int().positive().default(300_000),
      low: z.number().int().positive().default(120_000),
    })
    .prefault({}),
  illustrationBudgetMs: z.number().int().positive().default(600_000),
  retry: z
    .object({
      maxAttempts: z.number().int().min(1).default(3),
      backoffMs: z.number().int().positive().default(1_000),
      backoffMaxMs: z.number().int().positive().default(4_000),
    })
    .prefault({}),
})
export type HarnessKnobs = z.infer<typeof HarnessKnobs>

// The doc spells the config field `HarnessKnobs.partial().default({})` (03 §9.2), but zod 4
// fires ZodDefault even under the ZodOptional that `.partial()` adds — a sparse override
// object would parse into a full knob set (see context.ts BudgetKnobsOverrides for the same
// gotcha). Hand-written optional shape keeps true Partial<HarnessKnobs> semantics.
export const HarnessKnobsOverrides = z.object({
  connectTimeoutMs: z.number().int().positive().optional(),
  firstTokenTimeoutMs: z.number().int().positive().optional(),
  idleTokenTimeoutMs: z.number().int().positive().optional(),
  totalTimeoutMs: z
    .object({
      high: z.number().int().positive().optional(),
      low: z.number().int().positive().optional(),
    })
    .optional(),
  illustrationBudgetMs: z.number().int().positive().optional(),
  retry: z
    .object({
      maxAttempts: z.number().int().min(1).optional(),
      backoffMs: z.number().int().positive().optional(),
      backoffMaxMs: z.number().int().positive().optional(),
    })
    .optional(),
})
export type HarnessKnobsOverrides = z.infer<typeof HarnessKnobsOverrides>
