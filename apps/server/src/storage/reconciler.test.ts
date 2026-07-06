import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type IndexDb, openIndex } from './index/db.js'
import { buildFixtureWork, FIX, SEC1_DIR } from './index/fixture.js'
import { fullRebuild } from './index/scan.js'
import { indexPath } from './lib/paths.js'
import { reconcile } from './reconciler.js'

/**
 * The reconciler's §8 fast path (§7.3 budget): the 30 s subscriber tick over an
 * unchanged tree must be near-pure stat calls — ZERO full-file reads. Every walk-set
 * file (section.json included) is classified via (size, mtime) first, and unchanged
 * section dirs resolve their ids from the index rows instead of re-parsing metadata.
 */
describe('reconciler no-change tick performs zero full-file reads', () => {
  let root: string
  let workDir: string
  let db: IndexDb

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'cowrite-recon-fast-'))
    workDir = (await buildFixtureWork(root)).workDir
    db = openIndex(indexPath(workDir))
    await fullRebuild(db, workDir)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    db.close()
    await fsp.rm(root, { recursive: true, force: true })
  })

  it('reads no file when nothing changed since the last scan', async () => {
    // First pass settles anything a fresh index might still want (the fixture is
    // drift-free, so it must be a no-op too).
    const first = await reconcile({ workDir, db })
    expect(first.changed).toEqual([])
    expect(first.adopted).toEqual([])

    const readFileSpy = vi.spyOn(fsp, 'readFile')
    const openSpy = vi.spyOn(fsp, 'open')
    const report = await reconcile({ workDir, db })
    expect(report).toEqual({
      adopted: [],
      changed: [],
      removed: [],
      unrecognized: [],
      renumbered: 0,
    })
    expect(readFileSpy).not.toHaveBeenCalled()
    expect(openSpy).not.toHaveBeenCalled()
  })

  it('still re-parses a section whose section.json changed (the fast path is not blind)', async () => {
    await reconcile({ workDir, db })
    const metaAbs = path.join(workDir, 'sections', SEC1_DIR, 'section.json')
    const meta = JSON.parse(await fsp.readFile(metaAbs, 'utf8')) as { title: string }
    meta.title = 'Retitled Externally'
    await fsp.writeFile(metaAbs, `${JSON.stringify(meta, null, 2)}\n`)

    // The same spy the zero-read test relies on MUST fire here — proves it intercepts
    // the reconciler's reads and the no-change assertion is not vacuous.
    const readFileSpy = vi.spyOn(fsp, 'readFile')
    const report = await reconcile({ workDir, db })
    expect(readFileSpy).toHaveBeenCalled()
    expect(report.changed.some((c) => c.kind === 'section' && c.id === FIX.sec1)).toBe(true)
    expect(db.getSection(FIX.sec1)?.title).toBe('Retitled Externally')
  })

  it('a touch(1)-style mtime-only change refreshes the files row without a re-parse', async () => {
    await reconcile({ workDir, db })
    const rel = `sections/${SEC1_DIR}/section.json`
    const before = db.getFile(rel)
    const when = new Date(Date.now() + 5_000)
    await fsp.utimes(path.join(workDir, ...rel.split('/')), when, when)

    const report = await reconcile({ workDir, db })
    expect(report.changed).toEqual([]) // touched, not changed: the xxh64 confirm matched
    const after = db.getFile(rel)
    expect(after?.xxh64).toBe(before?.xxh64)
    expect(after?.mtimeMs).not.toBe(before?.mtimeMs)
  })
})
