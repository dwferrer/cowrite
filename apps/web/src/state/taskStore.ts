/**
 * Task display state (docs/04-frontend.md §4.4) — TYPES ONLY in Stage 2.
 *
 * One interactive slot (the server enforces one interactive task per work via 409 busy) plus
 * a background map keyed by taskId. Stage 3's SSE rows (`task.started` routed by `lane`,
 * every later `task.*` routed by taskId lookup) instantiate a store over these shapes; until
 * then nothing reads or writes them, so no store exists. A background `task.started`
 * mid-stream must never touch the interactive slot — the flagship continue stream is
 * isolated by construction.
 */

export type TaskTarget = {
  kind: 'frontier' | 'snippet' | 'section' | 'entry'
  id?: string
}

export interface InteractiveTask {
  taskId: string
  runId: string // == taskId (1 task : 1 run)
  kind: 'continue' | 'instructed-continue' | 'quick-edit' | 'edit-task'
  stage: 'planning' | 'writing'
  target: TaskTarget
  /** Per-`task.delta` target buffers; flushed to the DOM at ~30 Hz (04 §8.3). */
  buffers: Map<string, string>
  /** "opened Chapter 7", 'searched "storm glass"' — the planning activity line. */
  toolNotes: string[]
  startedAt: number
}

export interface BackgroundTask {
  kind: string
  target: TaskTarget
  // task.progress fields (illustration pipeline captions)
  phase?: string
  attempt?: number
  maxAttempts?: number
  pct?: number | null
}

export interface TaskState {
  interactive: InteractiveTask | null
  background: Map<string, BackgroundTask>
  reset(): void
}
