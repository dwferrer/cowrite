import { z } from 'zod'
import { IsoTime, OrderKey, Ulid } from './ids.js'

/**
 * Frontier snippet metadata and revision log (docs/02-data-model.md §10.4).
 */

export const SnippetMeta = z.object({
  id: Ulid,
  orderKey: OrderKey,
  createdAt: IsoTime,
  updatedAt: IsoTime,
  authorship: z.enum(['user', 'agent', 'mixed']),
  originRunId: Ulid.nullable(),
  rev: z.number().int().positive(),
})
export type SnippetMeta = z.infer<typeof SnippetMeta>

// frontier/revisions/<id>.jsonl — one line per accepted edit, FULL text each time
export const RevisionEvent = z.object({
  type: z.literal('revision'),
  rev: z.number().int().positive(),
  ts: IsoTime,
  author: z.enum(['user', 'agent']),
  runId: Ulid.optional(), // present iff author === "agent"
  text: z.string(), // snippets are small; diffs rejected
})
export type RevisionEvent = z.infer<typeof RevisionEvent>
