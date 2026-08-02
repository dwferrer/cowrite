import type { SectionRow, SnippetDto } from '@cowrite/shared'
import { describe, expect, it } from 'vitest'
import { buildBlocks, countWords, estimateBlockSize } from './useDocBlocks.js'

const U = (n: number) => `01ARZ3NDEKTSV4RRFFQ69G5F${String(n).padStart(2, '0')}`

function chapter(n: number, overrides: Partial<SectionRow> = {}): SectionRow {
  return {
    id: U(n),
    parentId: null,
    kind: 'chapter',
    orderKey: `a${n}`,
    title: null,
    titleSource: 'agent',
    isLeaf: true,
    wordCount: 1_000,
    contentHash: 'c'.repeat(64),
    shortSummary: null,
    longSummary: null,
    illustration: null,
    stale: { short: false, long: false, illustration: false },
    ...overrides,
  }
}

function snippet(n: number, overrides: Partial<SnippetDto> = {}): SnippetDto {
  return {
    id: U(50 + n),
    orderKey: `b${n}`,
    text: 'She crossed at night.',
    rev: 1,
    authorship: 'user',
    originRunId: null,
    updatedAt: '2026-08-01T12:00:00.000Z',
    revisionCount: 1,
    ...overrides,
  }
}

describe('buildBlocks', () => {
  it('flattens sections (header + body) then snippets then the frontier bar', () => {
    const sections = [chapter(1, { title: 'The Ferry' }), chapter(2)]
    const snippets = [snippet(2), snippet(1)] // out of order — must sort by orderKey
    const blocks = buildBlocks(sections, snippets, {})
    expect(
      blocks.map((b) => ({
        kind: b.kind,
        key: b.key,
        ...('fold' in b ? { fold: b.fold } : {}),
        ...(b.kind === 'sectionHeader' ? { ordinal: b.ordinal } : {}),
      })),
    ).toMatchSnapshot()
  })

  it('renders every leaf at full while no summaries exist (Stage 2 graceful degradation)', () => {
    const sections = Array.from({ length: 20 }, (_, i) => chapter(i + 1))
    const blocks = buildBlocks(sections, [], {})
    const bodies = blocks.filter((b) => b.kind === 'sectionBody')
    expect(bodies).toHaveLength(20)
    for (const b of bodies) {
      if (b.kind === 'sectionBody') expect(b.fold).toBe('full')
    }
    expect(blocks.some((b) => b.kind === 'nameCard')).toBe(false)
  })

  it('applies the fold ladder once summaries exist, and header/body stay separate blocks', () => {
    const sections = Array.from({ length: 16 }, (_, i) =>
      chapter(i + 1, { shortSummary: 'short.', longSummary: 'long.' }),
    )
    const blocks = buildBlocks(sections, [], {})
    const folds = blocks
      .filter((b) => b.kind === 'sectionHeader')
      .map((b) => ('fold' in b ? b.fold : null))
    // 16 leaves: d=15..0 → 2 name / 8 short / 4 long / 2 full
    expect(folds).toEqual([
      'name',
      'name',
      'short',
      'short',
      'short',
      'short',
      'short',
      'short',
      'short',
      'short',
      'long',
      'long',
      'long',
      'long',
      'full',
      'full',
    ])
    // fold name ⇒ nameCard, others ⇒ sectionBody
    expect(blocks.filter((b) => b.kind === 'nameCard')).toHaveLength(2)
    expect(blocks.filter((b) => b.kind === 'sectionBody')).toHaveLength(14)
  })

  it('honors fold pins (overrides) per section', () => {
    const sections = [
      chapter(1, { shortSummary: 'short.', longSummary: 'long.' }),
      chapter(2, { shortSummary: 'short.', longSummary: 'long.' }),
    ]
    const blocks = buildBlocks(sections, [], { [U(2)]: 'name' })
    const pinned = blocks.find((b) => b.kind === 'sectionHeader' && b.section.id === U(2))
    expect(pinned && 'fold' in pinned ? pinned.fold : null).toBe('name')
    expect(blocks.some((b) => b.kind === 'nameCard' && b.section.id === U(2))).toBe(true)
  })

  it('emits headers for interior sections and indents children by depth', () => {
    const part = chapter(1, { id: U(40), isLeaf: false, kind: 'part', orderKey: 'a0' })
    const child = chapter(2, { parentId: U(40) })
    const blocks = buildBlocks([part, child], [], {})
    const headers = blocks.filter((b) => b.kind === 'sectionHeader')
    expect(headers).toHaveLength(2)
    expect(headers[0] && 'depth' in headers[0] ? headers[0].depth : null).toBe(0)
    expect(headers[1] && 'depth' in headers[1] ? headers[1].depth : null).toBe(1)
    // interior sections emit only a header, never a body
    expect(blocks.some((b) => b.kind === 'sectionBody' && b.section.id === U(40))).toBe(false)
  })

  it('always ends with the frontier bar', () => {
    const blocks = buildBlocks([], [], {})
    expect(blocks.at(-1)?.kind).toBe('frontierBar')
  })
})

describe('estimateBlockSize', () => {
  it('sizes snippets by word count at 11 words/line', () => {
    const s = snippet(1, { text: Array.from({ length: 22 }, () => 'word').join(' ') })
    expect(estimateBlockSize({ kind: 'snippet', key: 's:x', snippet: s })).toBe(72 + 2 * 28)
  })

  it('uses fixed sizes for chrome blocks', () => {
    expect(estimateBlockSize({ kind: 'frontierBar', key: 'frontier' })).toBe(88)
    expect(estimateBlockSize({ kind: 'nameCard', key: 'n:x', section: chapter(1) })).toBe(96)
  })
})

describe('countWords', () => {
  it('counts whitespace-separated tokens', () => {
    expect(countWords('')).toBe(0)
    expect(countWords('  a  b\nc ')).toBe(3)
  })
})
