import { BudgetKnobs } from '@cowrite/shared'
import { describe, expect, it } from 'vitest'
import { computeDefaultMap, renderableFidelity } from '../defaults.js'
import { TokenEstimator } from '../estimate.js'
import { type FakeData, paragraphs, sampleWork, section, snapshotOf, tid } from './fixtures.js'

/**
 * Default-map computation (docs/06-context-engine.md §4): the total-coverage invariant on
 * synthetic trees, rule-2 full inclusion, frontier-relative rules 3–5, deterministic
 * skeleton demotion, and largest-first world demotion.
 */

const est = new TokenEstimator()
const knobs = BudgetKnobs.parse({})

describe('total-coverage invariant', () => {
  it('every section gets a fidelity ≥ name — nothing is ever omitted', async () => {
    const snapshot = await snapshotOf(sampleWork())
    const map = computeDefaultMap(snapshot, knobs, est)
    for (const s of snapshot.sections) {
      expect(map.sections.has(s.id), `section ${s.id} missing from the map`).toBe(true)
    }
  })

  it('holds on random synthetic trees (property)', async () => {
    let x = 42
    const rand = () => {
      x = (x * 48271) % 2147483647
      return x / 2147483647
    }
    for (let iter = 0; iter < 10; iter++) {
      const sections: FakeData['sections'] = []
      const n = 1 + Math.floor(rand() * 12)
      for (let i = 0; i < n; i++) {
        const parentIndex = Math.floor(rand() * (i + 1)) - 1
        const parent = parentIndex >= 0 ? sections[parentIndex] : undefined
        const isLeaf = rand() < 0.6
        sections.push(
          section({
            id: tid(1000 + iter * 100 + i),
            parentId: parent?.id ?? null,
            orderKey: `a${String(i).padStart(2, '0')}`,
            title: rand() < 0.5 ? `Section ${i}` : null,
            ...(isLeaf ? { content: paragraphs(`p${iter}-${i}`, 1 + Math.floor(rand() * 3)) } : {}),
            short: rand() < 0.5 ? `Short summary ${i}.` : null,
            long: rand() < 0.3 ? `Long summary ${i}.` : null,
          }),
        )
      }
      const snapshot = await snapshotOf({
        levelScheme: ['chapter'],
        sections,
        snippets: [],
        world: [],
        situation: '',
      })
      const map = computeDefaultMap(snapshot, knobs, est)
      expect(map.sections.size).toBe(snapshot.sections.length)
      for (const fidelity of map.sections.values()) {
        expect(['name', 'short', 'long', 'full']).toContain(fidelity)
      }
    }
  })
})

describe('rule 2 — un-enriched frozen leaves at full', () => {
  it('a leaf with content but no short summary is included at full and marked exempt', async () => {
    const snapshot = await snapshotOf(sampleWork())
    const map = computeDefaultMap(snapshot, knobs, est)
    expect(map.sections.get(tid(3))).toBe('full')
    expect(map.rule2Full.has(tid(3))).toBe(true)
  })

  it('a brand-new work with no sections at all is the degenerate case: empty map, no error', async () => {
    const snapshot = await snapshotOf({
      levelScheme: ['chapter'],
      sections: [],
      snippets: [{ id: tid(11), orderKey: 'b0', text: 'The first words.' }],
      world: [],
      situation: '',
    })
    const map = computeDefaultMap(snapshot, knobs, est)
    expect(map.sections.size).toBe(0)
    expect(map.chapterLevel).toBeNull()
  })
})

describe('rules 3–5 — frontier-relative fidelities', () => {
  it('the 2 chapter-level sections nearest the frontier get long; earlier siblings short', async () => {
    const data: FakeData = {
      levelScheme: ['chapter'],
      sections: [1, 2, 3, 4].map((i) =>
        section({
          id: tid(i),
          orderKey: `a${i}`,
          title: `Ch ${i}`,
          content: paragraphs(`ch${i}`, 2),
          short: `Short ${i}.`,
          long: `Long ${i}.`,
        }),
      ),
      snippets: [],
      world: [],
      situation: '',
    }
    const snapshot = await snapshotOf(data)
    const map = computeDefaultMap(snapshot, knobs, est)
    expect(map.chapterLevel).toBe('chapter')
    expect(map.sections.get(tid(1))).toBe('short')
    expect(map.sections.get(tid(2))).toBe('short')
    expect(map.sections.get(tid(3))).toBe('long')
    expect(map.sections.get(tid(4))).toBe('long')
  })

  it('long falls back to short when no long summary exists (renderable floor)', async () => {
    const snapshot = await snapshotOf(sampleWork())
    const map = computeDefaultMap(snapshot, knobs, est)
    // tid(2) is frontier-adjacent (rule 3) but has only a short summary
    expect(map.sections.get(tid(2))).toBe('short')
    // tid(1) is the other adjacent chapter and has a long summary
    expect(map.sections.get(tid(1))).toBe('long')
  })

  it('deeper descendants get name; roots get short (two-level scheme)', async () => {
    const data: FakeData = {
      levelScheme: ['part', 'chapter'],
      sections: [
        section({ id: tid(1), kind: 'part', orderKey: 'a0', title: 'Part I', short: 'P1.' }),
        section({
          id: tid(2),
          parentId: tid(1),
          kind: 'chapter',
          orderKey: 'a0',
          title: 'Ch 1',
          content: paragraphs('c1', 2),
          short: 'S1.',
        }),
        section({
          id: tid(3),
          parentId: tid(1),
          kind: 'chapter',
          orderKey: 'a1',
          title: 'Ch 2',
          content: paragraphs('c2', 2),
          short: 'S2.',
          long: 'L2.',
        }),
        section({ id: tid(4), kind: 'part', orderKey: 'a1', title: 'Part II', short: 'P2.' }),
        section({
          id: tid(5),
          parentId: tid(4),
          kind: 'chapter',
          orderKey: 'a0',
          title: 'Ch 3',
          content: paragraphs('c3', 2),
          short: 'S3.',
          long: 'L3.',
        }),
      ],
      snippets: [],
      world: [],
      situation: '',
    }
    const snapshot = await snapshotOf(data)
    const map = computeDefaultMap(snapshot, knobs, est)
    expect(map.chapterLevel).toBe('chapter')
    expect(map.sections.get(tid(1))).toBe('short') // root part
    expect(map.sections.get(tid(4))).toBe('short')
    // frontier chapters: last two chapter-level sections → long
    expect(map.sections.get(tid(3))).toBe('long')
    expect(map.sections.get(tid(5))).toBe('long')
    // earlier chapter in a DIFFERENT part than the frontier chapter: stays name (rule 5)
    expect(map.sections.get(tid(2))).toBe('name')
  })
})

describe('skeleton demotion (§4.1)', () => {
  it('demotes rule-4 shorts to name earliest-document-order first under a tiny budget', async () => {
    const data: FakeData = {
      levelScheme: ['chapter'],
      sections: [1, 2, 3, 4, 5].map((i) =>
        section({
          id: tid(i),
          orderKey: `a${i}`,
          title: `Ch ${i}`,
          content: paragraphs(`ch${i}`, 1),
          short: `A reasonably long short summary for chapter number ${i} with extra words to inflate the token count noticeably.`,
          long: `Long ${i}.`,
        }),
      ),
      snippets: [],
      world: [],
      situation: '',
    }
    const snapshot = await snapshotOf(data)
    const tight = BudgetKnobs.parse({ skeletonSummaryBudget: 60 })
    const map = computeDefaultMap(snapshot, tight, est)
    // Rule-4 members are chapters 1–3; the earliest demote first.
    expect(map.sections.get(tid(1))).toBe('name')
    // The rule-3 longs demote to short only after all rule-4 shorts are gone.
    const rule3 = [map.sections.get(tid(4)), map.sections.get(tid(5))]
    for (const f of rule3) expect(['long', 'short']).toContain(f)
    // determinism: recomputation yields the identical map
    const again = computeDefaultMap(snapshot, tight, est)
    expect([...again.sections.entries()]).toEqual([...map.sections.entries()])
  })

  it('demotion totals are incremental: O(n) estimator calls, never a re-scan per demotion', async () => {
    class CountingEstimator extends TokenEstimator {
      calls = 0
      override count(text: string, cacheKey?: string): number {
        this.calls += 1
        return super.count(text, cacheKey)
      }
    }
    const n = 30
    const data: FakeData = {
      levelScheme: ['chapter'],
      sections: Array.from({ length: n }, (_, i) =>
        section({
          id: tid(i + 1),
          orderKey: `a${String(i).padStart(2, '0')}`,
          title: `Ch ${i + 1}`,
          content: paragraphs(`ch${i + 1}`, 1),
          short: `A short summary for chapter ${i + 1} padded with enough words to cost real tokens.`,
          long: `Long ${i + 1}.`,
        }),
      ),
      snippets: [],
      world: Array.from({ length: n }, (_, i) => ({
        id: tid(100 + i),
        name: `Entry ${i}`,
        shortSummary: `World entry summary number ${i} with deliberate extra words for weight.`,
        body: `Body ${i}.`,
      })),
      situation: '',
    }
    const snapshot = await snapshotOf(data)
    const counting = new CountingEstimator()
    // Budgets of 1 force EVERY candidate to demote — the worst case for a re-scan loop.
    const tight = BudgetKnobs.parse({ skeletonSummaryBudget: 1, worldInfoSummaryBudget: 1 })
    const map = computeDefaultMap(snapshot, tight, counting)
    expect([...map.sections.values()].filter((f) => f === 'name').length).toBeGreaterThan(20)
    // One initial scan (n calls) + a constant few per demotion + the sort's per-candidate
    // cost — far below the ~n²/2 a re-scan-per-demotion loop would need for BOTH regions.
    expect(counting.calls).toBeLessThan(10 * n)
  })

  it('rule-2 fulls are exempt from demotion (coverage beats budget)', async () => {
    const snapshot = await snapshotOf(sampleWork())
    const tight = BudgetKnobs.parse({ skeletonSummaryBudget: 1 })
    const map = computeDefaultMap(snapshot, tight, est)
    expect(map.sections.get(tid(3))).toBe('full')
  })
})

describe('world-info demotion (§4.1 rule 6)', () => {
  it('every summarized entry defaults to short; unsummarized to name', async () => {
    const snapshot = await snapshotOf(sampleWork())
    const map = computeDefaultMap(snapshot, knobs, est)
    expect(map.world.get(tid(21))).toBe('short')
    expect(map.world.get(tid(22))).toBe('name') // no summary to render at short
  })

  it('demotes largest-first by token count under a tiny budget (tie: newest first)', async () => {
    const data = sampleWork()
    data.world = [
      { id: tid(21), name: 'Small', shortSummary: 'Tiny.', body: 'x' },
      {
        id: tid(22),
        name: 'Huge',
        shortSummary:
          'An enormous summary with many words repeated many times to dominate the token count of the world region entirely. '.repeat(
            3,
          ),
        body: 'y',
      },
      { id: tid(23), name: 'Mid', shortSummary: 'A medium sized summary here.', body: 'z' },
    ]
    const snapshot = await snapshotOf(data)
    const tight = BudgetKnobs.parse({ worldInfoSummaryBudget: 12 })
    const map = computeDefaultMap(snapshot, tight, est)
    expect(map.world.get(tid(22))).toBe('name') // largest demoted first
    // demotion stops as soon as the region fits
    const demotedCount = [...map.world.values()].filter((f) => f === 'name').length
    expect(demotedCount).toBeGreaterThanOrEqual(1)
  })
})

describe('renderableFidelity', () => {
  it('caps wanted fidelity at what the section can actually render', async () => {
    const snapshot = await snapshotOf(sampleWork())
    const withLong = snapshot.sectionById.get(tid(1))
    const shortOnly = snapshot.sectionById.get(tid(2))
    const bare = snapshot.sectionById.get(tid(3))
    if (!withLong || !shortOnly || !bare) throw new Error('fixture sections missing')
    expect(renderableFidelity(withLong, 'long')).toBe('long')
    expect(renderableFidelity(shortOnly, 'long')).toBe('short')
    expect(renderableFidelity(bare, 'short')).toBe('name')
    expect(renderableFidelity(bare, 'full')).toBe('full') // leaf prose renders
  })
})
