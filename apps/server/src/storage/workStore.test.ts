import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { WorkMeta } from '@cowrite/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { trashMarkerPath, trashRoot, workDir, workMetaPath, worksRoot } from './lib/paths.js'
import { createWork, listWorks, readWorkMeta, trashWork, writeWorkMeta } from './workStore.js'

let dataDir: string

beforeEach(async () => {
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cowrite-work-'))
})

afterEach(async () => {
  await fsp.rm(dataDir, { recursive: true, force: true })
})

describe('createWork', () => {
  it('writes work.json from WorkMeta defaults', async () => {
    const { slug, meta, dirPath } = await createWork(dataDir, 'Salt and Signal')
    expect(slug).toBe('salt-and-signal')
    expect(dirPath).toBe(workDir(dataDir, slug))
    expect(meta.schemaVersion).toBe(1)
    expect(meta.title).toBe('Salt and Signal')
    expect(meta.levelScheme).toEqual(['chapter'])
    expect(meta.settings.consolidation.maxFrontierSnippets).toBe(18)
    expect(meta.settings.consolidation.mode).toBe('auto')
    // The file round-trips through the shared schema.
    const onDisk = WorkMeta.parse(JSON.parse(await fsp.readFile(workMetaPath(dirPath), 'utf8')))
    expect(onDisk).toEqual(meta)
  })

  it('materializes the canonical directory skeleton', async () => {
    const { dirPath } = await createWork(dataDir, 'W')
    for (const sub of [
      'sections',
      path.join('frontier', 'snippets'),
      path.join('frontier', 'revisions'),
      path.join('world', 'entries'),
      path.join('world', 'images'),
      'runs',
      '.cowrite',
    ]) {
      const stat = await fsp.stat(path.join(dirPath, sub))
      expect(stat.isDirectory()).toBe(true)
    }
  })

  it('suffixes colliding slugs', async () => {
    const a = await createWork(dataDir, 'Storm')
    const b = await createWork(dataDir, 'Storm!')
    const c = await createWork(dataDir, 'storm')
    expect(a.slug).toBe('storm')
    expect(b.slug).toBe('storm-2')
    expect(c.slug).toBe('storm-3')
    expect(a.meta.id).not.toBe(b.meta.id)
  })
})

describe('readWorkMeta / writeWorkMeta', () => {
  it('round-trips edits', async () => {
    const { dirPath, meta } = await createWork(dataDir, 'W')
    await writeWorkMeta(dirPath, { ...meta, levelScheme: ['part', 'chapter'] })
    const read = await readWorkMeta(dirPath)
    expect(read.levelScheme).toEqual(['part', 'chapter'])
    expect(read.id).toBe(meta.id)
  })

  it('throws on a missing work.json', async () => {
    await expect(readWorkMeta(path.join(dataDir, 'nope'))).rejects.toThrow(/work.json not found/)
  })

  it('rejects invalid metadata at write time', async () => {
    const { dirPath, meta } = await createWork(dataDir, 'W')
    await expect(writeWorkMeta(dirPath, { ...meta, title: '' })).rejects.toThrow()
  })
})

describe('listWorks', () => {
  it('returns [] for a data dir with no works', async () => {
    expect(await listWorks(dataDir)).toEqual([])
  })

  it('lists healthy works sorted by slug and flags broken ones as warnings', async () => {
    await createWork(dataDir, 'Beta')
    await createWork(dataDir, 'Alpha')
    // Broken: unparsable JSON.
    const brokenDir = workDir(dataDir, 'zz-broken')
    await fsp.mkdir(brokenDir, { recursive: true })
    await fsp.writeFile(workMetaPath(brokenDir), '{not json', 'utf8')
    // Broken: directory without work.json.
    await fsp.mkdir(workDir(dataDir, 'zz-empty'), { recursive: true })
    // Stray file directly under works/ is ignored.
    await fsp.writeFile(path.join(worksRoot(dataDir), 'notes.txt'), 'x', 'utf8')

    const works = await listWorks(dataDir)
    expect(works.map((w) => w.slug)).toEqual(['alpha', 'beta', 'zz-broken', 'zz-empty'])
    expect(works.map((w) => w.ok)).toEqual([true, true, false, false])
    const broken = works[2]
    if (broken?.ok !== false) throw new Error('expected warning entry')
    expect(broken.warning).toBeTruthy()
  })
})

describe('trashWork', () => {
  it('moves the work into .trash and writes the trash marker', async () => {
    const { slug, meta } = await createWork(dataDir, 'Doomed')
    const trashed = await trashWork(dataDir, slug)
    expect(trashed.originalSlug).toBe(slug)
    // The work directory is gone and no longer listed.
    await expect(fsp.stat(workDir(dataDir, slug))).rejects.toThrow()
    expect(await listWorks(dataDir)).toEqual([])
    // The whole dir (prose included) lives on under .trash/<slug>-<ts>/.
    expect(path.dirname(trashed.trashedTo)).toBe(trashRoot(dataDir))
    expect(path.basename(trashed.trashedTo).startsWith(`${slug}-`)).toBe(true)
    const movedMeta = await readWorkMeta(trashed.trashedTo)
    expect(movedMeta.id).toBe(meta.id)
    const marker = JSON.parse(await fsp.readFile(trashMarkerPath(trashed.trashedTo), 'utf8'))
    expect(marker).toEqual({ deletedAt: trashed.deletedAt, originalSlug: slug })
  })

  it('uses a Windows-safe timestamp directory name', async () => {
    const { slug } = await createWork(dataDir, 'W')
    const { trashedTo } = await trashWork(dataDir, slug)
    expect(path.basename(trashedTo)).not.toMatch(/[:.]/)
  })

  it('throws for an unknown slug', async () => {
    await expect(trashWork(dataDir, 'ghost')).rejects.toThrow(/work not found/)
  })
})
