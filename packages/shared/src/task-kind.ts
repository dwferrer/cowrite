import { z } from 'zod'

/**
 * The closed, kebab-case task-kind enum (docs/05-agents.md §2; docs/03-api.md §6.3: "the
 * shared `TaskKind` enum is the only spelling anywhere").
 *
 * Its public home is tasks.ts (05 §10 module layout), which re-exports it. It lives in this
 * leaf module so context.ts can type `PreviewRequest.taskType` (06 §11) without a
 * tasks ⇄ context import cycle: tasks.ts eagerly consumes context's `Fidelity` at module
 * evaluation, so a direct back-import of tasks.ts from context.ts would hit the ESM
 * temporal dead zone in one evaluation order. Import from './tasks.js' everywhere else.
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
