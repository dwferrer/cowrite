import { z } from 'zod'
import { IsoTime, Ulid } from './ids.js'

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
