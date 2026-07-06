import { z } from 'zod'

/**
 * Task primitives (docs/02-data-model.md §2.7, docs/05-agents.md §2.1). Stage 1 exports only
 * what storage consumes: the closed kebab-case kind enum and the model-lane split. The full
 * TaskSpec / EditTarget / Task / QueueLane family is owned by 05 and lands with the harness.
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
