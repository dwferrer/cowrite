import { z } from 'zod'
import { Ulid } from './ids.js'

/**
 * Context-engine primitives (docs/06-context-engine.md). Stage 1 implements only what other
 * schemas need: the fidelity model (§2.1) and the budget knobs (§8.1, consumed by
 * `WorkSettings.contextOverrides`). The ledger schemas (`ContextState`, `ElevatedItem`, …)
 * land with the engine itself.
 */

export const Fidelity = z.enum(['name', 'short', 'long', 'full'])
export type Fidelity = z.infer<typeof Fidelity>
export const FIDELITY_ORDER: Fidelity[] = ['name', 'short', 'long', 'full']

export const ItemKind = z.enum(['section', 'snippet', 'world'])
export type ItemKind = z.infer<typeof ItemKind>

export const ItemRef = z.object({ kind: ItemKind, id: Ulid })
export type ItemRef = z.infer<typeof ItemRef>

// 06 §8.1 gives the knobs as a table, not a verbatim schema; field names follow the table.
// "maxPlanningRounds / quick-edit | 4 / 2" is two knobs (general vs quick-edit round cap).
export const BudgetKnobs = z.object({
  anchorTokensTotal: z.number().int().positive().default(4000),
  skeletonSummaryBudget: z.number().int().positive().default(6000),
  worldInfoSummaryBudget: z.number().int().positive().default(3000),
  softBudget: z.number().int().positive().default(32_000),
  hardCap: z.number().int().positive().default(64_000),
  defaultTtl: z.number().int().positive().default(3),
  maxPlanningRounds: z.number().int().positive().default(4),
  maxPlanningRoundsQuickEdit: z.number().int().positive().default(2),
  maxToolCalls: z.number().int().positive().default(10),
  maxToolResultTokens: z.number().int().positive().default(4096),
  refreshTailTokens: z.number().int().positive().default(1000),
  targetWindowTokens: z.number().int().positive().default(1000),
  tokenMarginPct: z.number().int().nonnegative().default(10),
})
export type BudgetKnobs = z.infer<typeof BudgetKnobs>

// The doc spells per-work/app overrides `BudgetKnobs.partial()` (02 §10.2, 03 §9.2), but zod 4
// fires ZodDefault even under the ZodOptional that `.partial()` adds — every default would
// re-materialize and a sparse override object would parse into a full knob set. Unwrapping the
// defaults first keeps the documented Partial<BudgetKnobs> semantics.
const budgetKnobsOverridesShape = Object.fromEntries(
  Object.entries(BudgetKnobs.shape).map(([key, knob]) => [key, knob.unwrap().optional()]),
) as { [K in keyof typeof BudgetKnobs.shape]: z.ZodOptional<z.ZodNumber> }
export const BudgetKnobsOverrides = z.object(budgetKnobsOverridesShape)
export type BudgetKnobsOverrides = z.infer<typeof BudgetKnobsOverrides>

// ---------------------------------------------------------------------------
// Context-route DTOs (docs/03-api.md §3.11).
// OWNER: 06-context-engine.md (Stage 3). Defined here so the Stage 2 route registry can
// reference the stubs; the engine's ledger schemas (`ContextState`, …) land with it.
// ---------------------------------------------------------------------------

/** GET /context/candidates — per-fidelity token counts for the picker + edit-task pane. */
export const ContextCandidate = z.object({
  id: Ulid,
  kind: ItemKind,
  name: z.string(),
  path: z.string(), // display breadcrumb, e.g. "Book One / Ch. 3"
  defaultFidelity: Fidelity,
  currentFidelity: Fidelity,
  tokens: z.partialRecord(Fidelity, z.number().int()),
})
export type ContextCandidate = z.infer<typeof ContextCandidate>

/** POST /context/preview body — the live token meter's request. */
export const ContextPreviewReq = z.object({
  taskType: z.string(), // TaskKind; string here to avoid an import cycle knot at the stub stage
  selections: z.array(z.object({ id: Ulid, kind: ItemKind, fidelity: Fidelity })).default([]),
  targets: z.array(ItemRef).optional(),
})
export type ContextPreviewReq = z.infer<typeof ContextPreviewReq>

/** POST /context/preview response — fully server-fed; the client renders no budget constants. */
export const ContextPreviewRes = z.object({
  totalTokens: z.number().int(),
  perRegion: z.record(z.string(), z.number().int()),
  overSoft: z.boolean(),
  overHard: z.boolean(),
  softBudget: z.number().int(),
  hardCap: z.number().int(),
})
export type ContextPreviewRes = z.infer<typeof ContextPreviewRes>
