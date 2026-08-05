import { z } from 'zod'
import { Fidelity } from './context.js'
import { IsoTime, Ulid } from './ids.js'
import { Lane, TaskKind, TaskSpec } from './tasks.js'

/**
 * Run persistence schemas (docs/05-agents.md §7.1). One task = one run = one JSONL file at
 * runs/<YYYY-MM>/<runId>.jsonl, written through storage's append sink (02 §10.7).
 */

/** Produced by the engine at assembleInitialPrompt (06); null for background/illustration
 *  runs, which have no engine assembly. Feeds the provenance region view and usage rollups. */
export const ContextSnapshot = z.object({
  regions: z.array(z.object({ name: z.string(), tokens: z.number().int() })),
  items: z.array(
    z.object({
      id: Ulid,
      kind: z.enum(['section', 'snippet', 'world', 'situation', 'anchor']),
      fidelity: Fidelity,
      tokens: z.number().int(),
      source: z.enum(['default', 'tool', 'cite', 'user', 'target']),
    }),
  ),
})
export type ContextSnapshot = z.infer<typeof ContextSnapshot>

const UsageTotal = z.object({
  promptTokens: z.number().int(),
  completionTokens: z.number().int(),
  /** true when ANY component was a chars/4 estimate (failed streams included). */
  estimated: z.boolean().default(false),
})

export const RunArtifact = z.object({
  kind: z.enum([
    'snippet',
    'snippet-revision',
    'section-span',
    'section-title',
    'summary-short',
    'summary-long',
    'illustration',
    'world-image',
    'boundary',
  ]),
  snippetId: Ulid.optional(),
  sectionId: Ulid.optional(),
  entryId: Ulid.optional(),
  rev: z.number().int().optional(),
  state: z.enum(['committed', 'conflict', 'skipped']).default('committed'),
})
export type RunArtifact = z.infer<typeof RunArtifact>

export const RunEvent = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('meta'),
    runId: Ulid,
    kind: TaskKind,
    lane: Lane, // model lane — the cost-split index column
    model: z.string(),
    spec: TaskSpec,
    params: z.record(z.string(), z.unknown()),
    contextSnapshot: ContextSnapshot.nullable(),
    startedAt: IsoTime,
  }),
  z.object({
    type: z.literal('message'),
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    text: z.string(),
  }),
  z.object({
    type: z.literal('stage'),
    stage: z.enum(['planning', 'writing']),
    round: z.number().int(),
  }),
  z.object({
    type: z.literal('toolCall'),
    name: z.string(),
    input: z.unknown(),
    output: z.string(),
    durationMs: z.number(),
  }),
  z.object({
    type: z.literal('output'), // flushed ≥ every 2 s / 2 KB
    text: z.string(),
    // Which model-call attempt streamed this text (1-based, monotonic across the run).
    // Crash finalization and proposal reconstruction use ONLY the final attempt's output,
    // so abandoned/retried attempts never fuse into the committed or offered text.
    // Defaulted for pre-existing run files, which were all single-attempt joins.
    attempt: z.number().int().min(1).default(1),
  }),
  z.object({
    type: z.literal('attempt'),
    n: z.number().int(),
    reason: z.string(),
    // Illustration loop (08 §4.4): the seed this attempt fed ComfyUI (reproducibility) and,
    // on a critiqued attempt, its overall score. Absent on non-illustration retries.
    seed: z.number().int().optional(),
    score: z.number().optional(),
  }),
  z.object({
    type: z.literal('usage'),
    promptTokens: z.number().int(),
    completionTokens: z.number().int(),
    estimated: z.boolean().default(false),
    call: z.enum(['planning', 'writing', 'pipeline']),
  }),
  z.object({
    type: z.literal('proposal'), // appended by apply/discard
    resolution: z.enum(['applied', 'discarded']),
    at: IsoTime,
  }),
  z.object({
    type: z.literal('result'),
    status: z.enum(['ok', 'error', 'cancelled']),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
    usageTotal: UsageTotal,
    partialText: z.string().nullable().default(null),
    artifacts: z.array(RunArtifact),
    endedAt: IsoTime,
  }),
])
export type RunEvent = z.infer<typeof RunEvent>

/**
 * The writer-side shape: fields with schema defaults (`output.attempt`,
 * `usage.estimated`, `result.partialText`, `usageTotal.estimated`) stay optional.
 * `RunSink.append` validates with `RunEvent.parse`, so what lands on disk is always
 * the full output shape.
 */
export type RunEventInput = z.input<typeof RunEvent>

// List endpoints; no transcript.
export const RunSummary = z.object({
  runId: Ulid,
  kind: TaskKind,
  lane: Lane,
  model: z.string(),
  status: z.enum(['ok', 'error', 'cancelled']),
  startedAt: IsoTime,
  endedAt: IsoTime.nullable(),
  usageTotal: UsageTotal,
})
export type RunSummary = z.infer<typeof RunSummary>
