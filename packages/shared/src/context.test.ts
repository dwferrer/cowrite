import { describe, expect, it } from 'vitest'
import { BudgetKnobs, BudgetKnobsOverrides, FIDELITY_ORDER, Fidelity, ItemRef } from './context.js'

describe('Fidelity', () => {
  it('is the four-level total order and FIDELITY_ORDER mirrors it', () => {
    expect(Fidelity.options).toEqual(['name', 'short', 'long', 'full'])
    expect(FIDELITY_ORDER).toEqual(Fidelity.options)
    expect(Fidelity.safeParse('medium').success).toBe(false)
  })
})

describe('ItemRef', () => {
  it('requires a bare ULID plus explicit kind', () => {
    const ref = { kind: 'section', id: '01J2KF3M8QAB4CD5W0ZNXGT7R9' } as const
    expect(ItemRef.parse(ref)).toEqual(ref)
    expect(ItemRef.safeParse({ kind: 'situation', id: ref.id }).success).toBe(false)
    expect(ItemRef.safeParse({ kind: 'section', id: 'sec_123' }).success).toBe(false)
  })
})

describe('BudgetKnobs', () => {
  it('materializes the 06 §8.1 defaults from {}', () => {
    expect(BudgetKnobs.parse({})).toEqual({
      anchorTokensTotal: 4000,
      skeletonSummaryBudget: 6000,
      worldInfoSummaryBudget: 3000,
      softBudget: 32_000,
      hardCap: 64_000,
      defaultTtl: 3,
      maxPlanningRounds: 4,
      maxPlanningRoundsQuickEdit: 2,
      maxToolCalls: 10,
      maxToolResultTokens: 4096,
      refreshTailTokens: 1000,
      targetWindowTokens: 1000,
      tokenMarginPct: 10,
    })
  })

  it('keeps overrides sparse — no defaults leak into Partial<BudgetKnobs>', () => {
    expect(BudgetKnobsOverrides.parse({ hardCap: 32_000 })).toEqual({ hardCap: 32_000 })
    expect(BudgetKnobsOverrides.parse({})).toEqual({})
    expect(BudgetKnobsOverrides.safeParse({ hardCap: 0 }).success).toBe(false)
  })
})
