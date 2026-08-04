import { describe, expect, it } from 'vitest'
import {
  ConsolidationSettings,
  WorkDetail,
  WorkMeta,
  WorkPatch,
  WorkSettings,
  WorkSummary,
} from './work.js'

const workId = '01J2P7Q4V2M8Z6T1RD5FCW9XKB'

describe('WorkMeta', () => {
  it('materializes every default from a minimal work.json', () => {
    const meta = WorkMeta.parse({
      schemaVersion: 1,
      id: workId,
      title: 'Salt and Signal',
      createdAt: '2026-06-01T08:00:00Z',
    })
    expect(meta.levelScheme).toEqual(['chapter'])
    expect(meta.settings).toEqual({
      consolidation: {
        activeWindowSnippets: 6,
        activeWindowWords: 3000,
        maxFrontierSnippets: 18,
        maxFrontierWords: 9000,
        debounceMs: 30_000,
        undoGraceMs: 300_000,
        mode: 'auto',
      },
      illustrationStaleWordDeltaPct: 15,
      contextOverrides: {},
    })
  })

  it('rejects an empty title, empty levelScheme, and wrong schemaVersion', () => {
    const base = {
      schemaVersion: 1,
      id: workId,
      title: 'T',
      createdAt: '2026-06-01T08:00:00Z',
    }
    expect(WorkMeta.safeParse({ ...base, title: '' }).success).toBe(false)
    expect(WorkMeta.safeParse({ ...base, levelScheme: [] }).success).toBe(false)
    expect(WorkMeta.safeParse({ ...base, levelScheme: [''] }).success).toBe(false)
    expect(WorkMeta.safeParse({ ...base, schemaVersion: 2 }).success).toBe(false)
  })
})

describe('WorkSettings', () => {
  it('fills all defaults from {}', () => {
    const settings = WorkSettings.parse({})
    expect(settings.consolidation.maxFrontierWords).toBe(9000)
    expect(settings.consolidation.mode).toBe('auto')
    expect(settings.illustrationStaleWordDeltaPct).toBe(15)
    expect(settings.contextOverrides).toEqual({})
  })

  it('keeps overrides and fills the siblings', () => {
    const settings = WorkSettings.parse({
      consolidation: { maxFrontierWords: 12_000 },
      contextOverrides: { softBudget: 16_000 },
    })
    expect(settings.consolidation.maxFrontierWords).toBe(12_000)
    expect(settings.consolidation.mode).toBe('auto')
    expect(settings.consolidation.maxFrontierSnippets).toBe(18)
    expect(settings.contextOverrides).toEqual({ softBudget: 16_000 })
  })

  it('rejects non-positive consolidation thresholds', () => {
    expect(ConsolidationSettings.safeParse({ maxFrontierWords: 0 }).success).toBe(false)
    expect(ConsolidationSettings.safeParse({ debounceMs: -1 }).success).toBe(false)
    expect(ConsolidationSettings.safeParse({ activeWindowWords: 1.5 }).success).toBe(false)
  })

  it("rejects mode 'review' at parse with the M2 message (M1 is auto-only)", () => {
    const parsed = ConsolidationSettings.safeParse({ mode: 'review' })
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toContain("'review' ships in M2")
    }
    expect(ConsolidationSettings.parse({ mode: 'auto' }).mode).toBe('auto')
  })
})

describe('WorkSummary / WorkDetail (03 §3.1 DTOs)', () => {
  const summary = {
    id: workId,
    title: 'Salt and Signal',
    slug: 'salt-and-signal',
    wordCount: 42_000,
    snippetCount: 12,
    sectionCount: 9,
    updatedAt: '2026-07-06T14:02:11Z',
  }

  it('round-trips a full summary and accepts null counts (cheap-list semantics)', () => {
    expect(WorkSummary.parse(summary)).toEqual(summary)
    const cheap = WorkSummary.parse({
      ...summary,
      wordCount: null,
      snippetCount: null,
      sectionCount: null,
    })
    expect(cheap.wordCount).toBeNull()
  })

  it('WorkDetail adds settings, levelScheme, and the readonly lock flag', () => {
    const detail = WorkDetail.parse({
      ...summary,
      settings: WorkSettings.parse({}),
      levelScheme: ['book', 'chapter'],
      readonly: false,
    })
    expect(detail.readonly).toBe(false)
    expect(WorkDetail.safeParse(summary).success).toBe(false)
  })
})

describe('WorkPatch', () => {
  it('keeps a sparse settings patch sparse — no materialized defaults', () => {
    const patch = WorkPatch.parse({ settings: { consolidation: { debounceMs: 1000 } } })
    expect(patch.settings).toEqual({ consolidation: { debounceMs: 1000 } })
    expect(WorkPatch.parse({})).toEqual({})
  })

  it("rejects mode 'review' in a settings patch too (M1 is auto-only)", () => {
    expect(WorkPatch.safeParse({ settings: { consolidation: { mode: 'review' } } }).success).toBe(
      false,
    )
  })

  it('rejects an empty title', () => {
    expect(WorkPatch.safeParse({ title: '' }).success).toBe(false)
  })
})
