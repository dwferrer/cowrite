import { describe, expect, it } from 'vitest'
import { RevisionEvent, SnippetMeta } from './snippet.js'

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
