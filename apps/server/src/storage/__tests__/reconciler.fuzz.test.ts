import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ulid } from 'ulid'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type IndexDb, openIndex } from '../index/db.js'
import { buildFixtureWork, FIX, SEC2_DIR, SNIP1_FILE, snippetFileText } from '../index/fixture.js'
import { fullRebuild } from '../index/scan.js'
import { parseFrontmatter } from '../lib/frontmatter.js'
import { isTmpFile } from '../lib/fsx.js'
import { nKeysBetween } from '../lib/orderKeys.js'
import {
  frontierRevisionsDir,
  frontierSnippetsDir,
  indexPath,
  sectionsDir,
  worldEntriesDir,
} from '../lib/paths.js'
import { reconcile } from '../reconciler.js'
import { mulberry32, pick, randInt } from './prng.js'

/**
 * Reconciler fuzz (spec 02 §12): seed a fixture work, then rounds of random external
 * mutations — edit a section's content.md, edit/strip a snippet's frontmatter, rename a
 * snippet file, add foreign .md files to frontier/ and world/, add a stray .md inside a
 * section dir, delete a snippet file, touch(1)-style mtime-only changes — reconciling
 * after each round and asserting the §8 invariants:
 *
 *  1. NO user file is ever deleted or destructively rewritten: every Markdown *body*
 *     present immediately before a reconcile is still present, byte-identical, after it
 *     (frontmatter write-back is allowed); strays and section prose are untouched
 *     byte-for-byte; revision logs never disappear.
 *  2. After every reconcile the index equals a from-scratch fullRebuild of the same
 *     tree (both dumped to a comparable structure; lastScanAt excluded).
 */

async function listFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true })
    return entries
      .filter((e) => e.isFile() && !isTmpFile(e.name))
      .map((e) => e.name)
      .sort()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

async function mdFiles(dir: string): Promise<string[]> {
  return (await listFiles(dir)).filter((n) => n.endsWith('.md'))
}

/** Sorted multiset of Markdown *bodies* in a directory (frontmatter excluded). */
async function bodiesIn(dir: string): Promise<string[]> {
  const bodies: string[] = []
  for (const name of await mdFiles(dir)) {
    const raw = await fsp.readFile(path.join(dir, name), 'utf8')
    bodies.push(parseFrontmatter(raw).body)
  }
  return bodies.sort()
}

interface ProseSnapshot {
  snippetBodies: string[]
  worldBodies: string[]
  /** section dir name → exact content.md bytes */
  sectionContents: Array<[string, string]>
  /** stray path (abs) → exact bytes */
  strays: Array<[string, string]>
  workJson: string
  situation: string
}

async function sectionDirs(workDir: string): Promise<string[]> {
  const entries = await fsp.readdir(sectionsDir(workDir), { withFileTypes: true })
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
}

async function snapshotProse(
  workDir: string,
  strayPaths: readonly string[],
): Promise<ProseSnapshot> {
  const sectionContents: Array<[string, string]> = []
  for (const dir of await sectionDirs(workDir)) {
    const content = await fsp
      .readFile(path.join(sectionsDir(workDir), dir, 'content.md'), 'utf8')
      .catch(() => null)
    if (content !== null) sectionContents.push([dir, content])
  }
  const strays: Array<[string, string]> = []
  for (const p of [...strayPaths].sort()) {
    strays.push([p, await fsp.readFile(p, 'utf8')])
  }
  return {
    snippetBodies: await bodiesIn(frontierSnippetsDir(workDir)),
    worldBodies: await bodiesIn(worldEntriesDir(workDir)),
    sectionContents,
    strays,
    workJson: await fsp.readFile(path.join(workDir, 'work.json'), 'utf8'),
    situation: await fsp.readFile(path.join(workDir, 'situation.md'), 'utf8'),
  }
}

/**
 * Every index table in a deterministic, comparable shape. lastScanAt is excluded
 * (always-changing). Files rows for ORPHAN revision logs are covered like everything
 * else: the reconciler tracks them ("never deleted", §8) and fullRebuild rows every log
 * present on disk, so the two sides must agree row-for-row.
 */
function dump(db: IndexDb): Record<string, unknown[]> {
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
    fts: all('SELECT kind, entity_id, title, body FROM fts ORDER BY kind, entity_id, body'),
  }
}

describe('reconciler fuzz: random external mutations (§8, §12)', () => {
  let root: string
  let workDir: string
  let db: IndexDb

  beforeEach(async () => {
    // The fixture ships the spec's own §5.4 sample orderKeys ('a0'/'a1'/'a2'), which
    // satisfy the shared OrderKey regex but not fractional-indexing's key grammar —
    // seeding them unrewritten exercises orderKeys' lexicographic fallback throughout.
    root = await mkTemp()
    workDir = (await buildFixtureWork(root)).workDir
    db = openIndex(indexPath(workDir))
    await fullRebuild(db, workDir)
  })

  afterEach(async () => {
    db.close()
    await fsp.rm(root, { recursive: true, force: true })
  })

  async function mkTemp(): Promise<string> {
    return await fsp.mkdtemp(path.join(os.tmpdir(), 'cowrite-fuzz-'))
  }

  // 30 rounds of real file IO + reconciles can legitimately exceed the default timeout
  // on a loaded Windows CI box — give the fuzz run 30 s before calling it hung.
  const FUZZ_TIMEOUT_MS = 30_000
  it.each([[11], [42]])(
    'holds the §12 invariants across 30 rounds (seed %i)',
    async (seed) => {
      const rand = mulberry32(seed)
      // Library keys plus hand-authored ones a user might type: both must interleave.
      const orderKeyPool = [...nKeysBetween(null, null, 40), 'a0', 'a2', 'z', '0z', 'zz']
      const strayPaths: string[] = []
      let revisionLogs = new Set(await listFiles(frontierRevisionsDir(workDir)))
      let touchClock = Date.now()

      const snippetsDir = frontierSnippetsDir(workDir)
      const entriesDir = worldEntriesDir(workDir)

      const mutations = {
        editSectionContent: async (round: number): Promise<void> => {
          const dir = pick(rand, await sectionDirs(workDir))
          const abs = path.join(sectionsDir(workDir), dir, 'content.md')
          const current = await fsp.readFile(abs, 'utf8').catch(() => null)
          if (current === null) return
          await fsp.writeFile(abs, `${current}\nAn external editor appended paragraph ${round}.\n`)
        },
        editSnippetBody: async (round: number): Promise<void> => {
          const names = await mdFiles(snippetsDir)
          if (names.length === 0) return
          const abs = path.join(snippetsDir, pick(rand, names))
          const raw = await fsp.readFile(abs, 'utf8')
          await fsp.writeFile(abs, `${raw}\nExternally appended sentence ${round}.\n`)
        },
        editSnippetFrontmatter: async (): Promise<void> => {
          // rewrite the frontmatter orderKey (the user re-ordered in another tool);
          // frontmatter is authoritative, the prefix mirror renumbers lazily (§4)
          const names = await mdFiles(snippetsDir)
          if (names.length === 0) return
          const abs = path.join(snippetsDir, pick(rand, names))
          const raw = await fsp.readFile(abs, 'utf8')
          const key = pick(rand, orderKeyPool)
          const next = raw.replace(/^orderKey: .*$/m, `orderKey: ${key}`)
          if (next !== raw) await fsp.writeFile(abs, next)
        },
        stripSnippetFrontmatter: async (): Promise<void> => {
          const names = await mdFiles(snippetsDir)
          if (names.length === 0) return
          const abs = path.join(snippetsDir, pick(rand, names))
          const raw = await fsp.readFile(abs, 'utf8')
          await fsp.writeFile(abs, parseFrontmatter(raw).body)
        },
        renameSnippetFile: async (): Promise<void> => {
          // change the numeric prefix only (short id kept — identity must survive, §8)
          const names = (await mdFiles(snippetsDir)).filter((n) => /^\d+\./.test(n))
          if (names.length === 0) return
          const name = pick(rand, names)
          const target = name.replace(/^\d+\./, `${100 + randInt(rand, 899)}.`)
          if (target === name) return
          try {
            await fsp.rename(path.join(snippetsDir, name), path.join(snippetsDir, target))
          } catch {
            // target name already exists: skip this round's rename
          }
        },
        addForeignSnippet: async (round: number): Promise<void> => {
          await fsp.writeFile(
            path.join(snippetsDir, `pasted-note-${round}.md`),
            `A foreign paragraph pasted in by hand, round ${round}.\n`,
          )
        },
        addForeignWorldEntry: async (round: number): Promise<void> => {
          await fsp.writeFile(
            path.join(entriesDir, `new-place-${round}.md`),
            `A foreign gazetteer entry written elsewhere, round ${round}.\n`,
          )
        },
        stripWorldFrontmatter: async (): Promise<void> => {
          // Every entry is fair game, including previously-adopted foreign files whose
          // filename carries no short id: §8 re-association is impossible there, so the
          // reconciler re-mints — and must drop the old identity's rows while doing it.
          const names = await mdFiles(entriesDir)
          if (names.length === 0) return
          const abs = path.join(entriesDir, pick(rand, names))
          const raw = await fsp.readFile(abs, 'utf8')
          await fsp.writeFile(abs, parseFrontmatter(raw).body)
        },
        addStrayInSectionDir: async (round: number): Promise<void> => {
          const dir = pick(rand, await sectionDirs(workDir))
          const abs = path.join(sectionsDir(workDir), dir, `notes-${round}.md`)
          await fsp.writeFile(
            abs,
            `Private notes ${round}; the reconciler must never touch these.\n`,
          )
          strayPaths.push(abs)
        },
        renameSectionDir: async (round: number): Promise<void> => {
          // rename to a NON-conforming name: section.json is the truth (§5.2), so the
          // section must survive both reconcile and fullRebuild under any dir name
          const dirs = await sectionDirs(workDir)
          if (dirs.length === 0) return
          const name = pick(rand, dirs)
          const oldAbs = path.join(sectionsDir(workDir), name)
          const newAbs = path.join(sectionsDir(workDir), `renamed-${round}.${name}`)
          try {
            await fsp.rename(oldAbs, newAbs)
          } catch {
            return // target existed: skip this round's rename
          }
          // keep stray bookkeeping in step with the move
          for (let i = 0; i < strayPaths.length; i++) {
            const p = strayPaths[i]
            if (p?.startsWith(oldAbs + path.sep)) {
              strayPaths[i] = path.join(newAbs, path.relative(oldAbs, p))
            }
          }
        },
        deleteSnippetFile: async (): Promise<void> => {
          const names = await mdFiles(snippetsDir)
          if (names.length < 2) return // keep the frontier non-empty
          await fsp.unlink(path.join(snippetsDir, pick(rand, names)))
        },
        touchFile: async (): Promise<void> => {
          const candidates: string[] = []
          for (const n of await mdFiles(snippetsDir)) candidates.push(path.join(snippetsDir, n))
          for (const n of await mdFiles(entriesDir)) candidates.push(path.join(entriesDir, n))
          for (const d of await sectionDirs(workDir)) {
            candidates.push(path.join(sectionsDir(workDir), d, 'content.md'))
          }
          if (candidates.length === 0) return
          const abs = pick(rand, candidates)
          touchClock += 1500
          const when = new Date(touchClock)
          await fsp.utimes(abs, when, when).catch(() => {}) // mtime-only change
        },
      } as const

      const opNames = Object.keys(mutations) as Array<keyof typeof mutations>

      for (let round = 0; round < 30; round++) {
        const opsThisRound = 1 + randInt(rand, 2)
        for (let i = 0; i < opsThisRound; i++) {
          await mutations[pick(rand, opNames)](round * 10 + i)
        }

        // Invariant 1 setup: what the tree's prose looks like going INTO the reconcile.
        const before = await snapshotProse(workDir, strayPaths)

        await reconcile({ workDir, db })

        // Invariant 1: reconcile never deletes a user file or rewrites a body.
        const after = await snapshotProse(workDir, strayPaths)
        expect(after.snippetBodies).toEqual(before.snippetBodies)
        expect(after.worldBodies).toEqual(before.worldBodies)
        expect(after.sectionContents).toEqual(before.sectionContents)
        expect(after.strays).toEqual(before.strays)
        expect(after.workJson).toBe(before.workJson)
        expect(after.situation).toBe(before.situation)

        // revision logs never disappear (adoption may add new ones)
        const logsNow = new Set(await listFiles(frontierRevisionsDir(workDir)))
        for (const log of revisionLogs) expect(logsNow.has(log)).toBe(true)
        revisionLogs = logsNow

        // Invariant 2: incremental index == from-scratch rebuild of the same tree.
        const scratch = openIndex(':memory:')
        try {
          await fullRebuild(scratch, workDir)
          expect(dump(db)).toEqual(dump(scratch))
        } finally {
          scratch.close()
        }
      }
    },
    FUZZ_TIMEOUT_MS,
  )
})

describe('§8 re-mint: an adopted path sheds its previous identity completely', () => {
  let root: string
  let workDir: string
  let db: IndexDb

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'cowrite-remint-'))
    workDir = (await buildFixtureWork(root)).workDir
    db = openIndex(indexPath(workDir))
    await fullRebuild(db, workDir)
  })

  afterEach(async () => {
    db.close()
    await fsp.rm(root, { recursive: true, force: true })
  })

  async function expectIndexEqualsRebuild(): Promise<void> {
    const scratch = openIndex(':memory:')
    try {
      await fullRebuild(scratch, workDir)
      expect(dump(db)).toEqual(dump(scratch))
    } finally {
      scratch.close()
    }
  }

  it('re-mints a stripped world entry whose filename has no short id, dropping the old rows', async () => {
    // Adopt a foreign entry; its filename carries no `slug.shortid.md` short id.
    const rel = 'world/entries/new-place-1.md'
    const abs = path.join(worldEntriesDir(workDir), 'new-place-1.md')
    await fsp.writeFile(abs, 'A foreign gazetteer entry written elsewhere.\n')
    await reconcile({ workDir, db })
    const adopted = db.listWorldEntryRows().find((r) => r.filePath === rel)
    expect(adopted).toBeDefined()
    const oldId = adopted?.id ?? ''

    // Strip the frontmatter the adoption wrote back: §8 short-id re-association is
    // impossible (no parsable short id in the name), so reconcile mints a NEW ULID.
    const raw = await fsp.readFile(abs, 'utf8')
    await fsp.writeFile(abs, parseFrontmatter(raw).body)
    const report = await reconcile({ workDir, db })

    const claimants = db.listWorldEntryRows().filter((r) => r.filePath === rel)
    expect(claimants).toHaveLength(1)
    expect(claimants[0]?.id).not.toBe(oldId)
    // The old identity's rows are gone everywhere (world_entries/world_keys/fts/files).
    expect(db.getWorldEntry(oldId)).toBeNull()
    expect(db.worldKeys(oldId)).toEqual([])
    expect(report.removed).toContainEqual({ kind: 'world', id: oldId, path: rel })
    await expectIndexEqualsRebuild()
  })

  it('keeps a section dir renamed to a non-conforming name: reconcile AND fullRebuild agree', async () => {
    // Section dir names are a human mirror only — the predicate is a valid
    // section.json (§5.2). A hand-renamed dir must neither vanish from the index nor
    // from a from-scratch rebuild.
    const oldAbs = path.join(sectionsDir(workDir), SEC2_DIR)
    const newAbs = path.join(sectionsDir(workDir), 'my own chapter folder')
    await fsp.rename(oldAbs, newAbs)

    await reconcile({ workDir, db })
    const row = db.getSection(FIX.sec2)
    expect(row?.dirPath).toBe('sections/my own chapter folder')
    expect(
      db
        .listSectionRows()
        .map((s) => s.id)
        .sort(),
    ).toEqual([FIX.sec1, FIX.sec2].sort())
    expect(db.getFile('sections/my own chapter folder/section.json')).not.toBeNull()
    expect(db.getFile(`sections/${SEC2_DIR}/section.json`)).toBeNull()

    // Regression: fullRebuild used to require NNN-slug.shortid dir names and silently
    // dropped renamed sections, breaking index == rebuild.
    await expectIndexEqualsRebuild()
  })

  it('drops the old claimant when a section.json id is swapped in place (no ghost rows)', async () => {
    const secDir = path.join(sectionsDir(workDir), SEC2_DIR)
    const raw = await fsp.readFile(path.join(secDir, 'section.json'), 'utf8')
    const newId = ulid()
    await fsp.writeFile(
      path.join(secDir, 'section.json'),
      raw.replace(FIX.sec2, newId), // same dir, brand-new identity
    )

    const report = await reconcile({ workDir, db })
    const claimants = db.listSectionRows().filter((s) => s.dirPath === `sections/${SEC2_DIR}`)
    expect(claimants.map((s) => s.id)).toEqual([newId])
    expect(db.getSection(FIX.sec2)).toBeNull()
    expect(report.removed).toContainEqual({
      kind: 'section',
      id: FIX.sec2,
      path: `sections/${SEC2_DIR}`,
    })
    await expectIndexEqualsRebuild()
  })

  it('drops a stale snippet claimant when its file is overwritten under a new identity', async () => {
    // Overwrite a fixture snippet file in place with valid frontmatter carrying a
    // fresh, unknown id: the path is adopted as a new entity while the old snippet's
    // rows still claim it.
    const rel = `frontier/snippets/${SNIP1_FILE}`
    const abs = path.join(frontierSnippetsDir(workDir), SNIP1_FILE)
    const newId = ulid()
    await fsp.writeFile(
      abs,
      snippetFileText(
        {
          id: newId,
          orderKey: 'a0',
          createdAt: '2026-07-06T15:00:00Z',
          updatedAt: '2026-07-06T15:00:00Z',
          authorship: 'user',
          originRunId: null,
          rev: 1,
        },
        'Entirely new prose pasted over the old file.\n',
      ),
    )
    const report = await reconcile({ workDir, db })

    expect(db.getSnippet(newId)).not.toBeNull()
    expect(db.getSnippet(FIX.snip1)).toBeNull()
    expect(report.removed).toContainEqual({ kind: 'snippet', id: FIX.snip1, path: rel })
    // The old snippet's revision log survives on disk and stays tracked as an orphan.
    expect(db.getFile(`frontier/revisions/${FIX.snip1}.jsonl`)).not.toBeNull()
    await expectIndexEqualsRebuild()
  })
})
