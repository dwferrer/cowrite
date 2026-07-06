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
