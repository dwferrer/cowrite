import { z } from 'zod'
import { Hash, IsoTime, Ulid } from './ids.js'

/**
 * Illustration metadata (docs/08-illustration.md §6). The present-state of the section
 * illustration slot (enrichment.ts) and the sidecar for world-entry images.
 */

export const IllustrationMeta = z.object({
  source: z.enum(['agent', 'user']),
  runId: Ulid.nullable(), // null iff source === "user" (uploads have no run)
  generatedAt: IsoTime,
  sourceHash: Hash.nullable(), // content.md hash at generation; null for world images & uploads
  // Word count at generation — makes the >15 % staleness rule recomputable from files alone
  // (02 §6.5); null for world images & uploads.
  sourceWordCount: z.number().int().nonnegative().nullable(),
  // Matched world-entry ids, recorded at compose time (08 §4.2); the established-imagery
  // lookup key (08 §7).
  entities: z.array(Ulid).default([]),
  prompt: z.string().nullable(), // the winning composed prompt; null for uploads
  workflow: z.string().nullable(), // registry name, e.g. "default"
  workflowHash: Hash.nullable(), // ResolvedWorkflow.contentHash at generation time
  seed: z.number().int().nullable(),
  attempts: z.number().int().min(1).nullable(), // rounds actually run
  score: z.number().min(0).max(10).nullable(), // winner's critique score
  guidance: z.string().nullable(),
})
export type IllustrationMeta = z.infer<typeof IllustrationMeta>
