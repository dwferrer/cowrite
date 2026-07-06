import { z } from 'zod'
import { Hash, IsoTime, Ulid } from './ids.js'
import { IllustrationMeta } from './illustration.js'

/**
 * Section enrichment metadata (docs/02-data-model.md §10.3): summaries/titles plus the
 * three-state illustration slot.
 */

// Summaries and titles. A user may edit summaries directly (03 §sections), so the run id is
// nullable and the source is recorded; staleness derives from sourceHash per 02 §6.5.
export const EnrichmentMeta = z.object({
  source: z.enum(['agent', 'user']).default('agent'),
  runId: Ulid.nullable(), // null iff source === "user"
  generatedAt: IsoTime,
  sourceHash: Hash, // hash of the content.md it was generated from
})
export type EnrichmentMeta = z.infer<typeof EnrichmentMeta>

// The illustration slot is a three-state union (IllustrationMeta itself is owned by 08).
export const IllustrationSlot = z.union([
  z.null(), // never had one / cleared
  IllustrationMeta, // present
  z.object({ suppressed: z.literal(true), deletedAt: IsoTime }), // user deleted; do not regenerate
])
export type IllustrationSlot = z.infer<typeof IllustrationSlot>
