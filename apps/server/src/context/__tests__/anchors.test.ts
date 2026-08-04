import { describe, expect, it } from 'vitest'
import {
  anchorCandidates,
  deriveExcerpt,
  excerptText,
  reconcileAnchors,
  selectAnchors,
} from '../anchors.js'
import { TokenEstimator } from '../estimate.js'
import {
  type FakeData,
  hasher,
  paragraphs,
  sampleWork,
  section,
  snapshotOf,
  tid,
} from './fixtures.js'

/**
 * Voice-anchor stratification (docs/06-context-engine.md §4.3): deterministic positional
 * selection, newest-section exclusion, paragraph-boundary cuts, and the per-excerpt
 * hash-mismatch re-derive that keeps its position.
 */

const est = new TokenEstimator()

function manyChapters(count: number, paragraphsPer = 6): FakeData {
  return {
    levelScheme: ['chapter'],
    sections: Array.from({ length: count }, (_, i) =>
      section({
        id: tid(i + 1),
        orderKey: `a${String(i).padStart(2, '0')}`,
        title: `Chapter ${i + 1}`,
        content: paragraphs(`chapter-${i + 1}`, paragraphsPer),
        short: `Short ${i + 1}.`,
      }),
    ),
    snippets: [],
    world: [],
    situation: '',
  }
}

describe('selectAnchors', () => {
  it('is deterministic: identical inputs produce identical excerpts', async () => {
    const snapshot = await snapshotOf(manyChapters(8))
    const h = await hasher()
    const a = selectAnchors(snapshot, 4000, est, h)
    const b = selectAnchors(snapshot, 4000, est, h)
    expect(a).toEqual(b)
    expect(a.length).toBeGreaterThan(0)
  })

  it('excludes the newest frozen leaf (its mood already adjoins the frontier)', async () => {
    const snapshot = await snapshotOf(manyChapters(5))
    const h = await hasher()
    const anchors = selectAnchors(snapshot, 4000, est, h)
    expect(anchors.every((a) => a.sectionId !== tid(5))).toBe(true)
  })

  it('picks at most 4 excerpts, stratified across the manuscript', async () => {
    const snapshot = await snapshotOf(manyChapters(12))
    const h = await hasher()
    const anchors = selectAnchors(snapshot, 4000, est, h)
    expect(anchors.length).toBe(4)
    // one per span: strictly increasing document position, no duplicates
    const ids = anchors.map((a) => a.sectionId)
    expect(new Set(ids).size).toBe(ids.length)
    const positions = ids.map((id) => snapshot.sections.findIndex((s) => s.id === id))
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })

  it('returns [] for a young work (0 or 1 frozen leaves)', async () => {
    const zero = await snapshotOf({ ...sampleWork(), sections: [] })
    const one = await snapshotOf(manyChapters(1))
    const h = await hasher()
    expect(selectAnchors(zero, 4000, est, h)).toEqual([])
    expect(selectAnchors(one, 4000, est, h)).toEqual([])
  })

  it('K = min(4, candidates): 3 candidates ⇒ 3 excerpts', async () => {
    const snapshot = await snapshotOf(manyChapters(4)) // 4 leaves − newest = 3 candidates
    const h = await hasher()
    expect(selectAnchors(snapshot, 4000, est, h)).toHaveLength(3)
  })
})

describe('deriveExcerpt', () => {
  it('takes the excerpt from the section START, cut at a paragraph boundary', async () => {
    const snapshot = await snapshotOf(manyChapters(3, 10))
    const h = await hasher()
    const sectionOne = snapshot.sectionById.get(tid(1))
    if (!sectionOne?.content) throw new Error('missing fixture')
    const excerpt = deriveExcerpt(sectionOne, 120, est, h) // spans ≥ 1 paragraph boundary
    expect(excerpt.start).toBe(0)
    expect(excerpt.end).toBeLessThan(sectionOne.content.length)
    const text = sectionOne.content.slice(excerpt.start, excerpt.end)
    // cut lands exactly before a paragraph separator
    expect(sectionOne.content.slice(excerpt.end, excerpt.end + 2)).toBe('\n\n')
    expect(excerpt.tokens).toBe(est.count(text))
    expect(excerpt.contentHash).toBe(h.hash(text))
  })

  it('keeps the whole content when it fits the size', async () => {
    const snapshot = await snapshotOf(manyChapters(2, 1))
    const h = await hasher()
    const s = snapshot.sectionById.get(tid(1))
    if (!s?.content) throw new Error('missing fixture')
    const excerpt = deriveExcerpt(s, 10_000, est, h)
    expect(excerpt.end).toBe(s.content.length)
  })
})

describe('reconcileAnchors — per-excerpt staleness (§4.3, §10)', () => {
  it('re-derives ONLY the edited excerpt, keeping its position; others byte-identical', async () => {
    const data = manyChapters(6)
    const snapshot = await snapshotOf(data)
    const h = await hasher()
    const anchors = selectAnchors(snapshot, 4000, est, h)
    expect(anchors.length).toBeGreaterThanOrEqual(3)
    const editedId = anchors[1]?.sectionId
    if (editedId === undefined) throw new Error('no second anchor')

    // user edits that section's opening
    const target = data.sections.find((s) => s.id === editedId)
    if (target === undefined) throw new Error('fixture')
    target.content = `A rewritten opening line.\n\n${target.content ?? ''}`
    const edited = await snapshotOf(data)

    const { excerpts, changed } = reconcileAnchors(anchors, edited, 4000, est, h)
    expect(changed).toBe(true)
    expect(excerpts).toHaveLength(anchors.length)
    // position kept
    expect(excerpts[1]?.sectionId).toBe(editedId)
    // the edited excerpt was re-derived against the new text
    expect(excerpts[1]?.contentHash).not.toBe(anchors[1]?.contentHash)
    expect(excerptText(excerpts[1] as NonNullable<(typeof excerpts)[1]>, edited)).toContain(
      'A rewritten opening line.',
    )
    // every other excerpt untouched, byte for byte
    for (const i of [0, 2]) {
      expect(excerpts[i]).toEqual(anchors[i])
    }
  })

  it('reports no change when nothing was edited', async () => {
    const snapshot = await snapshotOf(manyChapters(6))
    const h = await hasher()
    const anchors = selectAnchors(snapshot, 4000, est, h)
    const { excerpts, changed } = reconcileAnchors(anchors, snapshot, 4000, est, h)
    expect(changed).toBe(false)
    expect(excerpts).toEqual(anchors)
  })

  it('drops excerpts whose source section vanished', async () => {
    const data = manyChapters(6)
    const snapshot = await snapshotOf(data)
    const h = await hasher()
    const anchors = selectAnchors(snapshot, 4000, est, h)
    const goneId = anchors[0]?.sectionId
    data.sections = data.sections.filter((s) => s.id !== goneId)
    const after = await snapshotOf(data)
    const { excerpts, changed } = reconcileAnchors(anchors, after, 4000, est, h)
    expect(changed).toBe(true)
    expect(excerpts.length).toBe(anchors.length - 1)
    expect(excerpts.every((e) => e.sectionId !== goneId)).toBe(true)
  })
})

describe('anchorCandidates', () => {
  it('only frozen leaves with content qualify; interior sections never do', async () => {
    const data = sampleWork()
    data.sections.push(section({ id: tid(50), orderKey: 'zz', title: 'Interior' })) // no content
    const snapshot = await snapshotOf(data)
    const candidates = anchorCandidates(snapshot)
    expect(candidates.every((c) => c.content !== null)).toBe(true)
    expect(candidates.some((c) => c.id === tid(50))).toBe(false)
  })
})
