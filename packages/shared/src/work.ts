import { z } from 'zod'
import { BudgetKnobsOverrides } from './context.js'
import { IsoTime, Ulid } from './ids.js'

/**
 * Work metadata — `work.json` (docs/02-data-model.md §10.2).
 *
 * Zod 4 note: the doc spells the nested-object defaults `.default({})`, but zod 4's
 * `.default()` no longer parses its value (it must be a complete output object).
 * `.prefault({})` is zod 4's spelling of the doc's semantics: an absent field materializes
 * every inner default.
 */

export const ConsolidationSettings = z.object({
  activeWindowSnippets: z.number().int().positive().default(6),
  activeWindowWords: z.number().int().positive().default(3000),
  maxFrontierSnippets: z.number().int().positive().default(18),
  // maxFrontierWords bounds the context engine's local-context region (02 §2.4)
  maxFrontierWords: z.number().int().positive().default(9000),
  debounceMs: z.number().int().positive().default(30_000),
  undoGraceMs: z.number().int().positive().default(300_000),
  mode: z.enum(['auto', 'review']).default('auto'), // "review" is M2
})
export type ConsolidationSettings = z.infer<typeof ConsolidationSettings>

export const WorkSettings = z.object({
  consolidation: ConsolidationSettings.prefault({}),
  illustrationStaleWordDeltaPct: z.number().default(15),
  // Per-work overrides of the context engine's budget knobs (06 §8.1); edited via
  // PATCH /works/:w (03 §config). The doc spells this `BudgetKnobs.partial()`; see context.ts
  // for why zod 4 needs the dedicated overrides schema to keep true-partial semantics.
  contextOverrides: BudgetKnobsOverrides.default({}),
})
export type WorkSettings = z.infer<typeof WorkSettings>

export const WorkMeta = z.object({
  schemaVersion: z.literal(1),
  id: Ulid,
  title: z.string().min(1),
  levelScheme: z.array(z.string().min(1)).min(1).default(['chapter']), // backend-owned (02 §2.1)
  createdAt: IsoTime,
  settings: WorkSettings.prefault({}),
})
export type WorkMeta = z.infer<typeof WorkMeta>

// ---------------------------------------------------------------------------
// API DTOs (docs/03-api.md §3.1). These exports own the names `WorkSummary`/`WorkDetail`;
// the storage layer's internal WorkSummary (apps/server storageTypes.ts) is a different,
// server-private shape.
// ---------------------------------------------------------------------------

// Counts are nullable — cheap-list semantics: `GET /works` scans work.json files and may not
// have opened each work's index; null means "not computed", never zero.
export const WorkSummary = z.object({
  id: Ulid,
  title: z.string(),
  slug: z.string(),
  wordCount: z.number().int().nullable(),
  snippetCount: z.number().int().nullable(),
  sectionCount: z.number().int().nullable(),
  updatedAt: IsoTime,
})
export type WorkSummary = z.infer<typeof WorkSummary>

export const WorkDetail = WorkSummary.extend({
  settings: WorkSettings, // consolidation thresholds + contextOverrides (02)
  levelScheme: z.array(z.string()),
  readonly: z.boolean(), // second-instance lock (02 §locking)
})
export type WorkDetail = z.infer<typeof WorkDetail>

/** POST /api/works body. */
export const WorkCreate = z.object({ title: z.string().min(1) })
export type WorkCreate = z.infer<typeof WorkCreate>

// PATCH /api/works/:w body. True-partial update shapes, hand-written because zod 4's
// `.partial()` re-materializes defaults (see context.ts) — a PATCH that resets absent
// fields to defaults would clobber saved settings.
export const ConsolidationSettingsUpdate = z.object({
  activeWindowSnippets: z.number().int().positive().optional(),
  activeWindowWords: z.number().int().positive().optional(),
  maxFrontierSnippets: z.number().int().positive().optional(),
  maxFrontierWords: z.number().int().positive().optional(),
  debounceMs: z.number().int().positive().optional(),
  undoGraceMs: z.number().int().positive().optional(),
  mode: z.enum(['auto', 'review']).optional(),
})
export type ConsolidationSettingsUpdate = z.infer<typeof ConsolidationSettingsUpdate>

export const WorkSettingsUpdate = z.object({
  consolidation: ConsolidationSettingsUpdate.optional(),
  illustrationStaleWordDeltaPct: z.number().optional(),
  contextOverrides: BudgetKnobsOverrides.optional(),
})
export type WorkSettingsUpdate = z.infer<typeof WorkSettingsUpdate>

export const WorkPatch = z.object({
  title: z.string().min(1).optional(),
  settings: WorkSettingsUpdate.optional(),
})
export type WorkPatch = z.infer<typeof WorkPatch>
