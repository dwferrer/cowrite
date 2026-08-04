import { z } from 'zod'
import { ErrorCode } from './api.js'
import { Hash, IsoTime, Ulid } from './ids.js'
import { IllustrationPhase } from './illustration.js'
import { RunArtifact } from './runs.js'
import { SectionRow } from './section.js'
import { SnippetDto } from './snippet.js'
import { QueueLane, Task } from './tasks.js'

/**
 * The canonical per-work SSE union (docs/03-api.md §8.2); 04/05/08 import it.
 *
 * Wire format is standard SSE: `id:` = the resume cursor `"<streamId>:<seq>"` (§8.3),
 * `event:` = the dot-case `type`, `data:` = JSON payload validated by `WorkEvent`.
 *
 * The full task.* family is present for Stage 3 even though nothing emits it yet — the union
 * is the contract, not the emitter. Domain events fire for EVERY mutation regardless of origin
 * (REST call, agent commit, reconciler adoption); payloads are sufficient to patch the client
 * cache without refetch, except the deliberate refetch signals (`sections.restructured`,
 * `world.changed` without `entryId`, `resync`).
 */

export const WorkEvent = z.discriminatedUnion('type', [
  // ---- domain mutations ----
  z.object({ type: z.literal('snippet.created'), snippet: SnippetDto }),
  z.object({ type: z.literal('snippet.revised'), snippet: SnippetDto }),
  z.object({ type: z.literal('snippet.deleted'), id: Ulid }),
  z.object({ type: z.literal('section.changed'), section: SectionRow }),
  z.object({ type: z.literal('sections.restructured') }), // reorder/split/merge ⇒ refetch tree
  z.object({
    type: z.literal('consolidation.applied'),
    sectionIds: z.array(Ulid),
    title: z.string(),
    undoToken: z.string(),
    /** ISO instant the undo grace window closes — the client's toast TTL derives
     *  from it (also re-offered as a synthetic attach frame mid-grace, 03 §8.3). */
    undoDeadline: IsoTime,
  }),
  z.object({ type: z.literal('consolidation.undone'), sectionIds: z.array(Ulid) }),
  /** The op left its grace window (expiry, superseded by a new apply, or work close):
   *  the client dismisses the matching undo toast. */
  z.object({ type: z.literal('consolidation.finalized'), opId: z.string() }),
  z.object({
    type: z.literal('enrichment.updated'),
    sectionId: Ulid,
    kind: z.enum(['title', 'short', 'long', 'illustration']),
    section: SectionRow, // fresh row inline
  }),
  z.object({ type: z.literal('world.changed'), entryId: Ulid.optional() }), // undefined ⇒ refetch list
  // `hash` is the fresh §6.6 concurrency token — the web compares it against its acked
  // hash to distinguish self-echoes from foreign edits without a refetch.
  z.object({
    type: z.literal('situation.changed'),
    text: z.string(),
    updatedAt: IsoTime,
    hash: Hash,
  }),
  z.object({ type: z.literal('readonly.changed'), readonly: z.boolean(), reason: z.string() }),

  // ---- task lifecycle (taskId on every event; runId == taskId) ----
  z.object({ type: z.literal('task.queued'), task: Task, position: z.number().int() }),
  z.object({
    type: z.literal('task.started'),
    task: Task,
    lane: QueueLane, // lifted for the reducer (04 §4.4 routes by lane)
    target: z.object({
      kind: z.enum(['frontier', 'snippet', 'section', 'entry']),
      id: Ulid.optional(),
    }),
  }),
  z.object({
    type: z.literal('task.stage'),
    taskId: Ulid,
    stage: z.enum(['planning', 'writing']),
  }),
  z.object({ type: z.literal('task.tool'), taskId: Ulid, name: z.string(), label: z.string() }),
  z.object({
    type: z.literal('task.delta'),
    taskId: Ulid,
    target: z.string(), // "frontier" or the target's ULID
    text: z.string(),
  }),
  z.object({
    type: z.literal('task.snapshot'), // synthetic on reconnect
    taskId: Ulid,
    target: z.string(),
    text: z.string(), // accumulated text so far
  }),
  z.object({
    type: z.literal('task.retrying'),
    taskId: Ulid,
    attempt: z.number().int(),
    reason: z.string(),
  }),
  z.object({
    type: z.literal('task.progress'), // illustration pipeline (08)
    taskId: Ulid,
    phase: IllustrationPhase, // 08's phase enum — one spelling

    attempt: z.number().int().min(1),
    maxAttempts: z.number().int().min(1),
    pct: z.number().min(0).max(100).nullable(), // ComfyUI progress; null outside `generating`
  }),
  z.object({ type: z.literal('task.artifact'), taskId: Ulid, artifact: RunArtifact }),
  z.object({
    type: z.literal('task.usage'),
    taskId: Ulid,
    promptTokens: z.number().int(),
    completionTokens: z.number().int(),
    /** true when any component was a chars/4 estimate — the UI shows "~" (05 §9). */
    estimated: z.boolean().default(false),
    costUsd: z.number().nullable(),
  }),
  z.object({ type: z.literal('task.completed'), taskId: Ulid }),
  z.object({
    type: z.literal('task.cancelled'),
    taskId: Ulid,
    partialText: z.string().nullable(),
  }),
  z.object({
    type: z.literal('task.failed'),
    taskId: Ulid,
    code: ErrorCode,
    message: z.string(),
    partialText: z.string().nullable(),
    retryable: z.boolean(),
  }),

  // Synthetic frame written on EVERY SSE attach (03 §8.3 hydration fencing): the current
  // interactive task (status/stage seed; accumulated text follows as `task.snapshot`), or —
  // when no live task exists — the latest terminal task still offering an unresolved
  // proposal, so a fresh EventSource hydrates purely from the stream (no pre-fetch gap).
  z.object({
    type: z.literal('task.state'),
    task: Task,
    lane: QueueLane,
    target: z.object({
      kind: z.enum(['frontier', 'snippet', 'section', 'entry']),
      id: Ulid.optional(),
    }),
  }),

  // One-time per-process spend warning (crossing config.harness.spendWarnUsd).
  z.object({
    type: z.literal('spend.warning'),
    spentUsd: z.number(),
    thresholdUsd: z.number(),
  }),

  // ---- stream control ----
  z.object({ type: z.literal('hello'), streamId: z.string(), seq: z.number().int() }),
  z.object({ type: z.literal('resync') }), // client must invalidate all work queries
])
export type WorkEvent = z.infer<typeof WorkEvent>

/** One event name from the union — what the 04 §4.3 reducer switches on. */
export type WorkEventType = WorkEvent['type']

/** The payload of one event name, for typed reducer cases: `WorkEventOf<'task.delta'>`. */
export type WorkEventOf<T extends WorkEventType> = Extract<WorkEvent, { type: T }>

/** The dot-case event-name vocabulary, derivable for tests and reducers. */
export const WORK_EVENT_TYPES = WorkEvent.options.map(
  (option) => option.shape.type.value,
) as WorkEventType[]
