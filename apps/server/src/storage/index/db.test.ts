import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type AgentRunRow,
  INDEX_SCHEMA_VERSION,
  type IndexDb,
  needsRebuild,
  openIndex,
  readWorkCounts,
  type SectionRow,
  type SnippetRow,
} from './db.js'

// closeIndex was a dead product export; the tests keep the convenience inline.
function closeIndex(db: IndexDb): void {
  db.close()
}

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'cowrite-index-db-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function dbPath(): string {
  return path.join(dir, '.cowrite', 'index.sqlite')
}

function makeSection(id: string, orderKey: string, parentId: string | null = null): SectionRow {
  return {
    id,
    parentId,
    kind: 'chapter',
    orderKey,
    title: null,
    titleSource: 'agent',
    dirPath: `sections/010-x.${id.slice(-6).toLowerCase()}`,
    wordCount: 10,
    contentHash: 'xxh64:0000000000000000',
    frozenAt: null,
    shortSummaryStale: false,
    longSummaryStale: false,
    illustrationStale: false,
    illustrationHash: null,
    illustrationWidth: null,
    illustrationHeight: null,
    shortSummary: null,
    longSummary: null,
  }
}

function makeSnippet(id: string, orderKey: string): SnippetRow {
  return {
    id,
    orderKey,
    authorship: 'user',
    originRunId: null,
    rev: 1,
    revisionCount: 1,
    wordCount: 5,
    updatedAt: '2026-07-06T00:00:00Z',
    filePath: `frontier/snippets/010.${id.slice(-6).toLowerCase()}.md`,
  }
}

const RUN_A = '01J2KF0000000000000000RNA1'
const RUN_B = '01J2KF0000000000000000RNB2'
const SNIP = '01J2KF0000000000000000SN01'

function makeRun(id: string, lane: 'high' | 'low', promptTokens: number | null): AgentRunRow {
  return {
    id,
    kind: 'continue',
    lane,
    model: 'glm-5',
    startedAt: '2026-07-06T14:00:00Z',
    endedAt: promptTokens === null ? null : '2026-07-06T14:01:00Z',
    status: promptTokens === null ? null : 'ok',
    promptTokens,
    completionTokens: promptTokens === null ? null : 100,
    usageEstimated: promptTokens === null ? null : 0,
    filePath: `runs/2026-07/${id}.jsonl`,
  }
}

describe('openIndex / closeIndex / needsRebuild', () => {
  it('creates the §7.1 schema at the current user_version in WAL mode', () => {
    const db = openIndex(dbPath())
    expect(db.handle.pragma('user_version', { simple: true })).toBe(INDEX_SCHEMA_VERSION)
    expect(db.handle.pragma('journal_mode', { simple: true })).toBe('wal')
    const names = (
      db.handle
        .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index') ORDER BY name")
        .all() as Array<{ name: string }>
    ).map((r) => r.name)
    for (const expected of [
      'meta',
      'files',
      'sections',
      'snippets',
      'world_entries',
      'world_keys',
      'agent_runs',
      'run_artifacts',
      'fts',
      'ix_sections_tree',
      'ix_snippets_order',
      'ix_world_keys',
      'ix_artifacts_by_target',
    ]) {
      expect(names).toContain(expected)
    }
    closeIndex(db)
  })

  it('reopens an existing database without touching its contents', () => {
    const first = openIndex(dbPath())
    first.setMeta('workId', 'w1')
    closeIndex(first)
    const second = openIndex(dbPath())
    expect(second.getMeta('workId')).toBe('w1')
    closeIndex(second)
  })

  it('needsRebuild: missing file', () => {
    expect(needsRebuild(dbPath())).toBe(true)
  })

  it('needsRebuild: healthy database → false', () => {
    closeIndex(openIndex(dbPath()))
    expect(needsRebuild(dbPath())).toBe(false)
  })

  it('needsRebuild: user_version mismatch → true, and openIndex refuses it', () => {
    const db = openIndex(dbPath())
    db.handle.pragma(`user_version = ${INDEX_SCHEMA_VERSION + 1}`)
    closeIndex(db)
    expect(needsRebuild(dbPath())).toBe(true)
    expect(() => openIndex(dbPath())).toThrow(/schema version/)
  })

  it('needsRebuild: corrupt (non-SQLite) file → true', async () => {
    const p = dbPath()
    await mkdir(path.dirname(p), { recursive: true })
    await writeFile(p, 'this is definitely not a sqlite database, not even close')
    expect(needsRebuild(p)).toBe(true)
  })
})

describe('query API', () => {
  let db: IndexDb

  beforeEach(() => {
    db = openIndex(dbPath())
  })

  afterEach(() => {
    closeIndex(db)
  })

  it('meta get/set round-trips and returns null when absent', () => {
    expect(db.getMeta('workId')).toBeNull()
    db.setMeta('workId', 'abc')
    db.setMeta('workId', 'def')
    expect(db.getMeta('workId')).toBe('def')
  })

  it('transaction rolls back on throw', () => {
    expect(() =>
      db.transaction(() => {
        db.setMeta('a', '1')
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(db.getMeta('a')).toBeNull()
  })

  it('listSectionRows orders by (parent_id, order_key), ULID tie-break', () => {
    const root1 = '01J2KF0000000000000000SC02'
    const root2 = '01J2KF0000000000000000SC01'
    const child = '01J2KF0000000000000000SC03'
    db.upsertSection(makeSection(root1, 'a1'))
    db.upsertSection(makeSection(root2, 'a0'))
    db.upsertSection(makeSection(child, 'a0', root1))
    expect(db.listSectionRows().map((r) => r.id)).toEqual([root2, root1, child])
    // upsert replaces in place
    db.upsertSection({ ...makeSection(root2, 'a0'), wordCount: 99 })
    expect(db.getSection(root2)?.wordCount).toBe(99)
    expect(db.listSectionRows()).toHaveLength(3)
  })

  it('round-trips the inlined summary text columns (schema v2)', () => {
    const id = '01J2KF0000000000000000SC09'
    db.upsertSection({
      ...makeSection(id, 'a0'),
      shortSummary: 'A short one.\n',
      longSummary: 'A longer one.\n',
    })
    const row = db.getSection(id)
    expect(row?.shortSummary).toBe('A short one.\n')
    expect(row?.longSummary).toBe('A longer one.\n')
    expect(db.listSectionRows()[0]?.shortSummary).toBe('A short one.\n')
  })

  it('workCounts matches readWorkCounts (one shared aggregate encoding)', () => {
    db.upsertSection(makeSection('01J2KF0000000000000000SC01', 'a0')) // wordCount 10
    db.upsertSnippet(makeSnippet('01J2KF0000000000000000SN0A', 'a0')) // wordCount 5
    db.upsertWorldEntry(
      {
        id: '01J2KF0000000000000000WD01',
        name: 'Mara',
        shortSummary: null,
        imagePath: null,
        filePath: 'world/entries/mara.wd01.md',
        updatedAt: '2026-07-09T00:00:00Z',
      },
      [],
    )
    const live = db.workCounts()
    expect(live).toEqual({
      snippetCount: 1,
      sectionCount: 1,
      wordCount: 15,
      updatedAt: '2026-07-09T00:00:00Z',
    })
    expect(readWorkCounts(dbPath())).toEqual(live)
  })

  it('staleSections returns only rows with a stale flag set', () => {
    const fresh = '01J2KF0000000000000000SC04'
    const stale = '01J2KF0000000000000000SC05'
    db.upsertSection(makeSection(fresh, 'a0'))
    db.upsertSection({ ...makeSection(stale, 'a1'), illustrationStale: true })
    expect(db.staleSections().map((r) => r.id)).toEqual([stale])
    expect(db.staleSections()[0]?.illustrationStale).toBe(true)
  })

  it("staleSections('summary') is the sweep's queue: leaf rows with stale summaries only", () => {
    const summaryStale = '01J2KF0000000000000000SC06'
    const illustrationOnly = '01J2KF0000000000000000SC07'
    const interior = '01J2KF0000000000000000SC08'
    db.upsertSection({ ...makeSection(summaryStale, 'a0'), longSummaryStale: true })
    db.upsertSection({ ...makeSection(illustrationOnly, 'a1'), illustrationStale: true })
    db.upsertSection({
      ...makeSection(interior, 'a2'),
      contentHash: null, // interior sections carry no summaries
      shortSummaryStale: true,
    })
    expect(db.staleSections('summary').map((r) => r.id)).toEqual([summaryStale])
    // 'any' still surfaces every stale flag (the Stage-5 sweep's superset view)
    expect(db.staleSections('any').map((r) => r.id)).toEqual([
      summaryStale,
      illustrationOnly,
      interior,
    ])
  })

  it('listSnippetRows orders by order_key', () => {
    const a = '01J2KF0000000000000000SN0A'
    const b = '01J2KF0000000000000000SN0B'
    db.upsertSnippet(makeSnippet(a, 'a1'))
    db.upsertSnippet(makeSnippet(b, 'a0'))
    expect(db.listSnippetRows().map((r) => r.id)).toEqual([b, a])
  })

  it('world entries: keys replaced on upsert; matchWorldKeys is case-insensitive', () => {
    const entry = {
      id: '01J2KF0000000000000000WD01',
      name: 'Mara Voss',
      shortSummary: null,
      imagePath: null,
      filePath: 'world/entries/mara.wd01.md',
      updatedAt: '2026-07-01T00:00:00Z',
    }
    db.upsertWorldEntry(entry, ['Mara', 'Voss'])
    expect(db.matchWorldKeys(['MARA', 'nobody'])).toEqual([{ entryId: entry.id, key: 'Mara' }])
    db.upsertWorldEntry(entry, ['the keeper'])
    expect(db.matchWorldKeys(['voss'])).toEqual([])
    expect(db.matchWorldKeys(['THE KEEPER'])).toEqual([{ entryId: entry.id, key: 'the keeper' }])
    expect(db.matchWorldKeys([])).toEqual([])
    expect(db.worldKeys(entry.id)).toEqual(['the keeper'])
    db.deleteWorldEntry(entry.id)
    expect(db.listWorldEntryRows()).toEqual([])
    expect(db.worldKeys(entry.id)).toEqual([])
  })

  it('runs: artifacts replaced on upsert; runsByArtifact and usageByLane aggregate', () => {
    db.upsertRun(makeRun(RUN_A, 'high', 1000), [
      { runId: RUN_A, artifactKind: 'snippet', artifactId: SNIP, rev: 1, state: 'committed' },
      {
        runId: RUN_A,
        artifactKind: 'snippet-revision',
        artifactId: SNIP,
        rev: 2,
        state: 'conflict',
      },
    ])
    db.upsertRun(makeRun(RUN_B, 'low', null), [])

    const bySnippet = db.runsByArtifact('snippet', SNIP)
    expect(bySnippet).toHaveLength(1)
    expect(bySnippet[0]?.runId).toBe(RUN_A)
    expect(bySnippet[0]?.rev).toBe(1)
    expect(bySnippet[0]?.artifactState).toBe('committed')

    // re-ingest with fewer artifacts: old rows must not linger
    db.upsertRun(makeRun(RUN_A, 'high', 1000), [
      { runId: RUN_A, artifactKind: 'snippet', artifactId: SNIP, rev: 1, state: 'committed' },
    ])
    expect(db.runsByArtifact('snippet-revision', SNIP)).toEqual([])

    const usage = db.usageByLane()
    expect(usage).toEqual([
      { lane: 'high', kind: 'continue', runs: 1, promptTokens: 1000, completionTokens: 100 },
      { lane: 'low', kind: 'continue', runs: 1, promptTokens: 0, completionTokens: 0 },
    ])

    db.deleteRun(RUN_A)
    expect(db.runsByArtifact('snippet', SNIP)).toEqual([])
    expect(db.listRunRows().map((r) => r.id)).toEqual([RUN_B])
  })

  it('fts: setFts replaces, ftsSearch matches title+body only, hostile input is quoted', () => {
    db.setFts('section', 'S1', 'The Storm', 'waves crashed on the pier')
    db.setFts('world', 'W1', 'Mara', 'keeper of the light')
    expect(db.ftsSearch('storm').map((h) => h.entityId)).toEqual(['S1'])
    expect(db.ftsSearch('keeper').map((h) => h.entityId)).toEqual(['W1'])
    // 'section' only appears in the kind column, which the search must not match
    expect(db.ftsSearch('section')).toEqual([])
    // FTS5 operators arrive quoted, not executed
    expect(db.ftsSearch('AND NOT ( " )')).toEqual([])
    expect(db.ftsSearch('   ')).toEqual([])
    db.setFts('section', 'S1', 'The Calm', 'still water')
    expect(db.ftsSearch('storm')).toEqual([])
    expect(db.ftsSearch('calm').map((h) => h.entityId)).toEqual(['S1'])
    db.deleteFts('section', 'S1')
    expect(db.ftsSearch('calm')).toEqual([])
  })

  it('files: upsert/get/delete/list round-trip', () => {
    const row = { path: 'work.json', size: 10, mtimeMs: 123, xxh64: 'xxh64:00000000000000ff' }
    db.upsertFile(row)
    expect(db.getFile('work.json')).toEqual(row)
    db.upsertFile({ ...row, size: 11 })
    expect(db.listFileRows()).toEqual([{ ...row, size: 11 }])
    db.deleteFile('work.json')
    expect(db.getFile('work.json')).toBeNull()
  })
})

describe('readWorkCounts (works-list, read-only, no lock)', () => {
  it('returns null for a missing index and for a foreign schema version', () => {
    expect(readWorkCounts(dbPath())).toBeNull()
    const db = openIndex(dbPath())
    db.handle.pragma(`user_version = ${INDEX_SCHEMA_VERSION + 1}`)
    closeIndex(db)
    expect(readWorkCounts(dbPath())).toBeNull()
  })

  it('aggregates counts, word totals and max(updated_at) across snippets ∪ world', () => {
    const db = openIndex(dbPath())
    db.upsertSection(makeSection('01J2KF0000000000000000SC01', 'a0')) // wordCount 10
    db.upsertSnippet(makeSnippet('01J2KF0000000000000000SN0A', 'a0')) // wordCount 5
    db.upsertSnippet(makeSnippet('01J2KF0000000000000000SN0B', 'a1')) // wordCount 5
    db.upsertWorldEntry(
      {
        id: '01J2KF0000000000000000WD01',
        name: 'Mara',
        shortSummary: null,
        imagePath: null,
        filePath: 'world/entries/mara.wd01.md',
        updatedAt: '2026-07-09T00:00:00Z', // later than the snippets' updated_at
      },
      [],
    )
    closeIndex(db)
    expect(readWorkCounts(dbPath())).toEqual({
      snippetCount: 2,
      sectionCount: 1,
      wordCount: 20,
      updatedAt: '2026-07-09T00:00:00Z',
    })
  })

  it('answers while a writer connection holds the WAL database open', () => {
    const writer = openIndex(dbPath())
    try {
      writer.upsertSnippet(makeSnippet('01J2KF0000000000000000SN0C', 'a0'))
      const counts = readWorkCounts(dbPath())
      expect(counts?.snippetCount).toBe(1)
      expect(counts?.updatedAt).toBe('2026-07-06T00:00:00Z')
    } finally {
      closeIndex(writer)
    }
  })

  it('reads null updatedAt from an empty index', () => {
    closeIndex(openIndex(dbPath()))
    expect(readWorkCounts(dbPath())).toEqual({
      snippetCount: 0,
      sectionCount: 0,
      wordCount: 0,
      updatedAt: null,
    })
  })
})
