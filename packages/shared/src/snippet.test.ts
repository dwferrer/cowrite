import { describe, expect, it } from 'vitest'
import {
  EditingSignal,
  RestoreReq,
  RevisionEvent,
  SnippetCreate,
  SnippetDto,
  SnippetMeta,
  SnippetPatch,
} from './snippet.js'

// 02 §5.4 — frontier/snippets/030.t5w0zn.md frontmatter
const snippetSample = {
  id: '01J2P7R9GT5W0ZNXK3M8QAB4CD',
  orderKey: 'a2',
  createdAt: '2026-07-06T14:02:11Z',
  updatedAt: '2026-07-06T14:02:11Z',
  authorship: 'agent',
  originRunId: '01J2P7Q4V2M8Z6T1RD5FCW9XKB',
  rev: 1,
} as const

// 02 §5.4 — frontier/revisions/<id>.jsonl line
const revisionSample = {
  type: 'revision',
  rev: 1,
  ts: '2026-07-06T14:02:11Z',
  author: 'agent',
  runId: '01J2P7Q4V2M8Z6T1RD5FCW9XKB',
  text: 'Mara pressed her palm against the storm glass...',
} as const

describe('SnippetMeta', () => {
  it('round-trips the §5.4 frontmatter sample', () => {
    expect(SnippetMeta.parse(snippetSample)).toEqual(snippetSample)
  })

  it('accepts a user-typed snippet with a null originRunId', () => {
    const parsed = SnippetMeta.parse({
      ...snippetSample,
      authorship: 'user',
      originRunId: null,
      rev: 3,
    })
    expect(parsed.originRunId).toBeNull()
    expect(parsed.authorship).toBe('user')
  })

  it('rejects rev 0, unknown authorship, and a bad orderKey', () => {
    expect(SnippetMeta.safeParse({ ...snippetSample, rev: 0 }).success).toBe(false)
    expect(SnippetMeta.safeParse({ ...snippetSample, authorship: 'bot' }).success).toBe(false)
    expect(SnippetMeta.safeParse({ ...snippetSample, orderKey: 'A2' }).success).toBe(false)
  })
})

describe('RevisionEvent', () => {
  it('round-trips the §5.4 revision line', () => {
    expect(RevisionEvent.parse(revisionSample)).toEqual(revisionSample)
  })

  it('accepts a user revision without a runId', () => {
    const parsed = RevisionEvent.parse({
      type: 'revision',
      rev: 2,
      ts: '2026-07-06T15:00:00Z',
      author: 'user',
      text: 'Mara pressed both palms against the storm glass...',
    })
    expect(parsed.runId).toBeUndefined()
  })

  it('rejects a mixed author (only user | agent write revisions)', () => {
    expect(RevisionEvent.safeParse({ ...revisionSample, author: 'mixed' }).success).toBe(false)
  })
})

describe('SnippetDto (03 §3.3 / 04 §4.5)', () => {
  const dto = {
    id: snippetSample.id,
    orderKey: 'a2',
    text: 'Mara pressed her palm against the storm glass...',
    rev: 3,
    authorship: 'mixed',
    originRunId: snippetSample.originRunId,
    updatedAt: '2026-07-06T15:00:00Z',
    revisionCount: 3,
  }

  it('round-trips with full text and revisionCount', () => {
    expect(SnippetDto.parse(dto)).toEqual(dto)
  })

  it('requires revisionCount (index column, no extra fetch)', () => {
    const { revisionCount: _dropped, ...withoutCount } = dto
    expect(SnippetDto.safeParse(withoutCount).success).toBe(false)
  })
})

describe('snippet write requests', () => {
  it('SnippetCreate: default append; optional afterSnippetId for mid-frontier insert', () => {
    expect(SnippetCreate.parse({ text: 'A new passage.' }).afterSnippetId).toBeUndefined()
    expect(
      SnippetCreate.parse({ text: 'x', afterSnippetId: snippetSample.id }).afterSnippetId,
    ).toBe(snippetSample.id)
    expect(SnippetCreate.safeParse({ text: '' }).success).toBe(false)
  })

  it('SnippetPatch: one call = one revision, guarded by baseRev', () => {
    expect(SnippetPatch.parse({ text: 'revised', baseRev: 2 }).baseRev).toBe(2)
    expect(SnippetPatch.safeParse({ text: 'revised' }).success).toBe(false)
    expect(SnippetPatch.safeParse({ text: 'revised', baseRev: 0 }).success).toBe(false)
  })

  it('RestoreReq names the revision to re-append; EditingSignal clears with null', () => {
    expect(RestoreReq.parse({ rev: 2 }).rev).toBe(2)
    expect(RestoreReq.safeParse({ rev: 0 }).success).toBe(false)
    expect(EditingSignal.parse({ snippetId: null }).snippetId).toBeNull()
    expect(EditingSignal.parse({ snippetId: snippetSample.id }).snippetId).toBe(snippetSample.id)
  })
})
