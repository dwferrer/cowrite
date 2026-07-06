import { describe, expect, it } from 'vitest'
import { ConsolidationSettings, WorkMeta, WorkSettings } from './work.js'

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
      consolidation: { maxFrontierWords: 12_000, mode: 'review' },
      contextOverrides: { softBudget: 16_000 },
    })
    expect(settings.consolidation.maxFrontierWords).toBe(12_000)
    expect(settings.consolidation.mode).toBe('review')
    expect(settings.consolidation.maxFrontierSnippets).toBe(18)
    expect(settings.contextOverrides).toEqual({ softBudget: 16_000 })
  })

  it('rejects non-positive consolidation thresholds', () => {
    expect(ConsolidationSettings.safeParse({ maxFrontierWords: 0 }).success).toBe(false)
    expect(ConsolidationSettings.safeParse({ debounceMs: -1 }).success).toBe(false)
    expect(ConsolidationSettings.safeParse({ activeWindowWords: 1.5 }).success).toBe(false)
  })
})
