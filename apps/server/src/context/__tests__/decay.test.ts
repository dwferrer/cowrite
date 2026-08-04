import type { ContextState, ElevatedItem } from '@cowrite/shared'
import { describe, expect, it } from 'vitest'
import { enforce, finalizeTask, keepScore } from '../decay.js'
import { tid } from './fixtures.js'

/**
 * Ledger decay tables (docs/06-context-engine.md §7.2, §8.2) — exhaustive small cases:
 * TTL math, overage steps, eviction order determinism, and the pinned regression
 * "opened-composed-immediately-no-finish_planning ⇒ ttl = 3".
 */

const KNOBS = { defaultTtl: 3, softBudget: 100, hardCap: 200 }

function elevated(over: Partial<ElevatedItem> & { id: string }): ElevatedItem {
  return {
    kind: 'section',
    fidelity: 'full',
    ttl: 3,
    source: 'tool',
    elevatedAtTask: 0,
    lastCitedTask: 0,
    tokens: 100,
    sourceHash: 'xxh64:0000000000000000',
    ...over,
  }
}

function state(items: ElevatedItem[] = [], taskCounter = 0): ContextState {
  return {
    version: 1,
    taskCounter,
    elevated: items,
    anchors: { refreshedAtTask: 0, excerpts: [] },
  }
}

const open = (id: string, tokens = 50): Parameters<typeof finalizeTask>[1]['opened'][number] => ({
  kind: 'section',
  id,
  fidelity: 'full',
  source: 'tool',
  tokens,
  sourceHash: 'xxh64:1111111111111111',
})

const lowEstimate = () => 10 // far under the soft budget: step 1

function run(
  s: ContextState,
  input: Partial<Parameters<typeof finalizeTask>[1]>,
): ReturnType<typeof finalizeTask> {
  return finalizeTask(
    s,
    {
      opened: [],
      citations: null,
      resolveCite: () => null,
      estimateAssembled: lowEstimate,
      ...input,
    },
    KNOBS,
  )
}

describe('finalizeTask — citation rules (§7.1)', () => {
  it('PINNED REGRESSION: opened via tool, composed immediately, NO finish_planning ⇒ ttl = 3', () => {
    const result = run(state(), { opened: [open(tid(1))], citations: null })
    expect(result.state.elevated).toHaveLength(1)
    expect(result.state.elevated[0]?.ttl).toBe(3) // NOT 1
    expect(result.state.taskCounter).toBe(1)
  })

  it('opened and cited ⇒ ttl = defaultTtl', () => {
    const result = run(state(), {
      opened: [open(tid(1))],
      citations: [{ kind: 'section', id: tid(1) }],
    })
    expect(result.state.elevated[0]?.ttl).toBe(3)
  })

  it('opened but omitted from an EXPLICIT cite list ⇒ ttl = 1 (one grace task)', () => {
    const result = run(state(), {
      opened: [open(tid(1)), open(tid(2))],
      citations: [{ kind: 'section', id: tid(2) }],
    })
    const first = result.state.elevated.find((e) => e.id === tid(1))
    const second = result.state.elevated.find((e) => e.id === tid(2))
    expect(first?.ttl).toBe(1)
    expect(second?.ttl).toBe(3)
  })

  it('an explicit EMPTY cite list penalizes every opened item', () => {
    const result = run(state(), { opened: [open(tid(1))], citations: [] })
    expect(result.state.elevated[0]?.ttl).toBe(1)
  })

  it('re-cite of an already-elevated, not-opened item resets its clock', () => {
    const s = state([elevated({ id: tid(1), ttl: 1, lastCitedTask: 0 })], 4)
    const result = run(s, { citations: [{ kind: 'section', id: tid(1) }] })
    const item = result.state.elevated[0]
    expect(item?.ttl).toBe(3)
    expect(item?.lastCitedTask).toBe(5)
  })

  it('cite of a known-but-not-elevated item elevates it via resolveCite', () => {
    const result = run(state(), {
      citations: [{ kind: 'world', id: tid(9) }],
      resolveCite: (ref) => ({
        kind: 'world',
        id: ref.id,
        fidelity: 'full',
        source: 'cite',
        tokens: 40,
        sourceHash: 'xxh64:2222222222222222',
      }),
    })
    expect(result.state.elevated).toHaveLength(1)
    expect(result.state.elevated[0]?.source).toBe('cite')
    expect(result.state.elevated[0]?.ttl).toBe(3)
  })

  it('cite of an unknown ref is ignored and reported, never a failure', () => {
    const result = run(state(), { citations: [{ kind: 'section', id: tid(404) }] })
    expect(result.state.elevated).toHaveLength(0)
    expect(result.unknownCites).toEqual([{ kind: 'section', id: tid(404) }])
  })

  it('snippet cites are ignored (snippets are always full, never elevated)', () => {
    const result = run(state(), { citations: [{ kind: 'snippet', id: tid(7) }] })
    expect(result.state.elevated).toHaveLength(0)
    expect(result.unknownCites).toHaveLength(1)
  })
})

describe('finalizeTask — replace-in-place ordering rules (§2.2)', () => {
  it('re-elevation to a higher fidelity replaces in place, keeping slot and elevatedAtTask', () => {
    const s = state(
      [
        elevated({ id: tid(1), fidelity: 'short', elevatedAtTask: 2, tokens: 10 }),
        elevated({ id: tid(2), elevatedAtTask: 3 }),
      ],
      5,
    )
    const result = run(s, { opened: [open(tid(1), 500)] })
    expect(result.state.elevated.map((e) => e.id)).toEqual([tid(1), tid(2)]) // position kept
    const item = result.state.elevated[0]
    expect(item?.fidelity).toBe('full')
    expect(item?.tokens).toBe(500)
    expect(item?.elevatedAtTask).toBe(2) // IMMUTABLE slot marker
    expect(item?.lastCitedTask).toBe(6)
  })

  it('re-open at a LOWER fidelity keeps the higher elevation, refreshes the clock', () => {
    const s = state([elevated({ id: tid(1), fidelity: 'full', tokens: 800, ttl: 1 })], 3)
    const result = run(s, {
      opened: [
        {
          kind: 'section',
          id: tid(1),
          fidelity: 'short',
          source: 'tool',
          tokens: 20,
          sourceHash: 'xxh64:3333333333333333',
        },
      ],
    })
    const item = result.state.elevated[0]
    expect(item?.fidelity).toBe('full')
    expect(item?.tokens).toBe(800)
    expect(item?.ttl).toBe(3)
  })

  it('new elevations append to the end', () => {
    const s = state([elevated({ id: tid(1) })], 1)
    const result = run(s, { opened: [open(tid(2))] })
    expect(result.state.elevated.map((e) => e.id)).toEqual([tid(1), tid(2)])
  })
})

describe('finalizeTask — decay step (§7.2)', () => {
  it('items untouched this task lose 1 ttl under the soft budget', () => {
    const s = state([elevated({ id: tid(1), ttl: 3, lastCitedTask: 0 })], 4)
    const result = run(s, {})
    expect(result.state.elevated[0]?.ttl).toBe(2)
    expect(result.step).toBe(1)
  })

  it('ttl hitting 0 decays the item back to default fidelity (removed + reported)', () => {
    const s = state([elevated({ id: tid(1), ttl: 1, lastCitedTask: 0 })], 4)
    const result = run(s, {})
    expect(result.state.elevated).toHaveLength(0)
    expect(result.decayed).toEqual([{ kind: 'section', id: tid(1) }])
  })

  it('overage accelerates the step: mid-way ⇒ 2, at/over the hard cap ⇒ 3', () => {
    const mid = run(state([elevated({ id: tid(1), ttl: 3, lastCitedTask: 0 })], 4), {
      estimateAssembled: () => 150, // overage 0.5 ⇒ step 2
    })
    expect(mid.step).toBe(2)
    expect(mid.state.elevated[0]?.ttl).toBe(1)

    const over = run(state([elevated({ id: tid(1), ttl: 3, lastCitedTask: 0 })], 4), {
      estimateAssembled: () => 999, // clamped overage 1 ⇒ step 3
    })
    expect(over.step).toBe(3)
    expect(over.state.elevated).toHaveLength(0)
  })

  it('items opened or cited THIS task are exempt from the decay step', () => {
    // 150 ⇒ step 2, but under the 0.9 × hardCap eviction line — decay exemption only.
    const result = run(state(), { opened: [open(tid(1))], estimateAssembled: () => 150 })
    expect(result.state.elevated[0]?.ttl).toBe(3)
  })

  it('decay is monotone: ttl never increases without a re-open/re-cite', () => {
    let s = state([elevated({ id: tid(1), ttl: 3, lastCitedTask: 0 })], 0)
    const ttls: number[] = []
    for (let i = 0; i < 4; i++) {
      const result = run(s, {})
      ttls.push(result.state.elevated[0]?.ttl ?? 0)
      s = result.state
    }
    expect(ttls).toEqual([2, 1, 0, 0])
  })

  it('the input state is never mutated', () => {
    const s = state([elevated({ id: tid(1), ttl: 2, lastCitedTask: 0 })], 1)
    const before = structuredClone(s)
    run(s, { opened: [open(tid(2))] })
    expect(s).toEqual(before)
  })
})

describe('enforce — hard-cap eviction backstop (§8.2)', () => {
  it('evicts by lowest keepScore until under 0.9 × hardCap', () => {
    // keepScore = ttl / max(1, tokens/1000): stale & fat goes first.
    const items = [
      elevated({ id: tid(1), ttl: 3, tokens: 1000 }), // score 3
      elevated({ id: tid(2), ttl: 1, tokens: 4000 }), // score 0.25 — first victim
      elevated({ id: tid(3), ttl: 2, tokens: 1000 }), // score 2
    ]
    const estimate = (elev: ElevatedItem[]) => elev.reduce((s, e) => s + e.tokens, 0)
    const { evicted } = enforce(items, [], 5000, estimate) // 0.9 × 5000 = 4500
    // evicting the score-0.25 item brings 6000 → 2000, already under the line
    expect(evicted).toEqual([{ kind: 'section', id: tid(2) }])
    expect(items.map((i) => i.id)).toEqual([tid(1), tid(3)])
  })

  it('tie-break: the older slot (lower elevatedAtTask) is evicted first', () => {
    const items = [
      elevated({ id: tid(1), ttl: 2, tokens: 2000, elevatedAtTask: 5 }),
      elevated({ id: tid(2), ttl: 2, tokens: 2000, elevatedAtTask: 1 }),
    ]
    const estimate = (elev: ElevatedItem[]) => elev.reduce((s, e) => s + e.tokens, 0)
    const { evicted } = enforce(items, [], 3000, estimate)
    expect(evicted[0]).toEqual({ kind: 'section', id: tid(2) })
  })

  it('required refs are never evicted, even when the estimate stays over the line', () => {
    const items = [elevated({ id: tid(1), ttl: 1, tokens: 9000 })]
    const estimate = (elev: ElevatedItem[]) => elev.reduce((s, e) => s + e.tokens, 0)
    const { evicted } = enforce(items, [{ kind: 'section', id: tid(1) }], 5000, estimate)
    expect(evicted).toEqual([])
    expect(items).toHaveLength(1)
  })

  it('post-enforce estimate ≤ 0.9 × hardCap whenever victims sufficed (property)', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const items: ElevatedItem[] = []
      let x = seed
      const rand = () => {
        x = (x * 48271) % 2147483647
        return x / 2147483647
      }
      const n = 1 + Math.floor(rand() * 8)
      for (let i = 0; i < n; i++) {
        items.push(
          elevated({
            id: tid(100 + i),
            ttl: 1 + Math.floor(rand() * 3),
            tokens: 100 + Math.floor(rand() * 5000),
            elevatedAtTask: Math.floor(rand() * 10),
          }),
        )
      }
      const estimate = (elev: ElevatedItem[]) => elev.reduce((s, e) => s + e.tokens, 0)
      enforce(items, [], 4000, estimate)
      expect(estimate(items)).toBeLessThanOrEqual(4000 * 0.9)
    }
  })

  it('keepScore favors fresh & cheap over stale & fat', () => {
    expect(keepScore(elevated({ id: tid(1), ttl: 3, tokens: 500 }))).toBeGreaterThan(
      keepScore(elevated({ id: tid(2), ttl: 1, tokens: 5000 })),
    )
  })

  it('finalizeTask runs the eviction backstop after decay', () => {
    // ttl 9 survives the accelerated (step 3) decay; the backstop still evicts it.
    const s = state([elevated({ id: tid(1), ttl: 9, tokens: 50_000, lastCitedTask: 0 })], 1)
    const result = run(s, {
      estimateAssembled: (elev) => elev.reduce((sum, e) => sum + e.tokens, 10),
    })
    expect(result.evicted).toEqual([{ kind: 'section', id: tid(1) }])
    expect(result.state.elevated).toHaveLength(0)
  })
})
