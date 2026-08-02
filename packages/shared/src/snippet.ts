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

// ---------------------------------------------------------------------------
// API DTOs (docs/03-api.md §3.3, docs/04-frontend.md §4.5).
// ---------------------------------------------------------------------------

export const SnippetDto = z.object({
  id: Ulid,
  orderKey: OrderKey,
  text: z.string(), // full text — frontier snippets are small
  rev: z.number().int(),
  authorship: z.enum(['user', 'agent', 'mixed']),
  originRunId: Ulid.nullable(),
  updatedAt: IsoTime,
  revisionCount: z.number().int(), // index column — enables "rev 3/3" without an extra fetch
})
export type SnippetDto = z.infer<typeof SnippetDto>

/** POST /snippets body — default append at frontier end; authorship: "user". */
export const SnippetCreate = z.object({
  text: z.string().min(1),
  afterSnippetId: Ulid.optional(), // rare mid-frontier insert
})
export type SnippetCreate = z.infer<typeof SnippetCreate>

/** PATCH /snippets/:s body — one call = one revision; 409 conflict on stale baseRev. */
export const SnippetPatch = z.object({
  text: z.string().min(1),
  baseRev: z.number().int().positive(),
})
export type SnippetPatch = z.infer<typeof SnippetPatch>

/** POST /snippets/:s/restore body — appends a NEW revision whose text is revision `rev`. */
export const RestoreReq = z.object({ rev: z.number().int().positive() })
export type RestoreReq = z.infer<typeof RestoreReq>

/** POST /editing body (03 §3.4) — null clears the signal (editor closed/cancelled). */
export const EditingSignal = z.object({ snippetId: Ulid.nullable() })
export type EditingSignal = z.infer<typeof EditingSignal>

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
