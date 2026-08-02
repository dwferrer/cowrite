import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openIndex } from '../index/db.js'
import { parseFrontmatter } from '../lib/frontmatter.js'
import { wordCount, xxh64OfBuffer, xxh64OfString } from '../lib/hash.js'
import { indexPath } from '../lib/paths.js'
import { createStorage, type WorkHandle } from '../service.js'

/**
 * Golden-directory test (spec 02 §12): a checked-in fixture work built from the §5.3
 * layout and §5.4 file formats — 2 chapters, 3 frontier snippets, 2 world entries,
 * 2 runs (one crashed mid-stream) — with static timestamps. The fixture is copied to a
 * temp dataDir, opened through the real openWork lifecycle (lock → sweep → crash
 * finalization → index rebuild → reconcile), and the resulting index rows, staleness
 * flags, and search results are asserted.
 *
 * Deviation from the literal §5.4 sample ULIDs: the spec's `01J2P7R9GT5W0ZNXK3M8QAB4CD`
 * does not end with the short id its own filenames use (`t5w0zn`), so the fixture ids
 * are respelled to keep `shortId(id) == filename short id` — the invariant §3/§8
 * re-association depends on. The two run ids ARE the spec's verbatim.
 */

const FIXTURE = fileURLToPath(new URL('./fixtures/salt-and-signal', import.meta.url))

const WORK = '01J2KA00000000000000SA1TS1'
const SEC1 = '01J2P10000000000000001HZQA'
const SEC2 = '01J2P20000000000000001J2KF'
const SNIP1 = '01J2P400000000000000P2M9X1'
const SNIP2 = '01J2P600000000000000Q8R2V7'
const SNIP3 = '01J2P7R9GT0000000000T5W0ZN'
const MARA = '01J2N8W2KQ00000000007F3AKQ'
const GLASS = '01J2N9000000000000009B1XTE'
const RUN1 = '01J2P7Q4V2M8Z6T1RD5FCW9XKB' // continue → snippet 030 (§5.3)
const RUN2 = '01J2P5H8A3N1Y7S4QE2GBV6MKD' // propose-boundaries, crashed mid-stream

const SEC1_DIR = 'sections/010-the-lighthouse-keeper.01hzqa'
const SEC2_DIR = 'sections/020-the-storm-glass.01j2kf'

describe('golden fixture: salt-and-signal (§5.3/§5.4)', () => {
  let dataDir: string
  let workDir: string
  let handle: WorkHandle

  const readWorkFile = (rel: string): Promise<string> =>
    fsp.readFile(path.join(workDir, ...rel.split('/')), 'utf8')

  beforeAll(async () => {
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cowrite-golden-'))
    workDir = path.join(dataDir, 'works', 'salt-and-signal')
    await fsp.cp(FIXTURE, workDir, { recursive: true })
    handle = await createStorage(dataDir).openWork('salt-and-signal')
  })

  afterAll(async () => {
    await handle.close().catch(() => {})
    await fsp.rm(dataDir, { recursive: true, force: true })
  })

  it('opens writable with the fixture WorkMeta and situation', async () => {
    expect(handle.readOnly).toBe(false)
    expect(handle.work.id).toBe(WORK)
    expect(handle.work.title).toBe('Salt and Signal')
    expect(handle.work.levelScheme).toEqual(['chapter'])
    const situation = await handle.getSituation()
    expect(situation.text).toContain('Mara confronts the harbormaster')
  })

  it('indexes the section rows with §6.5-derived staleness', async () => {
    const sec1Content = await readWorkFile(`${SEC1_DIR}/content.md`)
    const sec2Content = await readWorkFile(`${SEC2_DIR}/content.md`)
    const sec1Png = await fsp.readFile(
      path.join(workDir, ...`${SEC1_DIR}/illustration.png`.split('/')),
    )
    const sec2Png = await fsp.readFile(
      path.join(workDir, ...`${SEC2_DIR}/illustration.png`.split('/')),
    )

    expect(handle.listSections()).toEqual([
      {
        id: SEC1,
        parentId: null,
        kind: 'chapter',
        orderKey: 'a0',
        title: 'The Lighthouse Keeper',
        titleSource: 'agent',
        dirPath: SEC1_DIR,
        wordCount: wordCount(sec1Content),
        contentHash: await xxh64OfString(sec1Content),
        frozenAt: '2026-07-01T09:00:00Z',
        // enrichments generated from the current prose: everything fresh
        shortSummaryStale: false,
        longSummaryStale: false,
        illustrationStale: false,
        illustrationHash: await xxh64OfBuffer(sec1Png),
        illustrationWidth: 96,
        illustrationHeight: 64,
        // schema v2: the summary-*.md text rides the row (zero-file-read reads)
        shortSummary: await readWorkFile(`${SEC1_DIR}/summary-short.md`),
        longSummary: await readWorkFile(`${SEC1_DIR}/summary-long.md`),
      },
      {
        id: SEC2,
        parentId: null,
        kind: 'chapter',
        orderKey: 'a1',
        title: 'The Storm Glass',
        titleSource: 'user',
        dirPath: SEC2_DIR,
        wordCount: wordCount(sec2Content),
        contentHash: await xxh64OfString(sec2Content),
        frozenAt: '2026-07-05T22:10:00Z',
        // §5.3: the user edited content.md externally after the summaries were
        // generated → sourceHash mismatch → both summaries stale; the illustration's
        // word-count delta is 0 → fresh
        shortSummaryStale: true,
        longSummaryStale: true,
        illustrationStale: false,
        illustrationHash: await xxh64OfBuffer(sec2Png),
        illustrationWidth: 64,
        illustrationHeight: 64,
        shortSummary: await readWorkFile(`${SEC2_DIR}/summary-short.md`),
        longSummary: await readWorkFile(`${SEC2_DIR}/summary-long.md`),
      },
    ])

    const { text, contentHash } = await handle.getSectionContent(SEC1)
    expect(text).toBe(sec1Content)
    expect(contentHash).toBe(await xxh64OfString(sec1Content))
  })

  it('indexes the frontier snippet rows in §4 order', async () => {
    const bodyOf = async (rel: string): Promise<string> =>
      parseFrontmatter(await readWorkFile(rel)).body

    expect(handle.listSnippets()).toEqual([
      {
        id: SNIP1,
        orderKey: 'a0',
        authorship: 'mixed', // agent-drafted, user-touched (§5.3)
        originRunId: RUN1,
        rev: 3,
        revisionCount: 3,
        wordCount: wordCount(await bodyOf('frontier/snippets/010.p2m9x1.md')),
        updatedAt: '2026-07-06T13:40:00Z',
        filePath: 'frontier/snippets/010.p2m9x1.md',
      },
      {
        id: SNIP2,
        orderKey: 'a1',
        authorship: 'user',
        originRunId: null,
        rev: 1,
        revisionCount: 1,
        wordCount: wordCount(await bodyOf('frontier/snippets/020.q8r2v7.md')),
        updatedAt: '2026-07-06T13:50:00Z',
        filePath: 'frontier/snippets/020.q8r2v7.md',
      },
      {
        id: SNIP3,
        orderKey: 'a2',
        authorship: 'agent', // drafted 2 min ago by the continue run (§5.3)
        originRunId: RUN1,
        rev: 1,
        revisionCount: 1,
        wordCount: wordCount(await bodyOf('frontier/snippets/030.t5w0zn.md')),
        updatedAt: '2026-07-06T14:02:11Z',
        filePath: 'frontier/snippets/030.t5w0zn.md',
      },
    ])

    // the revision log tip matches the .md body exactly (§5.4 full-text events)
    const revisions = await handle.getRevisions(SNIP1)
    expect(revisions.map((e) => [e.rev, e.author])).toEqual([
      [1, 'agent'],
      [2, 'user'],
      [3, 'user'],
    ])
    expect(revisions[0]?.runId).toBe(RUN1)
    expect(revisions[2]?.text).toBe(await bodyOf('frontier/snippets/010.p2m9x1.md'))
  })

  it('loads the world entries: alias keys, keyless entries, image references', async () => {
    const entries = await handle.listWorldEntries()
    expect(entries.map((e) => e.meta.name)).toEqual(['Mara Voss', 'The Storm Glass'])

    const mara = entries[0]?.meta
    expect(mara?.id).toBe(MARA)
    expect(mara?.keys).toEqual(['Mara', 'Voss', 'the keeper'])
    expect(mara?.image).toBe(`../images/${MARA}.png`)
    expect(mara?.createdBy).toBe('user')
    expect(mara?.updatedAt).toBe('2026-07-03T09:15:00Z')

    const glass = entries[1]?.meta
    expect(glass?.id).toBe(GLASS)
    expect(glass?.keys).toEqual([]) // an entry with no keys is fully legitimate (§2.6)
    expect(glass?.image).toBeNull()
    expect(glass?.createdBy).toBe('agent')

    // alias matching (case-insensitive, phrase keys)
    const byAlias = await handle.matchWorldEntries('She asked THE KEEPER about the light.')
    expect(byAlias.map((e) => e.meta.id)).toEqual([MARA])
    const byName = await handle.matchWorldEntries('The storm glass ticked on its shelf.')
    expect(byName.map((e) => e.meta.id)).toEqual([GLASS])
  })

  it('indexes the run rows; the crashed run is finalized at open (§10.7)', async () => {
    // second read-only connection onto the same WAL index (the handle keeps its own)
    const db = openIndex(indexPath(workDir))
    try {
      const rows = db.listRunRows()
      expect(rows.map((r) => r.id)).toEqual([RUN1, RUN2])

      expect(rows[0]).toMatchObject({
        kind: 'continue',
        lane: 'high',
        model: 'glm-5',
        status: 'ok',
        startedAt: '2026-07-06T14:01:58Z',
        endedAt: '2026-07-06T14:02:11Z',
        promptTokens: 6412,
        completionTokens: 388,
        filePath: `runs/2026-07/${RUN1}.jsonl`,
      })

      // the fixture ships RUN2 without a result line; openWork appended the
      // synthesized crash result before indexing
      expect(rows[1]).toMatchObject({
        kind: 'propose-boundaries',
        lane: 'low',
        status: 'error',
        startedAt: '2026-07-06T14:10:00Z',
        promptTokens: 0,
        completionTokens: 0,
      })
      expect(rows[1]?.endedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/) // finalized at open time
    } finally {
      db.close()
    }

    const events = await handle.readRun(RUN2)
    const last = events[events.length - 1]
    expect(last?.type).toBe('result')
    if (last?.type === 'result') {
      expect(last.status).toBe('error')
      expect(last.error?.code).toBe('crash')
      expect(last.partialText).toContain('{"boundaries":') // streamed output preserved
      expect(last.artifacts).toEqual([])
    }

    // provenance: which run produced snippet 030?
    const provenance = handle.queryRunsByArtifact('snippet', SNIP3)
    expect(provenance).toHaveLength(1)
    expect(provenance[0]).toMatchObject({ runId: RUN1, rev: 1, artifactState: 'committed' })
  })

  it('answers search across section prose, snippets, and world bodies — not the situation', () => {
    const hits = (q: string): string[] =>
      handle
        .search(q)
        .map((h) => `${h.kind}:${h.entityId}`)
        .sort()

    expect(hits('quayside')).toEqual([`section:${SEC2}`])
    expect(hits('pilings')).toEqual([`snippet:${SNIP2}`])
    expect(hits('seawater')).toEqual([`world:${GLASS}`])
    // section titles are searchable too
    expect(hits('lighthouse')).toContain(`section:${SEC1}`)
    // 'harbormaster' lives only in situation.md, which is not an FTS source (§7.1)
    expect(hits('harbormaster')).toEqual([])
  })

  it('is drift-free: a follow-up reconcile finds nothing to adopt, change, or renumber', async () => {
    expect(await handle.reconcile()).toEqual({
      adopted: [],
      changed: [],
      removed: [],
      unrecognized: [],
      renumbered: 0,
    })
  })
})
