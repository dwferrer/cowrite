import { describe, expect, it } from 'vitest'
import {
  BudgetKnobs,
  BudgetKnobsOverrides,
  ContextCandidate,
  ContextExpandArgs,
  ContextSearchArgs,
  ContextSearchMatch,
  ExpandLevel,
  FIDELITY_ORDER,
  Fidelity,
  FinishPlanningArgs,
  ItemRef,
  PlanningToolName,
  PreviewRequest,
  PreviewResponse,
} from './context.js'

const sectionId = '01J2KF3M8QAB4CD5W0ZNXGT7R9'
const entryId = '01J2P7Q4V2M8Z6T1RD5FCW9XKB'

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

describe('planning tools (06 §6 — spellings locked, snake_case tool names)', () => {
  it('names exactly the three session tools; context_open_entry does not exist', () => {
    expect(PlanningToolName.options).toEqual([
      'context_expand',
      'context_search',
      'finish_planning',
    ])
    expect(PlanningToolName.safeParse('context_open_entry').success).toBe(false)
  })

  it('context_expand takes section|world + optional short|long|full level', () => {
    expect(ContextExpandArgs.parse({ kind: 'section', id: sectionId })).toEqual({
      kind: 'section',
      id: sectionId,
    })
    const full = { kind: 'world', id: entryId, level: 'full' } as const
    expect(ContextExpandArgs.parse(full)).toEqual(full)
    expect(ExpandLevel.options).toEqual(['short', 'long', 'full'])
    // `name` is a decay target, never a requestable expansion level
    expect(ContextExpandArgs.safeParse({ kind: 'world', id: entryId, level: 'name' }).success).toBe(
      false,
    )
    // snippets are already full text — not expandable
    expect(ContextExpandArgs.safeParse({ kind: 'snippet', id: entryId }).success).toBe(false)
  })

  it('context_search takes a query with optional whole-word flag and section scope', () => {
    expect(ContextSearchArgs.parse({ query: 'storm glass' })).toEqual({ query: 'storm glass' })
    const scoped = {
      query: 'ferry',
      wholeWord: true,
      scope: { kind: 'section', id: sectionId },
    } as const
    expect(ContextSearchArgs.parse(scoped)).toEqual(scoped)
    expect(ContextSearchArgs.safeParse({ query: '' }).success).toBe(false)
    expect(
      ContextSearchArgs.safeParse({ query: 'x', scope: { kind: 'world', id: entryId } }).success,
    ).toBe(false)
  })

  it('search matches carry kind/id/path/line/excerpt', () => {
    const match = {
      kind: 'snippet',
      id: entryId,
      path: 'Frontier',
      line: 12,
      excerpt: '…the storm glass hummed…',
    } as const
    expect(ContextSearchMatch.parse(match)).toEqual(match)
    expect(ContextSearchMatch.safeParse({ ...match, line: 0 }).success).toBe(false)
  })

  it('finish_planning carries optional cite ItemRefs and notes', () => {
    expect(FinishPlanningArgs.parse({})).toEqual({})
    const args = {
      cite: [{ kind: 'world', id: entryId }],
      notes: 'used the ferry timetable',
    } as const
    expect(FinishPlanningArgs.parse(args)).toEqual(args)
    expect(FinishPlanningArgs.safeParse({ cite: [{ kind: 'anchor', id: entryId }] }).success).toBe(
      false,
    )
  })
})

describe('REST DTOs (06 §11)', () => {
  it('ContextCandidate round-trips with a sparse per-fidelity token map', () => {
    const candidate = {
      id: sectionId,
      kind: 'section',
      name: 'The Ferry',
      path: 'Book One › The Crossing',
      defaultFidelity: 'short',
      currentFidelity: 'long',
      tokens: { name: 4, short: 120 }, // no long/full yet — absent, not null
    } as const
    expect(ContextCandidate.parse(candidate)).toEqual(candidate)
    expect(ContextCandidate.safeParse({ ...candidate, tokens: { medium: 9 } }).success).toBe(false)
  })

  it('PreviewRequest types taskType as the real TaskKind enum and defaults its arrays', () => {
    expect(PreviewRequest.parse({ taskType: 'continue' })).toEqual({
      taskType: 'continue',
      selections: [],
      targets: [],
    })
    const full = PreviewRequest.parse({
      taskType: 'quick-edit',
      selections: [{ id: entryId, kind: 'world', fidelity: 'full' }],
      targets: [{ kind: 'snippet', id: entryId }],
    })
    expect(full.selections).toHaveLength(1)
    expect(PreviewRequest.safeParse({ taskType: 'summarize' }).success).toBe(false)
    expect(PreviewRequest.safeParse({ taskType: 'quickEdit' }).success).toBe(false)
  })

  it('PreviewResponse carries the server-fed softBudget/hardCap scale', () => {
    const res = {
      totalTokens: 29_400,
      perRegion: { 'world-info': 2_100, skeleton: 5_800 },
      overSoft: false,
      overHard: false,
      softBudget: 32_000,
      hardCap: 64_000,
    } as const
    expect(PreviewResponse.parse(res)).toEqual(res)
    expect(PreviewResponse.safeParse({ ...res, softBudget: undefined }).success).toBe(false)
  })
})
