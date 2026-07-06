import { appendFile, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { xxh64OfString } from '../lib/hash.js'
import { type IndexDb, openIndex } from './db.js'
import {
  buildFixtureWork,
  FIX,
  SEC1_CONTENT,
  SEC1_DIR,
  SEC2_DIR,
  SNIP1_FILE,
  snippetFileText,
  worldEntryFileText,
} from './fixture.js'
import {
  ingestRunFile,
  readRunBoundaryLines,
  recomputeSectionStaleness,
  refreshSituation,
  removeEntityRows,
  removeFileRow,
  upsertSectionFromDisk,
  upsertSnippetFromDisk,
  upsertWorldEntryFromDisk,
} from './ingest.js'
import { fullRebuild } from './scan.js'

let root: string
let workDir: string
let db: IndexDb

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'cowrite-ingest-'))
  const fix = await buildFixtureWork(root)
  workDir = fix.workDir
  db = openIndex(path.join(workDir, '.cowrite', 'index.sqlite'))
  await fullRebuild(db, workDir)
})

afterEach(async () => {
  db.close()
  await rm(root, { recursive: true, force: true })
})

describe('upsertSnippetFromDisk', () => {
  it('re-indexes an edited snippet: row, revision count, files table, FTS', async () => {
    const snippetAbs = path.join(workDir, 'frontier', 'snippets', SNIP1_FILE)
    const relPath = `frontier/snippets/${SNIP1_FILE}`
    const oldHash = db.getFile(relPath)?.xxh64
    const newBody = 'The phosphorescent tide rose over the quay.\n'
    await writeFile(
      snippetAbs,
      snippetFileText(
        {
          id: FIX.snip1,
          orderKey: 'a0',
          createdAt: '2026-07-06T13:00:00Z',
          updatedAt: '2026-07-06T15:00:00Z',
          authorship: 'mixed',
          originRunId: FIX.run1,
          rev: 4,
        },
        newBody,
      ),
    )
    await appendFile(
      path.join(workDir, 'frontier', 'revisions', `${FIX.snip1}.jsonl`),
      `${JSON.stringify({ type: 'revision', rev: 4, ts: '2026-07-06T15:00:00Z', author: 'user', text: newBody.trim() })}\n`,
    )

    const row = await upsertSnippetFromDisk(db, workDir, snippetAbs)
    expect(row?.rev).toBe(4)
    expect(row?.revisionCount).toBe(4)
    expect(row?.wordCount).toBe(7)
    expect(row?.updatedAt).toBe('2026-07-06T15:00:00Z')
    expect(db.getSnippet(FIX.snip1)).toEqual(row)
    expect(db.getFile(relPath)?.xxh64).not.toBe(oldHash)
    expect(db.ftsSearch('phosphorescent').map((h) => h.entityId)).toEqual([FIX.snip1])
    expect(db.ftsSearch('palm')).toEqual([]) // old body replaced, not appended
  })

  it('accepts work-relative paths and returns null for a frontmatter-less file', async () => {
    const foreign = path.join(workDir, 'frontier', 'snippets', '040.zzzzzz.md')
    await writeFile(foreign, 'no frontmatter here\n')
    expect(await upsertSnippetFromDisk(db, workDir, 'frontier/snippets/040.zzzzzz.md')).toBeNull()
    expect(db.listSnippetRows()).toHaveLength(3)
  })
})

describe('upsertWorldEntryFromDisk', () => {
  it('replaces alias keys and updates FTS', async () => {
    const entryAbs = path.join(
      workDir,
      'world',
      'entries',
      `mara-voss.${FIX.mara.slice(-6).toLowerCase()}.md`,
    )
    await writeFile(
      entryAbs,
      worldEntryFileText(
        {
          id: FIX.mara,
          name: 'Mara Voss',
          keys: ['Mara', 'Keeper of Cinder Point'],
          image: `../images/${FIX.mara}.png`,
          shortSummary: 'Lighthouse keeper of Cinder Point.',
          createdBy: 'user',
          updatedAt: '2026-07-06T16:00:00Z',
        },
        'Mara Voss guards the phosphor lamp.\n',
      ),
    )
    const row = await upsertWorldEntryFromDisk(db, workDir, entryAbs)
    expect(row?.updatedAt).toBe('2026-07-06T16:00:00Z')
    expect(db.matchWorldKeys(['keeper of cinder point'])).toEqual([
      { entryId: FIX.mara, key: 'Keeper of Cinder Point' },
    ])
    expect(db.matchWorldKeys(['voss'])).toEqual([]) // dropped key is gone
    expect(db.ftsSearch('phosphor').map((h) => h.entityId)).toEqual([FIX.mara])
  })
})

describe('sections: upsertSectionFromDisk / recomputeSectionStaleness', () => {
  it('a >15% word-count delta flips illustration staleness; hash change flips summaries', async () => {
    const contentAbs = path.join(workDir, 'sections', SEC1_DIR, 'content.md')
    // roughly +50% words: well past the 15% delta
    await writeFile(contentAbs, `${SEC1_CONTENT}${SEC1_CONTENT}`)

    const row = await upsertSectionFromDisk(db, workDir, `sections/${SEC1_DIR}`)
    expect(row?.illustrationStale).toBe(true)
    expect(row?.shortSummaryStale).toBe(true) // the user-edited summary goes stale once prose changes
    expect(row?.longSummaryStale).toBe(true)
    expect(row?.contentHash).toBe(await xxh64OfString(`${SEC1_CONTENT}${SEC1_CONTENT}`))
    expect(db.getSection(FIX.sec1)).toEqual(row)
    // files table follows the entity
    expect(db.getFile(`sections/${SEC1_DIR}/content.md`)?.xxh64).toBe(row?.contentHash)
  })

  it('recomputeSectionStaleness: suppressed illustration stays fresh through any edit', async () => {
    const contentAbs = path.join(workDir, 'sections', SEC2_DIR, 'content.md')
    await writeFile(contentAbs, 'Entirely new prose, three times longer than before it was.\n')
    const row = await recomputeSectionStaleness(db, workDir, FIX.sec2)
    expect(row?.illustrationStale).toBe(false) // tombstone: never stale (§6.5)
    expect(row?.shortSummaryStale).toBe(true) // still missing on a frozen leaf
    expect(row?.wordCount).toBe(10)
    await expect(
      recomputeSectionStaleness(db, workDir, '01J2KF00000000000000GH0STX'),
    ).resolves.toBeNull()
  })

  it('a vanished summary file makes a frozen leaf stale even with metadata present', async () => {
    await unlink(path.join(workDir, 'sections', SEC1_DIR, 'summary-short.md'))
    const row = await upsertSectionFromDisk(db, workDir, `sections/${SEC1_DIR}`)
    expect(row?.shortSummaryStale).toBe(true)
    expect(db.getFile(`sections/${SEC1_DIR}/summary-short.md`)).toBeNull()
  })
})

describe('removeEntityRows', () => {
  it('snippet: drops row, FTS, and files rows (snippet + revision log)', () => {
    removeEntityRows(db, 'snippet', FIX.snip2)
    expect(db.getSnippet(FIX.snip2)).toBeNull()
    expect(db.ftsSearch('pilings')).toEqual([])
    expect(db.getFile('frontier/snippets/020.q8r2v7.md')).toBeNull()
    expect(db.getFile(`frontier/revisions/${FIX.snip2}.jsonl`)).toBeNull()
    expect(db.listSnippetRows().map((r) => r.id)).toEqual([FIX.snip1, FIX.snip3])
  })

  it('section: drops row, FTS, and the known per-section files rows', () => {
    removeEntityRows(db, 'section', FIX.sec2)
    expect(db.getSection(FIX.sec2)).toBeNull()
    expect(db.getFile(`sections/${SEC2_DIR}/section.json`)).toBeNull()
    expect(db.getFile(`sections/${SEC2_DIR}/content.md`)).toBeNull()
    expect(db.ftsSearch('hummed')).toEqual([]) // sec2's body is gone from FTS
  })

  it('world: drops entry, keys, FTS, files row', () => {
    removeEntityRows(db, 'world', FIX.mara)
    expect(db.getWorldEntry(FIX.mara)).toBeNull()
    expect(db.matchWorldKeys(['mara'])).toEqual([])
    expect(db.ftsSearch('eleven')).toEqual([])
  })

  it('run: drops run and artifact rows', () => {
    removeEntityRows(db, 'run', FIX.run1)
    expect(db.runsByArtifact('snippet', FIX.snip3)).toEqual([])
    expect(db.listRunRows().map((r) => r.id)).toEqual([FIX.run2])
  })
})

describe('refreshSituation', () => {
  it('updates the hash and files row on edit, and drops the row when the file vanishes', async () => {
    const situationAbs = path.join(workDir, 'situation.md')
    await writeFile(situationAbs, 'A new scene: the jetty at dawn.\n')
    const hash = await refreshSituation(db, workDir)
    expect(hash).toBe(await xxh64OfString('A new scene: the jetty at dawn.\n'))
    expect(db.getMeta('situationHash')).toBe(hash)
    expect(db.getFile('situation.md')?.xxh64).toBe(hash)

    await unlink(situationAbs)
    const emptyHash = await refreshSituation(db, workDir)
    expect(emptyHash).toBe(await xxh64OfString('')) // absent = empty situation (§2.2)
    expect(db.getMeta('situationHash')).toBe(emptyHash)
    expect(db.getFile('situation.md')).toBeNull()
  })
})

describe('ingestRunFile', () => {
  it('finalizing a crashed run fills status/tokens on re-ingest', async () => {
    const runAbs = path.join(workDir, 'runs', '2026-07', `${FIX.run2}.jsonl`)
    expect(db.listRunRows()[1]?.status).toBeNull()
    await appendFile(
      runAbs,
      `${JSON.stringify({
        type: 'result',
        status: 'error',
        error: { code: 'crash', message: 'finalized at open' },
        usageTotal: { promptTokens: 512, completionTokens: 0 },
        partialText: null,
        artifacts: [],
        endedAt: '2026-07-06T15:00:00Z',
      })}\n`,
    )
    const run = await ingestRunFile(db, workDir, runAbs)
    expect(run?.status).toBe('error')
    expect(run?.endedAt).toBe('2026-07-06T15:00:00Z')
    expect(run?.promptTokens).toBe(512)
    expect(db.listRunRows()).toHaveLength(2)
  })

  it('is idempotent for a finished run and tolerates a torn trailing line', async () => {
    const runAbs = path.join(workDir, 'runs', '2026-07', `${FIX.run1}.jsonl`)
    await ingestRunFile(db, workDir, runAbs)
    await ingestRunFile(db, workDir, runAbs)
    expect(db.runsByArtifact('snippet', FIX.snip3)).toHaveLength(1)

    // a torn (non-JSON) tail must not shadow the result line… it does shadow it as the
    // last non-empty line, so the run degrades to in-flight — never throws.
    await appendFile(runAbs, '{"type":"output","te')
    const run = await ingestRunFile(db, workDir, runAbs)
    expect(run?.id).toBe(FIX.run1)
  })

  it('returns null for a file whose first line is not a meta event', async () => {
    const bogus = path.join(workDir, 'runs', '2026-07', '01J2KF00000000000000BOGUS1.jsonl')
    await writeFile(bogus, '{"type":"output","text":"hi"}\n')
    expect(await ingestRunFile(db, workDir, bogus)).toBeNull()
  })
})

describe('readRunBoundaryLines', () => {
  it('reads first and last non-empty lines without regard to file size chunking', async () => {
    const p = path.join(workDir, 'runs', 'big.jsonl')
    const filler = `{"type":"output","text":"${'x'.repeat(200_000)}"}\n`
    await writeFile(p, `{"first":true}\n${filler}${filler}{"last":true}\n\n`)
    const { first, last } = await readRunBoundaryLines(p)
    expect(first).toBe('{"first":true}')
    expect(last).toBe('{"last":true}')
  })

  it('single-line file: first === last', async () => {
    const p = path.join(workDir, 'runs', 'one.jsonl')
    await writeFile(p, '{"only":1}')
    const { first, last } = await readRunBoundaryLines(p)
    expect(first).toBe('{"only":1}')
    expect(last).toBe('{"only":1}')
  })
})

describe('removeFileRow', () => {
  it('drops a files-table row by absolute or work-relative path', () => {
    expect(db.getFile(`sections/${SEC1_DIR}/summary-long.md`)).not.toBeNull()
    removeFileRow(db, workDir, path.join(workDir, 'sections', SEC1_DIR, 'summary-long.md'))
    expect(db.getFile(`sections/${SEC1_DIR}/summary-long.md`)).toBeNull()

    removeFileRow(db, workDir, 'work.json')
    expect(db.getFile('work.json')).toBeNull()
  })
})

describe('illustrationDeltaPct policy (§6.5 fallback)', () => {
  it('throws on a BROKEN work.json instead of silently defaulting (matches fullRebuild)', async () => {
    await writeFile(path.join(workDir, 'work.json'), '{ not json')
    await expect(upsertSectionFromDisk(db, workDir, `sections/${SEC1_DIR}`)).rejects.toThrow()
  })

  it('falls back to the schema default when work.json is absent', async () => {
    await unlink(path.join(workDir, 'work.json'))
    const row = await upsertSectionFromDisk(db, workDir, `sections/${SEC1_DIR}`)
    expect(row?.id).toBe(FIX.sec1) // indexing proceeded on the shared schema default
  })
})
