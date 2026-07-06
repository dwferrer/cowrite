import { z } from 'zod'
import { EnrichmentMeta, IllustrationSlot } from './enrichment.js'
import { Hash, IsoTime, OrderKey, Ulid } from './ids.js'

/**
 * Section metadata and consolidation records (docs/02-data-model.md §10.3, §10.5).
 */

export const SectionMeta = z.object({
  schemaVersion: z.literal(1),
  id: Ulid,
  kind: z.string(), // must ∈ work.levelScheme (validated at load)
  orderKey: OrderKey,
  title: z.string().nullable(),
  titleSource: z.enum(['user', 'agent']).default('agent'),
  frozenAt: IsoTime.nullable(),
  contentHash: Hash.nullable(), // null for interior (non-leaf) sections
  enrichments: z.object({
    shortSummary: EnrichmentMeta.nullable(),
    longSummary: EnrichmentMeta.nullable(),
    illustration: IllustrationSlot,
  }),
})
export type SectionMeta = z.infer<typeof SectionMeta>

// sections/**/history.jsonl — one line per consumed snippet (02 §6.4)
export const ConsolidatedSnippet = z.object({
  type: z.literal('consolidated'),
  snippetId: Ulid,
  orderKey: OrderKey,
  authorship: z.enum(['user', 'agent', 'mixed']),
  originRunId: Ulid.nullable(),
  finalRev: z.number().int().positive(),
  finalText: z.string(),
  revisionRunIds: z.array(Ulid), // every agent run that ever touched it
  consolidatedAt: IsoTime,
  boundaryRunId: Ulid.nullable(), // null when a pure-heuristic break decided it
})
export type ConsolidatedSnippet = z.infer<typeof ConsolidatedSnippet>

// Result contract of the propose-boundaries task (handler in 05). Boundaries outside the
// eligible prefix are dropped at validation (02 §6.3); snippets after the last boundary stay live.
export const BoundaryProposal = z.object({
  boundaries: z.array(
    z.object({
      afterSnippetId: Ulid,
      kind: z.string(), // ∈ levelScheme
      title: z.string(),
    }),
  ),
})
export type BoundaryProposal = z.infer<typeof BoundaryProposal>
