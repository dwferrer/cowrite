import type { QueueLane, RunArtifact, Task, TaskSpec } from '@cowrite/shared'
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'

/**
 * Task display state (docs/04-frontend.md §4.4) — the real store, Stage 3.
 *
 * One interactive slot (the server enforces one interactive task per work via 409 busy) plus
 * a background map keyed by taskId. The SSE reducer (api/events.ts) routes `task.started` by
 * the event's `lane`; every later `task.*` event is routed by taskId lookup, so a background
 * `task.started` arriving mid-stream never touches the interactive slot — the flagship
 * continue stream is isolated by construction. Reset on work switch (useWorkEvents cleanup).
 */

export type TaskTarget = {
  kind: 'frontier' | 'snippet' | 'section' | 'entry'
  id?: string
}

export type InteractiveKind = 'continue' | 'instructed-continue' | 'quick-edit' | 'edit-task'

export interface InteractiveTask {
  taskId: string
  runId: string // == taskId (1 task : 1 run)
  kind: InteractiveKind
  stage: 'planning' | 'writing'
  target: TaskTarget
  /** The user's instruction, when the spec carries one — shown in the stream header (04 §8.2). */
  instruction: string | null
  /** Per-`task.delta` target buffers; flushed to the DOM at ~30 Hz (04 §8.3). */
  buffers: Map<string, string>
  /** "opened Chapter 7", 'searched "storm glass"' — the planning activity line. */
  toolNotes: string[]
  startedAt: number
  /** Non-null while the harness retries — the streaming block's "retrying…" line. */
  retrying: { attempt: number; reason: string } | null
  /** Live usage figures for the status line / provenance viewer. */
  usage: {
    promptTokens: number
    completionTokens: number
    estimated: boolean
    costUsd: number | null
  } | null
  /** A `task.artifact` arrived in `conflict` state — completion surfaces apply/discard (04 §8.4). */
  conflictArtifact: RunArtifact | null
}

export interface BackgroundTask {
  kind: string
  target: TaskTarget
  /** Set while queued (background lanes queue; interactive never does). */
  queuedPosition?: number
  // task.progress fields (illustration pipeline captions)
  phase?: string
  attempt?: number
  maxAttempts?: number
  pct?: number | null
}

/** A terminal `task.failed` recorded for an illustration target (08 §8, 04 §10) — survives
 *  past the background map's own deletion so the section/entry can render a failure badge
 *  with a retry action instead of quietly reverting to the placeholder. */
export interface IllustrationFailure {
  code: string
  message: string
  retryable: boolean
}

const ILLUSTRATION_KINDS = new Set(['illustrate-section', 'world-image'])

/** Map key for `illustrationFailures`: one entry per section/entry target. */
export function illustrationFailureKey(targetKind: 'section' | 'entry', id: string): string {
  return `${targetKind}:${id}`
}

/** A keep-partial / conflict offer pending user resolution via the proposal routes (04 §8.4). */
export interface ProposalOffer {
  taskId: string
  kind: string
  target: TaskTarget
  /** Partial text (failed/cancelled) or the buffered rewrite (conflict) — display only. */
  text: string
  reason: 'failed' | 'cancelled' | 'conflict'
  message: string | null
  retryable: boolean
}

/** Best-effort target for queued tasks (task.queued has no `target`; task.started does). */
export function specTarget(spec: TaskSpec): TaskTarget {
  switch (spec.kind) {
    case 'continue':
    case 'instructed-continue':
    case 'propose-boundaries':
      return { kind: 'frontier' }
    case 'quick-edit':
      return spec.target.type === 'snippet'
        ? { kind: 'snippet', id: spec.target.snippetId }
        : { kind: 'section', id: spec.target.span.sectionId }
    case 'edit-task': {
      const first = spec.targets[0]
      if (!first) return { kind: 'frontier' }
      return first.type === 'snippet'
        ? { kind: 'snippet', id: first.snippetId }
        : { kind: 'section', id: first.span.sectionId }
    }
    case 'enrich-section':
    case 'illustrate-section':
      return { kind: 'section', id: spec.sectionId }
    case 'world-image':
      return { kind: 'entry', id: spec.entryId }
  }
}

function specInstruction(spec: TaskSpec): string | null {
  return 'instruction' in spec ? spec.instruction : null
}

const MAX_TOOL_NOTES = 20

export interface TaskState {
  interactive: InteractiveTask | null
  background: Map<string, BackgroundTask>
  proposal: ProposalOffer | null
  /** Illustration target key (`illustrationFailureKey`) → its last `task.failed` (08 §8). */
  illustrationFailures: Map<string, IllustrationFailure>

  queued(task: Task, position: number): void
  started(task: Task, lane: QueueLane, target: TaskTarget): void
  setStage(taskId: string, stage: 'planning' | 'writing'): void
  addToolNote(taskId: string, label: string): void
  /** The rAF-batched flush path (api/events.ts owns the batching). */
  appendDeltas(taskId: string, entries: ReadonlyArray<{ target: string; text: string }>): void
  /** Reconnect catch-up: replace the target's buffer wholesale (04 §8.3). */
  snapshotBuffer(taskId: string, target: string, text: string): void
  retrying(taskId: string, attempt: number, reason: string): void
  setUsage(
    taskId: string,
    usage: {
      promptTokens: number
      completionTokens: number
      estimated: boolean
      costUsd: number | null
    },
  ): void
  /** Attach-frame hydration (03 §8.3): seed/clear the slot and any pending offer from a
   *  synthetic `task.state` event — the stream is the only hydration source. */
  stateFrame(task: Task, lane: QueueLane, target: TaskTarget): void
  progress(
    taskId: string,
    fields: { phase: string; attempt: number; maxAttempts: number; pct: number | null },
  ): void
  artifact(taskId: string, artifact: RunArtifact): void
  completed(taskId: string): void
  failed(
    taskId: string,
    error: { code: string; message: string; partialText: string | null; retryable: boolean },
  ): void
  cancelled(taskId: string, partialText: string | null): void
  clearProposal(): void
  /** Dismiss a recorded illustration failure without submitting a new task (badge close). */
  clearIllustrationFailure(key: string): void
  reset(): void
}

/** The rewrite buffer for a targeted task: the target-id buffer, else the sole buffer. */
function bufferedText(task: InteractiveTask): string {
  const byId = task.target.id !== undefined ? task.buffers.get(task.target.id) : undefined
  if (byId !== undefined) return byId
  const frontier = task.buffers.get('frontier')
  if (frontier !== undefined) return frontier
  const first = task.buffers.values().next()
  return first.done ? '' : first.value
}

/** Drop the target's recorded illustration failure — a fresh submit means "try again" (08 §8). */
function clearedIllustrationFailures(
  current: Map<string, IllustrationFailure>,
  target: TaskTarget,
): Map<string, IllustrationFailure> {
  if (target.id === undefined || (target.kind !== 'section' && target.kind !== 'entry')) {
    return current
  }
  const key = illustrationFailureKey(target.kind, target.id)
  if (!current.has(key)) return current
  const next = new Map(current)
  next.delete(key)
  return next
}

export const useTaskStore = create<TaskState>()((set, get) => ({
  interactive: null,
  background: new Map(),
  proposal: null,
  illustrationFailures: new Map(),

  queued: (task, position) => {
    if (task.lane === 'interactive') return // interactive never queues (409 busy instead)
    const target = specTarget(task.spec)
    const background = new Map(get().background)
    background.set(task.id, { kind: task.spec.kind, target, queuedPosition: position })
    set({
      background,
      illustrationFailures: clearedIllustrationFailures(get().illustrationFailures, target),
    })
  },

  started: (task, lane, target) => {
    if (lane === 'interactive') {
      set({
        interactive: {
          taskId: task.id,
          runId: task.id,
          kind: task.spec.kind as InteractiveKind,
          stage: 'planning',
          target,
          instruction: specInstruction(task.spec),
          buffers: new Map(),
          toolNotes: [],
          startedAt: Date.now(),
          retrying: null,
          usage: null,
          conflictArtifact: null,
        },
      })
      return
    }
    const background = new Map(get().background)
    background.set(task.id, { kind: task.spec.kind, target })
    set({
      background,
      illustrationFailures: clearedIllustrationFailures(get().illustrationFailures, target),
    })
  },

  setStage: (taskId, stage) => {
    const interactive = get().interactive
    if (interactive?.taskId !== taskId) return
    set({ interactive: { ...interactive, stage } })
  },

  addToolNote: (taskId, label) => {
    const interactive = get().interactive
    if (interactive?.taskId !== taskId) return
    const toolNotes = [...interactive.toolNotes, label].slice(-MAX_TOOL_NOTES)
    set({ interactive: { ...interactive, toolNotes } })
  },

  appendDeltas: (taskId, entries) => {
    const interactive = get().interactive
    if (interactive?.taskId !== taskId || entries.length === 0) return
    const buffers = new Map(interactive.buffers)
    for (const { target, text } of entries) {
      buffers.set(target, (buffers.get(target) ?? '') + text)
    }
    // Fresh streamed text means the replayed attempt is live again: the retrying badge
    // clears on the FIRST post-retry delta, not at the next terminal event (04 §8.3).
    set({ interactive: { ...interactive, buffers, retrying: null } })
  },

  snapshotBuffer: (taskId, target, text) => {
    const interactive = get().interactive
    if (interactive?.taskId !== taskId) return
    const buffers = new Map(interactive.buffers)
    buffers.set(target, text)
    // Replayed text means the composition already started: a client that reconnected
    // (or reloaded) after the `task.stage` flip must not sit on the planning line
    // hiding the very prose the snapshot just delivered (04 §8.3).
    const stage = text !== '' ? 'writing' : interactive.stage
    // A snapshot replaces the buffer wholesale — the stream is live: badge off too.
    set({ interactive: { ...interactive, buffers, stage, retrying: null } })
  },

  retrying: (taskId, attempt, reason) => {
    const interactive = get().interactive
    if (interactive?.taskId !== taskId) return
    // the attempt starts over — the target buffer resets (04 §4.3)
    set({ interactive: { ...interactive, buffers: new Map(), retrying: { attempt, reason } } })
  },

  setUsage: (taskId, usage) => {
    const interactive = get().interactive
    if (interactive?.taskId !== taskId) return
    set({ interactive: { ...interactive, usage } })
  },

  progress: (taskId, fields) => {
    const background = get().background
    const entry = background.get(taskId)
    if (!entry) return
    const next = new Map(background)
    next.set(taskId, { kind: entry.kind, target: entry.target, ...fields })
    set({ background: next })
  },

  artifact: (taskId, artifact) => {
    const interactive = get().interactive
    if (interactive?.taskId !== taskId || artifact.state !== 'conflict') return
    set({ interactive: { ...interactive, conflictArtifact: artifact } })
  },

  completed: (taskId) => {
    const { interactive, background } = get()
    if (interactive?.taskId === taskId) {
      if (interactive.conflictArtifact !== null) {
        // the run committed nothing for this target — offer apply-anyway/discard (04 §8.4)
        set({
          interactive: null,
          proposal: {
            taskId,
            kind: interactive.kind,
            target: interactive.target,
            text: bufferedText(interactive),
            reason: 'conflict',
            message: null,
            retryable: false,
          },
        })
        return
      }
      // the committed snippet arrived via its own domain event — keyed swap, clear the slot
      set({ interactive: null })
      return
    }
    if (background.has(taskId)) {
      const next = new Map(background)
      next.delete(taskId)
      set({ background: next })
    }
  },

  failed: (taskId, error) => {
    const { interactive, background } = get()
    if (interactive?.taskId === taskId) {
      set({
        interactive: null,
        proposal:
          error.partialText !== null
            ? {
                taskId,
                kind: interactive.kind,
                target: interactive.target,
                text: error.partialText,
                reason: 'failed',
                message: error.message,
                retryable: error.retryable,
              }
            : null,
      })
      return
    }
    // background failures stay quiet (badge/activity only, 04 §4.3) — EXCEPT the illustration
    // pipeline, whose target renders a small failure badge with a retry action (08 §8, 04 §10).
    const entry = background.get(taskId)
    if (entry !== undefined) {
      const next = new Map(background)
      next.delete(taskId)
      const illustrationFailures =
        ILLUSTRATION_KINDS.has(entry.kind) && entry.target.id !== undefined
          ? new Map(get().illustrationFailures).set(
              illustrationFailureKey(entry.target.kind as 'section' | 'entry', entry.target.id),
              { code: error.code, message: error.message, retryable: error.retryable },
            )
          : get().illustrationFailures
      set({ background: next, illustrationFailures })
    }
  },

  cancelled: (taskId, partialText) => {
    const { interactive, background } = get()
    if (interactive?.taskId === taskId) {
      set({
        interactive: null,
        proposal:
          partialText !== null
            ? {
                taskId,
                kind: interactive.kind,
                target: interactive.target,
                text: partialText,
                reason: 'cancelled',
                message: null,
                retryable: false,
              }
            : null,
      })
      return
    }
    if (background.has(taskId)) {
      const next = new Map(background)
      next.delete(taskId)
      set({ background: next })
    }
  },

  stateFrame: (task, lane, target) => {
    const { interactive, proposal } = get()
    const terminal =
      task.status === 'done' || task.status === 'error' || task.status === 'cancelled'

    if (!terminal) {
      // A live task: seed the slot if it is empty (or held a different task) — the
      // accumulated text arrives as the `task.snapshot` that follows the frame.
      if (lane === 'interactive') {
        if (interactive?.taskId !== task.id) get().started(task, lane, target)
      } else if (!get().background.has(task.id)) {
        // A live background/illustration task on SSE reconnect (§19): seed the background map so
        // a refreshed tab resumes the illustration caption; the `task.progress` frame that
        // follows fills in the phase/attempt/pct.
        get().started(task, lane, target)
      }
      return
    }

    // Terminal frame: a reload milliseconds before completion must not leave a ghost
    // streaming slot behind (03 §8.3).
    const next: Partial<Pick<TaskState, 'interactive' | 'proposal'>> = {}
    if (interactive?.taskId === task.id) next.interactive = null

    if (task.unresolvedProposal !== null) {
      // Re-offer the pending keep-partial/conflict resolution (05 §6.5) — across
      // reloads AND server restarts (the server reconstructs from the run file).
      if (proposal?.taskId !== task.id) {
        next.proposal = {
          taskId: task.id,
          kind: task.spec.kind,
          target,
          text: task.partialText ?? '',
          reason:
            task.unresolvedProposal.kind === 'conflict'
              ? 'conflict'
              : task.status === 'cancelled'
                ? 'cancelled'
                : 'failed',
          message: task.error?.message ?? null,
          retryable: false,
        }
      }
    } else if (proposal?.taskId === task.id) {
      next.proposal = null // resolved elsewhere — stop offering
    }
    if (Object.keys(next).length > 0) set(next)
  },

  clearProposal: () => set({ proposal: null }),

  clearIllustrationFailure: (key) => {
    const current = get().illustrationFailures
    if (!current.has(key)) return
    const next = new Map(current)
    next.delete(key)
    set({ illustrationFailures: next })
  },

  reset: () =>
    set({
      interactive: null,
      background: new Map(),
      proposal: null,
      illustrationFailures: new Map(),
    }),
}))

// ---------------------------------------------------------------------------
// Illustration selectors (08 §8, 04 §10): a section/entry's live pipeline progress and its
// last recorded failure, read by the shimmer overlay + failure badge (doc/blocks/
// IllustrationOverlay.tsx) so the image-slot components stay free of Map-scanning logic.
// ---------------------------------------------------------------------------

export interface IllustrationTaskView {
  taskId: string
  phase?: string
  attempt?: number
  maxAttempts?: number
  pct?: number | null
}

/** The live `illustrate-section` / `world-image` background task targeting this id, if any. */
export function findIllustrationTask(
  background: ReadonlyMap<string, BackgroundTask>,
  targetKind: 'section' | 'entry',
  id: string,
): IllustrationTaskView | null {
  for (const [taskId, task] of background) {
    if (
      ILLUSTRATION_KINDS.has(task.kind) &&
      task.target.kind === targetKind &&
      task.target.id === id
    ) {
      return {
        taskId,
        phase: task.phase,
        attempt: task.attempt,
        maxAttempts: task.maxAttempts,
        pct: task.pct,
      }
    }
  }
  return null
}

export function useIllustrationTask(
  targetKind: 'section' | 'entry',
  id: string,
): IllustrationTaskView | null {
  // `findIllustrationTask` builds a fresh object every call — shallow-compare it (not
  // Object.is) so an unrelated store update (e.g. a different task's progress) does not
  // re-render this target, and so the selector itself does not loop useSyncExternalStore.
  return useTaskStore(useShallow((s) => findIllustrationTask(s.background, targetKind, id)))
}

export function useIllustrationFailure(
  targetKind: 'section' | 'entry',
  id: string,
): IllustrationFailure | null {
  return useTaskStore(
    (s) => s.illustrationFailures.get(illustrationFailureKey(targetKind, id)) ?? null,
  )
}
