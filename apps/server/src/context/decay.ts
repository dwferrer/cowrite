import type { ContextState, ElevatedItem, Fidelity, ItemRef } from '@cowrite/shared'
import { FIDELITY_ORDER } from '@cowrite/shared'

/**
 * Citation tracking and decay (docs/06-context-engine.md §7) plus the hard-cap eviction
 * backstop (§8.2). Pure functions of (state, session outcome, knobs) — the ledger only
 * ever moves here, once per COMPLETED task (aborted tasks never reach finalize).
 */

export const refKey = (kind: string, id: string): string => `${kind}:${id}`

export function fidelityRank(f: Fidelity): number {
  return FIDELITY_ORDER.indexOf(f)
}

/** One item the session opened (tool) or is elevating (cite/user/target). */
export interface ElevationInput {
  kind: 'section' | 'world'
  id: string
  fidelity: Fidelity
  source: ElevatedItem['source']
  tokens: number
  sourceHash: string
}

export interface FinalizeInput {
  /** Items opened via tool this task, at their highest opened fidelity. */
  opened: ElevationInput[]
  /** finish_planning citations; null when no cite list was given (the load-bearing
   *  distinction of §7.1 rule 4 — prose-with-no-finish_planning must NOT penalize). */
  citations: ItemRef[] | null
  /** Resolve a cite of a not-currently-elevated, not-opened item into an elevation
   *  (one level above its default — session-owned); null ⇒ unknown ref, ignored+logged. */
  resolveCite: (ref: ItemRef) => ElevationInput | null
  /**
   * S: estimated assembled tokens for a hypothetical next plain `continue` given a
   * candidate elevated set (only the overage bucket matters, not exactness — §7.2).
   */
  estimateAssembled: (elevated: ElevatedItem[]) => number
}

export interface FinalizeKnobs {
  defaultTtl: number
  softBudget: number
  hardCap: number
}

export interface FinalizeResult {
  state: ContextState
  decayed: ItemRef[]
  evicted: ItemRef[]
  /** cite refs that matched nothing (logged, never a task failure — §12). */
  unknownCites: ItemRef[]
  /** The overage-derived decay step applied (1 normally; 2–3 past the soft budget). */
  step: number
}

/**
 * Upsert per the §2.2 ordering rules: new elevations push to the end; re-elevation
 * replaces the entry IN ITS EXISTING POSITION, keeps `elevatedAtTask` (immutable slot
 * marker) and keeps the higher fidelity.
 */
function upsertElevated(
  elevated: ElevatedItem[],
  input: ElevationInput,
  ttl: number,
  taskCounter: number,
): void {
  const at = elevated.findIndex((e) => e.kind === input.kind && e.id === input.id)
  if (at === -1) {
    elevated.push({
      kind: input.kind,
      id: input.id,
      fidelity: input.fidelity,
      ttl,
      source: input.source,
      elevatedAtTask: taskCounter,
      lastCitedTask: taskCounter,
      tokens: input.tokens,
      sourceHash: input.sourceHash,
    })
    return
  }
  const existing = elevated[at] as ElevatedItem
  const keepExisting = fidelityRank(existing.fidelity) >= fidelityRank(input.fidelity)
  elevated[at] = {
    ...existing, // elevatedAtTask (and slot position) are immutable
    fidelity: keepExisting ? existing.fidelity : input.fidelity,
    tokens: keepExisting ? existing.tokens : input.tokens,
    sourceHash: keepExisting ? existing.sourceHash : input.sourceHash,
    ttl: Math.max(existing.ttl, ttl),
    lastCitedTask: taskCounter,
  }
}

/** §7.2 `finalizeTask`, verbatim. Returns a new state; the input state is not mutated. */
export function finalizeTask(
  state: ContextState,
  input: FinalizeInput,
  knobs: FinalizeKnobs,
): FinalizeResult {
  const taskCounter = state.taskCounter + 1
  const elevated: ElevatedItem[] = state.elevated.map((e) => ({ ...e }))
  const unknownCites: ItemRef[] = []

  // 1. Commit this task's opens/cites (append or replace-in-place, §2.2). The ttl=1
  //    penalty applies ONLY when an explicit cite list exists and excludes the item.
  const citeListGiven = input.citations !== null
  const citedKeys = new Set((input.citations ?? []).map((r) => refKey(r.kind, r.id)))
  for (const open of input.opened) {
    const cited = citedKeys.has(refKey(open.kind, open.id))
    const ttl = !citeListGiven || cited ? knobs.defaultTtl : 1
    upsertElevated(elevated, open, ttl, taskCounter)
  }
  const openedKeys = new Set(input.opened.map((o) => refKey(o.kind, o.id)))
  for (const ref of input.citations ?? []) {
    const key = refKey(ref.kind, ref.id)
    if (openedKeys.has(key)) continue
    const existing = elevated.find((e) => refKey(e.kind, e.id) === key)
    if (existing !== undefined) {
      existing.ttl = knobs.defaultTtl // re-cite resets the clock
      existing.lastCitedTask = taskCounter
      continue
    }
    if (ref.kind === 'snippet') {
      unknownCites.push(ref) // snippets are always full; never elevated
      continue
    }
    const resolved = input.resolveCite(ref)
    if (resolved === null) {
      unknownCites.push(ref)
      continue
    }
    upsertElevated(elevated, resolved, knobs.defaultTtl, taskCounter)
  }

  // 2. Progressive-penalty decay step (S assumes the next task is a plain `continue`).
  const s = input.estimateAssembled(elevated)
  const overage = clamp((s - knobs.softBudget) / (knobs.hardCap - knobs.softBudget), 0, 1)
  const step = 1 + Math.floor(2 * overage) // 1 normally; 2–3 past the soft budget
  for (const item of elevated) {
    if (item.lastCitedTask < taskCounter) item.ttl -= step
  }
  const decayed: ItemRef[] = elevated
    .filter((i) => i.ttl <= 0)
    .map((i) => ({ kind: i.kind, id: i.id }))
  const surviving = elevated.filter((i) => i.ttl > 0)

  // 3. Hard-cap safety eviction (rare; §8.2).
  const { evicted } = enforce(surviving, [], knobs.hardCap, input.estimateAssembled)

  return {
    state: {
      version: 1,
      taskCounter,
      elevated: surviving,
      anchors: state.anchors,
    },
    decayed,
    evicted,
    unknownCites,
    step,
  }
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value))
}

/** §8.2 `keepScore`: keep fresh & cheap; evict stale & fat. */
export function keepScore(item: ElevatedItem): number {
  return item.ttl / Math.max(1, item.tokens / 1000)
}

/**
 * §8.2 assembly-time eviction backstop. MUTATES `elevated` in place (removes victims);
 * returns the refs evicted. `requiredRefs` (this task's user/target items) are never
 * evicted; if the estimate still exceeds the hard cap once only required items remain,
 * the caller fails the task with a structured error — that check is the caller's.
 */
export function enforce(
  elevated: ElevatedItem[],
  requiredRefs: ItemRef[],
  hardCap: number,
  estimateAssembled: (elevated: ElevatedItem[]) => number,
): { evicted: ItemRef[] } {
  const required = new Set(requiredRefs.map((r) => refKey(r.kind, r.id)))
  const evicted: ItemRef[] = []
  let s = estimateAssembled(elevated)
  while (s > hardCap * 0.9) {
    let victimIndex = -1
    for (let i = 0; i < elevated.length; i++) {
      const candidate = elevated[i] as ElevatedItem
      if (required.has(refKey(candidate.kind, candidate.id))) continue
      if (victimIndex === -1) {
        victimIndex = i
        continue
      }
      const best = elevated[victimIndex] as ElevatedItem
      const cScore = keepScore(candidate)
      const bScore = keepScore(best)
      if (
        cScore < bScore ||
        (cScore === bScore && candidate.elevatedAtTask < best.elevatedAtTask)
      ) {
        victimIndex = i
      }
    }
    if (victimIndex === -1) break // only required items left
    const [victim] = elevated.splice(victimIndex, 1)
    if (victim !== undefined) evicted.push({ kind: victim.kind, id: victim.id })
    s = estimateAssembled(elevated)
  }
  return { evicted }
}
