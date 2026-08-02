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

// ---------------------------------------------------------------------------
// API DTOs (docs/03-api.md §3.2, docs/04-frontend.md §4.5). This export owns the name
// `SectionRow`; the SQLite index's internal SectionRow (apps/server index/db.ts) is a
// different, server-private shape.
// ---------------------------------------------------------------------------

export const SectionRow = z.object({
  id: Ulid,
  parentId: Ulid.nullable(), // flat array, document order; client builds the tree
  kind: z.string(),
  orderKey: OrderKey,
  title: z.string().nullable(),
  titleSource: z.enum(['user', 'agent']),
  isLeaf: z.boolean(),
  wordCount: z.number().int(),
  contentHash: Hash.nullable(), // null for interior sections
  shortSummary: z.string().nullable(), // inlined: small, needed for fold rendering
  longSummary: z.string().nullable(), // inlined at/above chapter level; null below — GET …/summaries
  illustration: z
    .object({
      version: z.string(), // PNG content hash — regenerations always bump it
      width: z.number().int(),
      height: z.number().int(), // reserved aspect-ratio boxes (04 §5.5, §10)
    })
    .nullable(), // null = none (incl. user-suppressed; no badge shown)
  stale: z.object({
    short: z.boolean(),
    long: z.boolean(),
    illustration: z.boolean(),
  }),
})
export type SectionRow = z.infer<typeof SectionRow>

/** GET /sections/:s/content response — leaf prose, lazy-fetched at fold `full`. */
export const SectionContent = z.object({
  markdown: z.string(),
  contentHash: Hash,
})
export type SectionContent = z.infer<typeof SectionContent>

/** PATCH /sections/:s/content body; 409 conflict when baseHash is stale. */
export const SectionContentPatch = z.object({
  markdown: z.string(),
  baseHash: Hash,
})
export type SectionContentPatch = z.infer<typeof SectionContentPatch>

/** PATCH /sections/:s body — sets titleSource: "user". */
export const SectionTitlePatch = z.object({ title: z.string().min(1) })
export type SectionTitlePatch = z.infer<typeof SectionTitlePatch>

/** GET /sections/:s/summaries response — the lazy fetch for scene-level `long`. */
export const SectionSummaries = z.object({
  short: z.string().nullable(),
  long: z.string().nullable(),
})
export type SectionSummaries = z.infer<typeof SectionSummaries>

/** PUT /sections/:s/summaries body — user edit of enrichments (author: "user"). */
export const SummariesUpdate = z.object({
  short: z.string().optional(),
  long: z.string().optional(),
})
export type SummariesUpdate = z.infer<typeof SummariesUpdate>
