import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type IndexDb, needsRebuild, openIndex } from './db.js'
import {
  buildFixtureWork,
  FIX,
  type FixtureInfo,
  GLASS_FILE,
  MARA_FILE,
  SEC1_DIR,
  SEC2_DIR,
  SNIP1_FILE,
} from './fixture.js'
import { fullRebuild, type RebuildStats } from './scan.js'

/** Golden-directory test (spec 02 §12): fixture work dir in → expected index rows out. */
describe('fullRebuild', () => {
  let root: string
  let workDir: string
  let db: IndexDb
  let fix: FixtureInfo
  let stats: RebuildStats

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'cowrite-scan-'))
    fix = await buildFixtureWork(root)
    workDir = fix.workDir
    db = openIndex(path.join(workDir, '.cowrite', 'index.sqlite'))
    stats = await fullRebuild(db, workDir)
  })

  afterAll(async () => {
    db.close()
    await rm(root, { recursive: true, force: true })
  })

  it('reports scan stats and leaves a healthy database', () => {
    expect(stats).toEqual({ files: 21, sections: 2, snippets: 3, worldEntries: 2, runs: 2 })
  })

  it('writes the meta rows: workId, levelScheme, situationHash, lastScanAt', () => {
    expect(db.getMeta('workId')).toBe(FIX.workId)
    expect(JSON.parse(db.getMeta('levelScheme') ?? 'null')).toEqual(['chapter'])
    expect(db.getMeta('situationHash')).toBe(fix.situationHash)
    expect(db.getMeta('lastScanAt')).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('indexes sections with §6.5-derived staleness', () => {
    const rows = db.listSectionRows()
    expect(rows.map((r) => r.id)).toEqual([FIX.sec1, FIX.sec2])

    const sec1 = rows[0]
    expect(sec1?.parentId).toBeNull()
    expect(sec1?.kind).toBe('chapter')
    expect(sec1?.orderKey).toBe('a0')
    expect(sec1?.title).toBe('The Lighthouse Keeper')
    expect(sec1?.titleSource).toBe('agent')
    expect(sec1?.dirPath).toBe(`sections/${SEC1_DIR}`)
    expect(sec1?.wordCount).toBe(fix.sec1WordCount)
    expect(sec1?.contentHash).toBe(fix.sec1ContentHash)
    expect(sec1?.frozenAt).toBe('2026-07-01T00:00:00Z')
    // user-edited summary at the current hash: NOT stale until the prose changes
    expect(sec1?.shortSummaryStale).toBe(false)
    // agent summary with a mismatched sourceHash: stale
    expect(sec1?.longSummaryStale).toBe(true)
    // agent illustration at the current word count: fresh
    expect(sec1?.illustrationStale).toBe(false)
    expect(sec1?.illustrationHash).toMatch(/^xxh64:[0-9a-f]{16}$/)
    expect(sec1?.illustrationWidth).toBe(640)
    expect(sec1?.illustrationHeight).toBe(480)
    // summary text is inlined into the row (schema v2) so reads skip the files
    expect(sec1?.shortSummary).toBe('Keeper watches the harbor.\n')
    expect(sec1?.longSummary).toBe('A longer summary of chapter one.\n')

    const sec2 = rows[1]
    expect(sec2?.titleSource).toBe('user')
    expect(sec2?.contentHash).toBe(fix.sec2ContentHash)
    // missing enrichments on a frozen leaf: stale
    expect(sec2?.shortSummaryStale).toBe(true)
    expect(sec2?.longSummaryStale).toBe(true)
    // suppressed tombstone: never stale, even with no PNG on disk
    expect(sec2?.illustrationStale).toBe(false)
    expect(sec2?.illustrationHash).toBeNull()
    expect(sec2?.illustrationWidth).toBeNull()
    expect(sec2?.shortSummary).toBeNull() // no summary files on sec2
    expect(sec2?.longSummary).toBeNull()

    expect(db.staleSections().map((r) => r.id)).toEqual([FIX.sec1, FIX.sec2])
  })

  it('indexes frontier snippets in order with revision counts from the logs', () => {
    const rows = db.listSnippetRows()
    expect(rows.map((r) => r.id)).toEqual([FIX.snip1, FIX.snip2, FIX.snip3])
    expect(rows.map((r) => r.orderKey)).toEqual(['a0', 'a1', 'a2'])
    expect(rows.map((r) => r.revisionCount)).toEqual([3, 1, 1])
    expect(rows.map((r) => r.rev)).toEqual([3, 1, 1])
    expect(rows.map((r) => r.authorship)).toEqual(['mixed', 'user', 'agent'])
    expect(rows.map((r) => r.originRunId)).toEqual([FIX.run1, null, FIX.run1])
    expect(rows[0]?.filePath).toBe(`frontier/snippets/${SNIP1_FILE}`)
    expect(rows[0]?.wordCount).toBe(15)
    expect(rows[0]?.updatedAt).toBe('2026-07-06T13:40:00Z')
  })

  it('indexes world entries and one row per alias key (COLLATE NOCASE)', () => {
    const rows = db.listWorldEntryRows()
    expect(rows.map((r) => r.id)).toEqual([FIX.mara, FIX.glass])
    expect(rows[0]?.name).toBe('Mara Voss')
    expect(rows[0]?.imagePath).toBe(`../images/${FIX.mara}.png`)
    expect(rows[0]?.filePath).toBe(`world/entries/${MARA_FILE}`)
    expect(rows[0]?.shortSummary).toBe('Lighthouse keeper of Cinder Point.')
    expect(rows[1]?.imagePath).toBeNull()

    expect(db.worldKeys(FIX.mara).sort()).toEqual(['Mara', 'Voss', 'the keeper'].sort())
    expect(db.worldKeys(FIX.glass)).toEqual([]) // keyless entries are legitimate (§2.6)
    expect(db.matchWorldKeys(['VOSS', 'the KEEPER', 'nobody'])).toEqual([
      { entryId: FIX.mara, key: 'the keeper' }, // NOCASE key ordering
      { entryId: FIX.mara, key: 'Voss' },
    ])
  })

  it('ingests runs from meta+result lines; a crashed run has null status', () => {
    const rows = db.listRunRows()
    expect(rows.map((r) => r.id)).toEqual([FIX.run1, FIX.run2])

    const run1 = rows[0]
    expect(run1?.kind).toBe('continue')
    expect(run1?.lane).toBe('high')
    expect(run1?.model).toBe('glm-5')
    expect(run1?.status).toBe('ok')
    expect(run1?.endedAt).toBe('2026-07-06T14:02:11Z')
    expect(run1?.promptTokens).toBe(6412)
    expect(run1?.completionTokens).toBe(388)
    expect(run1?.filePath).toBe(`runs/2026-07/${FIX.run1}.jsonl`)

    const run2 = rows[1]
    expect(run2?.kind).toBe('propose-boundaries')
    expect(run2?.lane).toBe('low')
    expect(run2?.status).toBeNull()
    expect(run2?.endedAt).toBeNull()
    expect(run2?.promptTokens).toBeNull()

    const provenance = db.runsByArtifact('snippet', FIX.snip3)
    expect(provenance).toHaveLength(1)
    expect(provenance[0]?.runId).toBe(FIX.run1)
    expect(provenance[0]?.rev).toBe(1)
    expect(provenance[0]?.artifactState).toBe('committed')

    expect(db.usageByLane()).toEqual([
      { lane: 'high', kind: 'continue', runs: 1, promptTokens: 6412, completionTokens: 388 },
      { lane: 'low', kind: 'propose-boundaries', runs: 1, promptTokens: 0, completionTokens: 0 },
    ])
  })

  it('tracks the §8 walk set in the files table (runs excluded)', () => {
    const paths = db.listFileRows().map((f) => f.path)
    for (const expected of [
      'work.json',
      'situation.md',
      `sections/${SEC1_DIR}/section.json`,
      `sections/${SEC1_DIR}/content.md`,
      `sections/${SEC1_DIR}/summary-short.md`,
      `sections/${SEC1_DIR}/summary-long.md`,
      `sections/${SEC1_DIR}/illustration.png`,
      `sections/${SEC1_DIR}/history.jsonl`,
      `sections/${SEC2_DIR}/section.json`,
      `sections/${SEC2_DIR}/content.md`,
      `frontier/snippets/${SNIP1_FILE}`,
      `frontier/revisions/${FIX.snip1}.jsonl`,
      `world/entries/${MARA_FILE}`,
      `world/entries/${GLASS_FILE}`,
      `world/images/${FIX.mara}.png`,
      `world/images/${FIX.mara}.json`,
    ]) {
      expect(paths).toContain(expected)
    }
    expect(paths.some((p) => p.startsWith('runs/'))).toBe(false)
    expect(paths.some((p) => p.includes('.cowrite'))).toBe(false)
    // the content.md files row and the sections row hash the same bytes
    expect(db.getFile(`sections/${SEC1_DIR}/content.md`)?.xxh64).toBe(fix.sec1ContentHash)
  })

  it('populates FTS for section content, snippets, and world bodies — not the situation', () => {
    expect(db.ftsSearch('lighthouse').map((h) => `${h.kind}:${h.entityId}`)).toContain(
      `section:${FIX.sec1}`,
    )
    expect(db.ftsSearch('pilings')).toEqual([
      {
        kind: 'snippet',
        entityId: FIX.snip2,
        title: '',
        snippet: expect.stringContaining('pilings'),
      },
    ])
    expect(db.ftsSearch('seawater').map((h) => h.entityId)).toEqual([FIX.glass])
    // section titles are searchable
    expect(db.ftsSearch('keeper').map((h) => h.entityId)).toContain(FIX.sec1)
    // situation.md is not an FTS source (§7.1 lists prose + world only)
    expect(db.ftsSearch('harbormaster')).toEqual([])
  })

  it('is idempotent: a second rebuild produces identical rows', async () => {
    const before = dumpAll(db)
    await fullRebuild(db, workDir)
    expect(dumpAll(db)).toEqual(before)
  })

  it('leaves a database needsRebuild considers healthy', () => {
    expect(needsRebuild(path.join(workDir, '.cowrite', 'index.sqlite'))).toBe(false)
  })
})

/** Every table, deterministically ordered, minus the always-changing lastScanAt. */
function dumpAll(db: IndexDb): Record<string, unknown[]> {
  const all = (sql: string): unknown[] => db.handle.prepare(sql).all()
  return {
    meta: all("SELECT * FROM meta WHERE key != 'lastScanAt' ORDER BY key"),
    files: all('SELECT * FROM files ORDER BY path'),
    sections: all('SELECT * FROM sections ORDER BY id'),
    snippets: all('SELECT * FROM snippets ORDER BY id'),
    worldEntries: all('SELECT * FROM world_entries ORDER BY id'),
    worldKeys: all('SELECT * FROM world_keys ORDER BY entry_id, key'),
    agentRuns: all('SELECT * FROM agent_runs ORDER BY id'),
    runArtifacts: all(
      'SELECT * FROM run_artifacts ORDER BY run_id, artifact_kind, artifact_id, rev',
    ),
    fts: all('SELECT kind, entity_id, title, body FROM fts ORDER BY kind, entity_id'),
  }
}
