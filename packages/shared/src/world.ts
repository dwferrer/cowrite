import { z } from 'zod'
import { Hash, IsoTime, Ulid } from './ids.js'

/**
 * World-entry frontmatter (docs/02-data-model.md §10.6).
 */

export const WorldEntryMeta = z.object({
  id: Ulid,
  name: z.string().min(1),
  keys: z.array(z.string().min(1)).default([]), // optional aliases; not prompt-gating (02 §2.6)
  image: z.string().nullable(), // work-relative path
  shortSummary: z.string().nullable(),
  createdBy: z.enum(['user', 'agent']),
  updatedAt: IsoTime,
})
export type WorldEntryMeta = z.infer<typeof WorldEntryMeta>

// ---------------------------------------------------------------------------
// API DTOs (docs/03-api.md §3.5). Entries are small: the list carries full `body`, so one
// fetch powers the panel, hovercards, and the client-side key matcher.
// ---------------------------------------------------------------------------

export const WorldEntryDto = z.object({
  id: Ulid,
  name: z.string(),
  keys: z.array(z.string()).default([]),
  body: z.string(),
  bodyHash: Hash, // xxh64 of `body` — the PATCH baseHash concurrency token (§3.5)
  shortSummary: z.string().nullable(),
  hasImage: z.boolean(),
  imageVersion: z.string().nullable(), // PNG content hash; the image URL's `?v=`
  updatedAt: IsoTime,
})
export type WorldEntryDto = z.infer<typeof WorldEntryDto>

/** POST /world body. */
export const WorldEntryCreate = z.object({
  name: z.string().min(1),
  keys: z.array(z.string().min(1)).optional(),
  body: z.string().optional(),
  shortSummary: z.string().optional(),
})
export type WorldEntryCreate = z.infer<typeof WorldEntryCreate>

/** PATCH /world/:e body — 409 on stale baseHash when body is being replaced. */
export const WorldEntryPatch = z.object({
  name: z.string().min(1).optional(),
  keys: z.array(z.string().min(1)).optional(),
  body: z.string().optional(),
  shortSummary: z.string().nullable().optional(),
  baseHash: Hash.optional(),
})
export type WorldEntryPatch = z.infer<typeof WorldEntryPatch>
