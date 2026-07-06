import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { IllustrationMeta } from '@cowrite/shared'
import { ulid } from 'ulid'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { shortId, worldEntriesDir, worldImagesDir } from './lib/paths.js'
import {
  deleteWorldEntry,
  getWorldEntry,
  listWorldEntries,
  matchWorldEntries,
  putWorldImage,
  upsertWorldEntry,
  WorldEntryNotFoundError,
} from './worldStore.js'

let workDir: string

beforeEach(async () => {
  workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cowrite-world-'))
})

afterEach(async () => {
  await fsp.rm(workDir, { recursive: true, force: true })
})

describe('upsertWorldEntry', () => {
  it('creates an entry with §5.4 frontmatter and defaults', async () => {
    const entry = await upsertWorldEntry(workDir, {
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
    const keyless = await upsertWorldEntry(workDir, {
      name: 'The Storm Glass',
      createdBy: 'agent',
      body: 'An instrument.',
    })
    expect(keyless.meta.keys).toEqual([])
  })

  it('updates in place by id, keeping the file path and unspecified fields', async () => {
    const created = await upsertWorldEntry(workDir, {
      name: 'Mara Voss',
      keys: ['Mara'],
      createdBy: 'user',
      body: 'v1',
    })
    const updated = await upsertWorldEntry(workDir, {
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
})

describe('listWorldEntries', () => {
  it('sorts by name and skips files without valid frontmatter', async () => {
    await upsertWorldEntry(workDir, { name: 'Zeph', createdBy: 'user', body: 'z' })
    await upsertWorldEntry(workDir, { name: 'Anchor', createdBy: 'user', body: 'a' })
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
    const entry = await upsertWorldEntry(workDir, { name: 'Doomed', createdBy: 'user', body: 'x' })
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
    const entry = await upsertWorldEntry(workDir, { name: 'Mara', createdBy: 'user', body: 'x' })
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
})

describe('matchWorldEntries (pure key scan, §2.6)', () => {
  async function fixtures() {
    const mara = await upsertWorldEntry(workDir, {
      name: 'Mara Voss',
      keys: ['Mara', 'Voss', 'the keeper'],
      createdBy: 'user',
      body: '',
    })
    const glass = await upsertWorldEntry(workDir, {
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
