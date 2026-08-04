import { z } from 'zod'
import { Hash, IsoTime, Ulid } from './ids.js'
import { TaskKind } from './task-kind.js'

/**
 * Context-engine primitives (docs/06-context-engine.md): the fidelity model (§2.1), the
 * persistent ledger schemas (§2.2 — also the on-disk `.cowrite/context/state.json` shape),
 * the budget knobs (§8.1, consumed by `WorkSettings.contextOverrides` and `config.budgets`),
 * the planning-tool wire schemas (§6), the usage-log events (§8.4), and the REST DTOs (§11).
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
// The persistent context ledger (06 §2.2) — the per-work record of which items are
// elevated above their computed default fidelity, why, and for how long. Default-fidelity
// items are NOT stored: the default map is recomputed from the section tree at every task
// (06 §4), so the ledger stays tiny and the whole structure is a rebuildable cache
// (`.cowrite/context/state.json`, atomic tmp+rename writes).
// ---------------------------------------------------------------------------

export const ElevationSource = z.enum([
  'tool', // model opened it via tool call during planning
  'cite', // model listed it in finish_planning citations
  'user', // user selected it in the edit-task pane (M2)
  'target', // it is / contains / neighbours the passage an edit targets
])
export type ElevationSource = z.infer<typeof ElevationSource>

export const ElevatedItem = z.object({
  kind: z.enum(['section', 'world']), // snippets are always full; never elevated
  id: Ulid,
  fidelity: Fidelity, // elevated level (above computed default)
  ttl: z.number().int().min(0), // remaining "actions" (completed tasks) before decay
  source: ElevationSource,
  elevatedAtTask: z.number().int(), // IMMUTABLE slot marker; the eviction tie-break
  lastCitedTask: z.number().int(), // recency; reset on re-open / re-cite
  tokens: z.number().int(), // estimated cost at this fidelity (re-checked, 06 §8.3)
  sourceHash: Hash, // content hash at last render; staleness check (06 §10)
})
export type ElevatedItem = z.infer<typeof ElevatedItem>

export const AnchorExcerpt = z.object({
  sectionId: Ulid,
  start: z.number().int(), // half-open char range into the section's content.md
  end: z.number().int(),
  tokens: z.number().int(),
  contentHash: Hash, // hash of the excerpt text; mismatch ⇒ re-derive (06 §4.3)
})
export type AnchorExcerpt = z.infer<typeof AnchorExcerpt>

export const ContextState = z.object({
  version: z.literal(1),
  taskCounter: z.number().int(), // count of *completed* tasks ("actions")
  elevated: z.array(ElevatedItem), // append-ordered (06 §2.2 ordering rules)
  anchors: z.object({
    refreshedAtTask: z.number().int(),
    excerpts: z.array(AnchorExcerpt),
  }),
})
export type ContextState = z.infer<typeof ContextState>

// ---------------------------------------------------------------------------
// Usage log events (06 §8.4) — one JSONL line per event in
// `.cowrite/context/usage.jsonl`; served by GET /context/usage. Append-only and never
// read by the engine itself; exists so budget/decay defaults can be re-tuned from real
// profiles (roadmap M1.5).
// ---------------------------------------------------------------------------

export const UsageEvent = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('task_start'),
    task: z.number(),
    taskKind: TaskKind,
    assembledTokens: z.number(),
    regions: z.record(z.string(), z.number()),
    ts: IsoTime,
  }),
  z.object({
    kind: z.literal('tool_call'),
    task: z.number(),
    tool: z.string(),
    item: ItemRef.optional(),
    resultTokens: z.number(),
    ts: IsoTime,
  }),
  z.object({
    kind: z.literal('task_end'),
    task: z.number(),
    cited: z.array(ItemRef),
    decayed: z.array(ItemRef),
    evicted: z.array(ItemRef),
    finalTokens: z.number(),
    planningRounds: z.number(),
    ts: IsoTime,
  }),
  z.object({
    kind: z.literal('cache_break'),
    task: z.number(),
    region: z.string(),
    ts: IsoTime,
  }),
])
export type UsageEvent = z.infer<typeof UsageEvent>

// ---------------------------------------------------------------------------
// Planning-stage tool wire schemas (06 §6). Bound per engine session and handed to the
// harness as the run-stable `tools` array (05 §4.1: identical bytes on every request of a
// run). All tools are read-only and idempotent — the harness may replay a planning call
// after a mid-stream death and re-obtain identical results. The early design note's
// `context_open_entry` was folded into `context_expand({kind: "world"})` in the final spec.
// ---------------------------------------------------------------------------

export const PlanningToolName = z.enum(['context_expand', 'context_search', 'finish_planning'])
export type PlanningToolName = z.infer<typeof PlanningToolName>

/** `context_expand` levels — `name` is never requested, only decayed to (06 §2.1). */
export const ExpandLevel = z.enum(['short', 'long', 'full'])
export type ExpandLevel = z.infer<typeof ExpandLevel>

/** `context_expand` args; `level` defaults to one level above the item's current fidelity. */
export const ContextExpandArgs = z.object({
  kind: z.enum(['section', 'world']), // snippets are never expanded — they're already full text
  id: Ulid,
  level: ExpandLevel.optional(),
})
export type ContextExpandArgs = z.infer<typeof ContextExpandArgs>

/** `context_search` args — case-insensitive literal substring; regex is deferred (06 §6). */
export const ContextSearchArgs = z.object({
  query: z.string().min(1),
  wholeWord: z.boolean().optional(),
  scope: z.object({ kind: z.literal('section'), id: Ulid }).optional(),
})
export type ContextSearchArgs = z.infer<typeof ContextSearchArgs>

/** One `context_search` hit (up to 20 per call; excerpt ≈ 40 tokens around the match). */
export const ContextSearchMatch = z.object({
  kind: ItemKind,
  id: Ulid,
  path: z.string(),
  line: z.number().int().positive(),
  excerpt: z.string(),
})
export type ContextSearchMatch = z.infer<typeof ContextSearchMatch>

/** `finish_planning` args; `cite` lists the items the model actually relied on (06 §7.1). */
export const FinishPlanningArgs = z.object({
  cite: z.array(ItemRef).optional(),
  notes: z.string().optional(),
})
export type FinishPlanningArgs = z.infer<typeof FinishPlanningArgs>

// ---------------------------------------------------------------------------
// REST DTOs (06 §11; routes mounted by 03 §3.11). The engine's ledger schemas
// (`ContextState`, `UsageEvent`, …) land with the engine; /context/state and
// /context/usage register then.
// ---------------------------------------------------------------------------

/** GET /context/candidates — per-fidelity token counts for the picker + edit-task pane.
 *  Absent fidelities are omitted from `tokens` (e.g. no summary enriched yet). */
export const ContextCandidate = z.object({
  id: Ulid,
  kind: ItemKind,
  name: z.string(),
  path: z.string(), // ancestor names joined by " › "
  defaultFidelity: Fidelity,
  currentFidelity: Fidelity, // default unless elevated
  tokens: z.partialRecord(Fidelity, z.number().int()),
})
export type ContextCandidate = z.infer<typeof ContextCandidate>

/** POST /context/preview body — the live token meter's request. Interactive kinds only;
 *  the handler answers other kinds with `400 validation` (06 §11). */
export const PreviewRequest = z.object({
  taskType: TaskKind, // imported from the task-kind.ts leaf — see its header for the cycle note
  selections: z.array(z.object({ id: Ulid, kind: ItemKind, fidelity: Fidelity })).default([]),
  targets: z.array(ItemRef).default([]),
})
export type PreviewRequest = z.infer<typeof PreviewRequest>

/** POST /context/preview response — fully server-fed: `softBudget`/`hardCap` are the
 *  effective values after per-work `contextOverrides`, so the meter's scale needs no
 *  client-side budget constants. */
export const PreviewResponse = z.object({
  totalTokens: z.number().int(),
  perRegion: z.record(z.string(), z.number().int()),
  overSoft: z.boolean(),
  overHard: z.boolean(),
  softBudget: z.number().int(),
  hardCap: z.number().int(),
})
export type PreviewResponse = z.infer<typeof PreviewResponse>

/** One row of the computed default fidelity map (sections + world entries), served next
 *  to the ledger by GET /context/state (06 §11 — debug pane; edit-task checkmarks M2). */
export const DefaultMapEntry = z.object({
  id: Ulid,
  kind: ItemKind,
  fidelity: Fidelity,
})
export type DefaultMapEntry = z.infer<typeof DefaultMapEntry>

/** GET /context/state response: the persistent ledger plus the computed default map. */
export const ContextStateRes = z.object({
  state: ContextState,
  defaultMap: z.array(DefaultMapEntry),
})
export type ContextStateRes = z.infer<typeof ContextStateRes>

/** GET /context/usage?limit=100 query (06 §11). */
export const ContextUsageQuery = z.object({
  limit: z.coerce.number().int().positive().max(1000).default(100),
})
export type ContextUsageQuery = z.infer<typeof ContextUsageQuery>
