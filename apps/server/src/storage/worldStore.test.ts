import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { IllustrationMeta } from '@cowrite/shared'
import { ulid } from 'ulid'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fsx from './lib/fsx.js'
import { xxh64OfString } from './lib/hash.js'
import { shortId, worldEntriesDir, worldImagesDir } from './lib/paths.js'
import type { WorldEntry } from './storageTypes.js'
import {
  deleteWorldEntry,
  getWorldEntry,
  listWorldEntries,
  matchWorldEntries,
  putWorldImage,
  upsertWorldEntry,
  WorldEntryNotFoundError,
  type WorldEntryUpsert,
} from './worldStore.js'

let workDir: string

/** Tokenless upserts are last-write-wins and can never conflict — unwrap the ok arm. */
async function upsertOk(dir: string, input: WorldEntryUpsert): Promise<WorldEntry> {
  const res = await upsertWorldEntry(dir, input)
  if (!res.ok) throw new Error('unexpected world upsert conflict')
  return res.entry
}

beforeEach(async () => {
  workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cowrite-world-'))
})

afterEach(async () => {
  await fsp.rm(workDir, { recursive: true, force: true })
})

describe('upsertWorldEntry', () => {
  it('creates an entry with §5.4 frontmatter and defaults', async () => {
    const entry = await upsertOk(workDir, {
      name: 'Mara Voss',
      keys: ['Mara', 'Voss', 'the keeper'],
      shortSummary: 'Lighthouse keeper of Cinder Point.',
      createdBy: 'user',
      body: 'Mara Voss has kept the Cinder Point light for eleven years.',
    })
    expect(path.basename(entry.filePath)).toBe(`mara-voss.${shortId(entry.meta.id)}.md`)
    const read = await getWorldEntry(workDir, entry.meta.id)
    expect(read.meta).toEqual(entry.meta)
    expect(read.body).toBe(entry.body)
    expect(read.meta.image).toBeNull()

    // An entry with no keys is fully legitimate (§2.6).
    const keyless = await upsertOk(workDir, {
      name: 'The Storm Glass',
      createdBy: 'agent',
      body: 'An instrument.',
    })
    expect(keyless.meta.keys).toEqual([])
  })

  it('updates in place by id, keeping the file path and unspecified fields', async () => {
    const created = await upsertOk(workDir, {
      name: 'Mara Voss',
      keys: ['Mara'],
      createdBy: 'user',
      body: 'v1',
    })
    const updated = await upsertOk(workDir, {
      id: created.meta.id,
      name: 'Mara "the Keeper" Voss', // name change must NOT move the file
      createdBy: 'user',
      body: 'v2',
    })
    expect(updated.filePath).toBe(created.filePath)
    expect(updated.meta.keys).toEqual(['Mara']) // preserved
    const read = await getWorldEntry(workDir, created.meta.id)
    expect(read.body).toBe('v2')
    expect(read.meta.name).toBe('Mara "the Keeper" Voss')
    expect(await listWorldEntries(workDir)).toHaveLength(1)
  })

  it('honors baseHash: fresh token writes, stale token returns the conflict shape (§6.6)', async () => {
    const created = await upsertOk(workDir, { name: 'Mara', createdBy: 'user', body: 'v1' })
    const freshToken = await xxh64OfString('v1')
    const ok = await upsertWorldEntry(workDir, {
      id: created.meta.id,
      name: 'Mara',
      createdBy: 'user',
      body: 'v2',
      baseHash: freshToken,
    })
    expect(ok.ok).toBe(true)

    const stale = await upsertWorldEntry(workDir, {
      id: created.meta.id,
      name: 'Mara',
      createdBy: 'user',
      body: 'a lost update',
      baseHash: freshToken, // now stale: the body is v2
    })
    expect(stale).toEqual({
      ok: false,
      conflict: { currentHash: await xxh64OfString('v2'), currentText: 'v2' },
    })
    expect((await getWorldEntry(workDir, created.meta.id)).body).toBe('v2')
  })

  it('with baseHash, a vanished entry is a typed NotFound and a create is invalid', async () => {
    await expect(
      upsertWorldEntry(workDir, {
        id: ulid(),
        name: 'Ghost',
        createdBy: 'user',
        body: 'x',
        baseHash: await xxh64OfString('x'),
      }),
    ).rejects.toBeInstanceOf(WorldEntryNotFoundError)
    await expect(
      upsertWorldEntry(workDir, {
        name: 'No Id',
        createdBy: 'user',
        body: 'x',
        baseHash: await xxh64OfString('x'),
      }),
    ).rejects.toThrow(/baseHash requires an entry id/)
  })
})

describe('listWorldEntries', () => {
  it('sorts by name and skips files without valid frontmatter', async () => {
    await upsertOk(workDir, { name: 'Zeph', createdBy: 'user', body: 'z' })
    await upsertOk(workDir, { name: 'Anchor', createdBy: 'user', body: 'a' })
    await fsp.writeFile(path.join(worldEntriesDir(workDir), 'stray.md'), 'no frontmatter', 'utf8')
    const entries = await listWorldEntries(workDir)
    expect(entries.map((e) => e.meta.name)).toEqual(['Anchor', 'Zeph'])
  })

  it('returns [] when the world dir does not exist', async () => {
    expect(await listWorldEntries(workDir)).toEqual([])
  })
})

describe('deleteWorldEntry', () => {
  it('removes the entry file and its image assets', async () => {
    const entry = await upsertOk(workDir, { name: 'Doomed', createdBy: 'user', body: 'x' })
    await putWorldImage(workDir, entry.meta.id, Uint8Array.from([1, 2, 3]), illustrationFixture())
    await deleteWorldEntry(workDir, entry.meta.id)
    await expect(getWorldEntry(workDir, entry.meta.id)).rejects.toBeInstanceOf(
      WorldEntryNotFoundError,
    )
    const images = await fsp.readdir(worldImagesDir(workDir))
    expect(images).toEqual([])
  })
})

function illustrationFixture(): IllustrationMeta {
  return IllustrationMeta.parse({
    source: 'agent',
    runId: ulid(),
    generatedAt: new Date().toISOString(),
    sourceHash: null,
    sourceWordCount: null, // null for world images (08)
    entities: [],
    prompt: 'portrait of Mara Voss',
    workflow: 'default',
    workflowHash: null,
    seed: 3,
    attempts: 1,
    score: 9,
    guidance: null,
  })
}

describe('putWorldImage', () => {
  it('writes PNG + sidecar meta and points the entry image field at it (work-relative)', async () => {
    const entry = await upsertOk(workDir, { name: 'Mara', createdBy: 'user', body: 'x' })
    const meta = illustrationFixture()
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47])
    const { imagePath } = await putWorldImage(workDir, entry.meta.id, png, meta)
    expect(imagePath).toBe(`world/images/${entry.meta.id}.png`)

    const dir = worldImagesDir(workDir)
    expect(new Uint8Array(await fsp.readFile(path.join(dir, `${entry.meta.id}.png`)))).toEqual(png)
    const sidecar = IllustrationMeta.parse(
      JSON.parse(await fsp.readFile(path.join(dir, `${entry.meta.id}.json`), 'utf8')),
    )
    expect(sidecar).toEqual(meta)
    expect((await getWorldEntry(workDir, entry.meta.id)).meta.image).toBe(imagePath)
  })

  it('throws for an unknown entry', async () => {
    await expect(
      putWorldImage(workDir, ulid(), Uint8Array.from([1]), illustrationFixture()),
    ).rejects.toBeInstanceOf(WorldEntryNotFoundError)
  })

  it('a crash mid first-generation leaves no orphaned, invisible PNG (§14)', async () => {
    const entry = await upsertOk(workDir, { name: 'Mara', createdBy: 'user', body: 'x' })
    expect(entry.meta.image).toBeNull()

    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    // Fail the frontmatter write (the entry .md that would make the image visible), simulating a
    // crash mid-commit before the PNG is swapped into place.
    const real = fsx.writeFileAtomic
    const spy = vi.spyOn(fsx, 'writeFileAtomic').mockImplementation(async (p, data) => {
      if (String(p).endsWith('.md')) throw new Error('disk full writing the entry frontmatter')
      return real(p, data)
    })
    try {
      await expect(
        putWorldImage(workDir, entry.meta.id, png, illustrationFixture()),
      ).rejects.toThrow('disk full')
    } finally {
      spy.mockRestore()
    }

    // The entry still shows no image (invisible == "no generation happened"), and — crucially —
    // there is NO orphaned PNG left in world/images that nothing references.
    expect((await getWorldEntry(workDir, entry.meta.id)).meta.image).toBeNull()
    const finalPng = path.join(worldImagesDir(workDir), `${entry.meta.id}.png`)
    await expect(fsp.stat(finalPng)).rejects.toThrow()
    await expect(fsp.stat(`${finalPng}.staging`)).rejects.toThrow()
  })
})

describe('matchWorldEntries (pure key scan, §2.6)', () => {
  async function fixtures() {
    const mara = await upsertOk(workDir, {
      name: 'Mara Voss',
      keys: ['Mara', 'Voss', 'the keeper'],
      createdBy: 'user',
      body: '',
    })
    const glass = await upsertOk(workDir, {
      name: 'The Storm Glass',
      keys: [],
      createdBy: 'user',
      body: '',
    })
    return { mara, glass, all: await listWorldEntries(workDir) }
  }

  it('matches names and keys case-insensitively', async () => {
    const { mara, all } = await fixtures()
    expect(matchWorldEntries(all, 'then VOSS turned away').map((e) => e.meta.id)).toEqual([
      mara.meta.id,
    ])
    expect(matchWorldEntries(all, 'she asked the Keeper about it')).toHaveLength(1)
  })

  it('matches a keyless entry by its name, as a phrase', async () => {
    const { glass, all } = await fixtures()
    const hits = matchWorldEntries(all, 'she held the storm glass up to the light')
    expect(hits.map((e) => e.meta.id)).toEqual([glass.meta.id])
  })

  it('is whole-word-ish: no substring hits inside larger words', async () => {
    const { all } = await fixtures()
    expect(matchWorldEntries(all, 'the marauders swarmed the docks')).toEqual([])
    expect(matchWorldEntries(all, 'the Vossberg cliffs loomed')).toEqual([])
  })

  it('tolerates punctuation boundaries', async () => {
    const { mara, all } = await fixtures()
    expect(matchWorldEntries(all, '"Mara!" he shouted.').map((e) => e.meta.id)).toEqual([
      mara.meta.id,
    ])
  })

  it('returns [] for no matches and empty text', async () => {
    const { all } = await fixtures()
    expect(matchWorldEntries(all, 'nothing relevant here')).toEqual([])
    expect(matchWorldEntries(all, '')).toEqual([])
  })
})
