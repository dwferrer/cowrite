import { describe, expect, it } from 'vitest'
import {
  BoundaryProposal,
  ConsolidatedSnippet,
  SectionContent,
  SectionContentPatch,
  SectionMeta,
  SectionRow,
  SummariesUpdate,
} from './section.js'

const sectionId = '01J2KF3M8QAB4CD5W0ZNXGT7R9'
const runId = '01J2P5H8A3N1Y7S4QE2GBV6MKD'
const snippetId = '01J2P4M9X1QAB4CD5W0ZNXGT7R'

const enrichment = {
  source: 'agent',
  runId,
  generatedAt: '2026-07-05T22:12:00Z',
  sourceHash: 'xxh64:0123456789abcdef',
} as const

const illustrationMeta = {
  source: 'agent',
  runId,
  generatedAt: '2026-07-05T22:20:00Z',
  sourceHash: 'xxh64:0123456789abcdef',
  sourceWordCount: 4100,
  entities: ['01J2N8W2KQ7F3AKQY9C4MHT6VP'],
  prompt: 'A lighthouse keeper braces against a rising storm, oil painting',
  workflow: 'default',
  workflowHash: 'xxh64:fedcba9876543210',
  seed: 42,
  attempts: 2,
  score: 8.5,
  guidance: null,
} as const

const baseSection = {
  schemaVersion: 1,
  id: sectionId,
  kind: 'chapter',
  orderKey: 'a1',
  title: 'The Storm Glass',
  titleSource: 'agent',
  frozenAt: '2026-07-05T22:10:00Z',
  contentHash: 'xxh64:0123456789abcdef',
  enrichments: {
    shortSummary: enrichment,
    longSummary: enrichment,
    illustration: null,
  },
} as const

describe('SectionMeta', () => {
  it('accepts all three illustration slot states', () => {
    // absent
    expect(SectionMeta.parse(baseSection).enrichments.illustration).toBeNull()
    // present
    const withImage = SectionMeta.parse({
      ...baseSection,
      enrichments: { ...baseSection.enrichments, illustration: illustrationMeta },
    })
    expect(withImage.enrichments.illustration).toEqual(illustrationMeta)
    // tombstone
    const tombstone = { suppressed: true, deletedAt: '2026-07-06T10:00:00Z' }
    const suppressed = SectionMeta.parse({
      ...baseSection,
      enrichments: { ...baseSection.enrichments, illustration: tombstone },
    })
    expect(suppressed.enrichments.illustration).toEqual(tombstone)
  })

  it('accepts an interior section (null contentHash, null enrichment metas)', () => {
    const interior = SectionMeta.parse({
      ...baseSection,
      contentHash: null,
      frozenAt: null,
      title: null,
      enrichments: { shortSummary: null, longSummary: null, illustration: null },
    })
    expect(interior.contentHash).toBeNull()
  })

  it('defaults titleSource to agent and rejects a bad hash', () => {
    const { titleSource: _omitted, ...withoutTitleSource } = baseSection
    expect(SectionMeta.parse(withoutTitleSource).titleSource).toBe('agent')
    expect(SectionMeta.safeParse({ ...baseSection, contentHash: 'not-a-hash' }).success).toBe(false)
  })
})

describe('ConsolidatedSnippet', () => {
  it('round-trips a history.jsonl line (02 §6.4 shape)', () => {
    const line = {
      type: 'consolidated',
      snippetId,
      orderKey: 'a0',
      authorship: 'mixed',
      originRunId: runId,
      finalRev: 3,
      finalText: 'Mara pressed her palm against the storm glass...',
      revisionRunIds: [runId, '01J2P7Q4V2M8Z6T1RD5FCW9XKB'],
      consolidatedAt: '2026-07-05T22:10:00Z',
      boundaryRunId: runId,
    } as const
    expect(ConsolidatedSnippet.parse(line)).toEqual(line)
    // heuristic break: null boundaryRunId is legal
    expect(ConsolidatedSnippet.parse({ ...line, boundaryRunId: null }).boundaryRunId).toBeNull()
  })

  it('rejects finalRev 0 and a wrong type tag', () => {
    const line = {
      type: 'consolidated',
      snippetId,
      orderKey: 'a0',
      authorship: 'user',
      originRunId: null,
      finalRev: 0,
      finalText: '',
      revisionRunIds: [],
      consolidatedAt: '2026-07-05T22:10:00Z',
      boundaryRunId: null,
    }
    expect(ConsolidatedSnippet.safeParse(line).success).toBe(false)
    expect(ConsolidatedSnippet.safeParse({ ...line, finalRev: 1, type: 'revision' }).success).toBe(
      false,
    )
  })
})

describe('BoundaryProposal', () => {
  it('accepts zero or more boundaries', () => {
    expect(BoundaryProposal.parse({ boundaries: [] }).boundaries).toEqual([])
    const proposal = BoundaryProposal.parse({
      boundaries: [{ afterSnippetId: snippetId, kind: 'chapter', title: 'The Storm Glass' }],
    })
    expect(proposal.boundaries).toHaveLength(1)
  })

  it('rejects a boundary with an invalid snippet id (agent garbage is Zod-gated, 02 §12)', () => {
    const bad = { boundaries: [{ afterSnippetId: 'snippet-7', kind: 'chapter', title: 'X' }] }
    expect(BoundaryProposal.safeParse(bad).success).toBe(false)
  })
})

describe('SectionRow (03 §3.2 / 04 §4.5 DTO)', () => {
  const row = {
    id: sectionId,
    parentId: null,
    kind: 'chapter',
    orderKey: 'a1',
    title: 'The Ferry',
    titleSource: 'agent',
    isLeaf: true,
    wordCount: 3200,
    contentHash: 'xxh64:0123456789abcdef',
    shortSummary: 'Mara crosses at night; the glass cracks.',
    longSummary: null, // scene-level: lazy via GET …/summaries
    illustration: { version: 'xxh64:fedcba9876543210', width: 1024, height: 640 },
    stale: { short: false, long: true, illustration: false },
  }

  it('round-trips a leaf row with a nested illustration descriptor', () => {
    expect(SectionRow.parse(row)).toEqual(row)
  })

  it('illustration null = none, including user-suppressed', () => {
    expect(SectionRow.parse({ ...row, illustration: null }).illustration).toBeNull()
  })

  it('requires the full stale-flags object', () => {
    expect(SectionRow.safeParse({ ...row, stale: { short: false } }).success).toBe(false)
    expect(
      SectionRow.safeParse({ ...row, illustration: { version: 'v1', width: 1024 } }).success,
    ).toBe(false)
  })
})

describe('SectionContent / SummariesUpdate', () => {
  it('content carries the optimistic-concurrency hash both ways', () => {
    const content = { markdown: '# Ch. 7\n\nMara…', contentHash: 'xxh64:0123456789abcdef' }
    expect(SectionContent.parse(content)).toEqual(content)
    expect(
      SectionContentPatch.parse({ markdown: 'new text', baseHash: 'xxh64:0123456789abcdef' })
        .baseHash,
    ).toBe('xxh64:0123456789abcdef')
    expect(SectionContentPatch.safeParse({ markdown: 'new text' }).success).toBe(false)
  })

  it('summaries update is partial: either side may be omitted', () => {
    expect(SummariesUpdate.parse({})).toEqual({})
    expect(SummariesUpdate.parse({ short: 'A tighter hook.' }).long).toBeUndefined()
  })
})
