import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { IllustrationMeta, SectionMeta } from '@cowrite/shared'
import { ulid } from 'ulid'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { xxh64OfString } from './lib/hash.js'
import { sectionDirName, sectionsDir } from './lib/paths.js'
import {
  clearSuppression,
  findSection,
  getSectionContent,
  getSummaries,
  putIllustration,
  putSummary,
  readSectionMeta,
  replaceSectionContent,
  replaceSectionSpan,
  SectionNotFoundError,
  setSectionTitle,
  suppressIllustration,
  walkSectionTree,
  writeSectionMeta,
} from './sectionStore.js'

let workDir: string

beforeEach(async () => {
  workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cowrite-section-'))
})

afterEach(async () => {
  await fsp.rm(workDir, { recursive: true, force: true })
})

function newMeta(orderKey: string, overrides: Partial<SectionMeta> = {}): SectionMeta {
  return SectionMeta.parse({
    schemaVersion: 1,
    id: ulid(),
    kind: 'chapter',
    orderKey,
    title: null,
    titleSource: 'agent',
    frozenAt: null,
    contentHash: null,
    enrichments: { shortSummary: null, longSummary: null, illustration: null },
    ...overrides,
  })
}

/** Materialize a section dir the way the consolidation engine will (§6.4). */
async function makeSection(
  parentDirPath: string,
  prefix: number,
  slug: string,
  meta: SectionMeta,
  content?: string,
): Promise<string> {
  const dir = path.join(parentDirPath, sectionDirName(prefix, slug, meta.id))
  if (content === undefined) {
    await writeSectionMeta(dir, meta)
  } else {
    await writeSectionMeta(dir, { ...meta, contentHash: await xxh64OfString(content) })
    await fsp.writeFile(path.join(dir, 'content.md'), content, 'utf8')
  }
  return dir
}

function illustrationFixture(): IllustrationMeta {
  return IllustrationMeta.parse({
    source: 'agent',
    runId: ulid(),
    generatedAt: new Date().toISOString(),
    sourceHash: null,
    sourceWordCount: 120,
    entities: [],
    prompt: 'a lighthouse in a storm',
    workflow: 'default',
    workflowHash: null,
    seed: 7,
    attempts: 1,
    score: 8,
    guidance: null,
  })
}

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

describe('readSectionMeta / writeSectionMeta', () => {
  it('round-trips through the shared schema', async () => {
    const meta = newMeta('a0', { title: 'The Storm Glass', frozenAt: '2026-07-01T00:00:00Z' })
    const dir = await makeSection(sectionsDir(workDir), 10, 'the-storm-glass', meta)
    expect(await readSectionMeta(dir)).toEqual(meta)
  })

  it('throws on a missing section.json', async () => {
    await expect(readSectionMeta(path.join(workDir, 'nope'))).rejects.toThrow(
      /section.json not found/,
    )
  })
})

describe('walkSectionTree', () => {
  it('walks depth-first with orderKey order, depth, parentId and leaf detection', async () => {
    const root = sectionsDir(workDir)
    // Filename prefixes deliberately contradict orderKeys: metadata must win (§4).
    const partMeta = newMeta('a1', { kind: 'part' })
    const partDir = await makeSection(root, 90, 'part-one', partMeta)
    const chapterMeta = newMeta('a0')
    await makeSection(root, 10, 'late-chapter', chapterMeta, 'chapter prose')
    const childMeta = newMeta('a0')
    await makeSection(partDir, 10, 'nested', childMeta, 'nested prose')
    // Not a section dir (no section.json): skipped, reconciler's problem (§8).
    await fsp.mkdir(path.join(root, 'drafts'), { recursive: true })

    const nodes = await walkSectionTree(workDir)
    expect(nodes.map((n) => n.meta.id)).toEqual([chapterMeta.id, partMeta.id, childMeta.id])
    expect(nodes.map((n) => n.depth)).toEqual([0, 0, 1])
    expect(nodes.map((n) => n.parentId)).toEqual([null, null, partMeta.id])
    expect(nodes.map((n) => n.leaf)).toEqual([true, false, true])
  })

  it('walks an absent sections dir as empty', async () => {
    expect(await walkSectionTree(workDir)).toEqual([])
  })

  it('findSection throws SectionNotFoundError for unknown ids', async () => {
    await expect(findSection(workDir, ulid())).rejects.toBeInstanceOf(SectionNotFoundError)
  })

  it('findSection resolves via a dir_path hint without walking, and verifies the id', async () => {
    const root = sectionsDir(workDir)
    const partMeta = newMeta('a0', { kind: 'part' })
    const partDir = await makeSection(root, 10, 'part-one', partMeta)
    const childMeta = newMeta('a0')
    const childDir = await makeSection(partDir, 10, 'nested', childMeta, 'nested prose')

    const hint = path.relative(workDir, childDir).split(path.sep).join('/')
    const node = await findSection(workDir, childMeta.id, hint)
    expect(node.meta.id).toBe(childMeta.id)
    expect(node.depth).toBe(1)
    expect(node.parentId).toBe(partMeta.id)
    expect(node.leaf).toBe(true)

    // a WRONG hint (different section's dir) must fall back to the walk, not misfire
    const wrongHint = path.relative(workDir, partDir).split(path.sep).join('/')
    const viaFallback = await findSection(workDir, childMeta.id, wrongHint)
    expect(viaFallback.meta.id).toBe(childMeta.id)
    expect(viaFallback.parentId).toBe(partMeta.id)

    // a stale hint at a vanished dir also falls back
    const gone = await findSection(workDir, partMeta.id, 'sections/no-such-dir.zzzzzz')
    expect(gone.meta.id).toBe(partMeta.id)
  })
})

describe('getSectionContent', () => {
  it('returns text plus its xxh64 token', async () => {
    const meta = newMeta('a0')
    await makeSection(sectionsDir(workDir), 10, 'ch', meta, 'the prose')
    const { text, contentHash } = await getSectionContent(workDir, meta.id)
    expect(text).toBe('the prose')
    expect(contentHash).toBe(await xxh64OfString('the prose'))
  })

  it('throws for interior sections', async () => {
    const meta = newMeta('a0', { kind: 'part' })
    await makeSection(sectionsDir(workDir), 10, 'part', meta)
    await expect(getSectionContent(workDir, meta.id)).rejects.toThrow(/no content.md/)
  })
})

describe('replaceSectionContent', () => {
  it('replaces content and updates section.json contentHash', async () => {
    const meta = newMeta('a0')
    const dir = await makeSection(sectionsDir(workDir), 10, 'ch', meta, 'v1')
    const base = await xxh64OfString('v1')
    const result = await replaceSectionContent(workDir, meta.id, 'v2', { baseHash: base })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.contentHash).toBe(await xxh64OfString('v2'))
    expect((await getSectionContent(workDir, meta.id)).text).toBe('v2')
    expect((await readSectionMeta(dir)).contentHash).toBe(result.contentHash)
  })

  it('returns the current hash as a conflict on a stale baseHash', async () => {
    const meta = newMeta('a0')
    await makeSection(sectionsDir(workDir), 10, 'ch', meta, 'v1')
    // Simulate an external edit (VS Code, §6.5).
    const result = await replaceSectionContent(workDir, meta.id, 'clobber', {
      baseHash: await xxh64OfString('something the editor saw earlier'),
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.conflict.currentHash).toBe(await xxh64OfString('v1'))
    // §8's theirs/mine prompt needs the current text alongside the hash
    expect(result.conflict.currentText).toBe('v1')
    expect((await getSectionContent(workDir, meta.id)).text).toBe('v1')
  })

  it('accepts baseHash null as "no content yet"', async () => {
    const meta = newMeta('a0')
    await makeSection(sectionsDir(workDir), 10, 'ch', meta)
    const result = await replaceSectionContent(workDir, meta.id, 'first prose', { baseHash: null })
    expect(result.ok).toBe(true)
    expect((await getSectionContent(workDir, meta.id)).text).toBe('first prose')
  })
})

describe('replaceSectionSpan', () => {
  it('splices the span against the baseHash text', async () => {
    const meta = newMeta('a0')
    await makeSection(sectionsDir(workDir), 10, 'ch', meta, 'The quick brown fox')
    const base = await xxh64OfString('The quick brown fox')
    const result = await replaceSectionSpan(
      workDir,
      meta.id,
      { startChar: 4, endChar: 9 },
      'slow',
      {
        baseHash: base,
      },
    )
    expect(result.ok).toBe(true)
    expect((await getSectionContent(workDir, meta.id)).text).toBe('The slow brown fox')
  })

  it('conflicts before validating the span (offsets are meaningless on other text)', async () => {
    const meta = newMeta('a0')
    await makeSection(sectionsDir(workDir), 10, 'ch', meta, 'short')
    const result = await replaceSectionSpan(
      workDir,
      meta.id,
      { startChar: 0, endChar: 9999 },
      'x',
      { baseHash: await xxh64OfString('some other text') },
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.conflict.currentText).toBe('short')
  })

  it('throws RangeError for an invalid span against the matching text', async () => {
    const meta = newMeta('a0')
    await makeSection(sectionsDir(workDir), 10, 'ch', meta, 'short')
    const base = await xxh64OfString('short')
    await expect(
      replaceSectionSpan(workDir, meta.id, { startChar: 2, endChar: 99 }, 'x', { baseHash: base }),
    ).rejects.toBeInstanceOf(RangeError)
    await expect(
      replaceSectionSpan(workDir, meta.id, { startChar: 3, endChar: 1 }, 'x', { baseHash: base }),
    ).rejects.toBeInstanceOf(RangeError)
  })
})

describe('setSectionTitle', () => {
  it('applies user and agent titles and records titleSource', async () => {
    const meta = newMeta('a0')
    const dir = await makeSection(sectionsDir(workDir), 10, 'ch', meta, 'x')
    expect(await setSectionTitle(workDir, meta.id, 'Agent Title', { source: 'agent' })).toEqual({
      applied: true,
    })
    expect(await readSectionMeta(dir)).toMatchObject({ title: 'Agent Title', titleSource: 'agent' })
    expect(await setSectionTitle(workDir, meta.id, 'My Title', { source: 'user' })).toEqual({
      applied: true,
    })
    expect(await readSectionMeta(dir)).toMatchObject({ title: 'My Title', titleSource: 'user' })
  })

  it('never lets an agent overwrite a user title (§2.5 pinning)', async () => {
    const meta = newMeta('a0')
    const dir = await makeSection(sectionsDir(workDir), 10, 'ch', meta, 'x')
    await setSectionTitle(workDir, meta.id, 'User Chose This', { source: 'user' })
    expect(await setSectionTitle(workDir, meta.id, 'Agent Rename', { source: 'agent' })).toEqual({
      applied: false,
    })
    expect(await readSectionMeta(dir)).toMatchObject({
      title: 'User Chose This',
      titleSource: 'user',
    })
  })
})

describe('putSummary', () => {
  it('writes the summary file and EnrichmentMeta with the CURRENT content hash (§6.5)', async () => {
    const meta = newMeta('a0')
    const dir = await makeSection(sectionsDir(workDir), 10, 'ch', meta, 'prose v1')
    const runId = ulid()
    const enrichment = await putSummary(workDir, meta.id, 'short', 'A summary.', {
      source: 'agent',
      runId,
    })
    expect(enrichment.runId).toBe(runId)
    expect(enrichment.source).toBe('agent')
    expect(enrichment.sourceHash).toBe(await xxh64OfString('prose v1'))
    expect(await fsp.readFile(path.join(dir, 'summary-short.md'), 'utf8')).toBe('A summary.')
    expect((await readSectionMeta(dir)).enrichments.shortSummary).toEqual(enrichment)
    // Long summaries land in their own slot and file.
    await putSummary(workDir, meta.id, 'long', 'Longer.', { source: 'agent', runId })
    expect(await fsp.readFile(path.join(dir, 'summary-long.md'), 'utf8')).toBe('Longer.')
    expect((await readSectionMeta(dir)).enrichments.shortSummary).toEqual(enrichment)
  })

  it('forces runId null for user-edited summaries (§10.3)', async () => {
    const meta = newMeta('a0')
    await makeSection(sectionsDir(workDir), 10, 'ch', meta, 'prose')
    const enrichment = await putSummary(workDir, meta.id, 'short', 'User summary.', {
      source: 'user',
      runId: ulid(),
    })
    expect(enrichment.runId).toBeNull()
  })

  it('rejects summaries on interior sections', async () => {
    const meta = newMeta('a0', { kind: 'part' })
    await makeSection(sectionsDir(workDir), 10, 'part', meta)
    await expect(
      putSummary(workDir, meta.id, 'short', 'x', { source: 'agent', runId: ulid() }),
    ).rejects.toThrow(/leaf-only/)
  })
})

describe('getSummaries', () => {
  it('reads both summary files, null for missing ones (03 §3.2 lazy fetch)', async () => {
    const meta = newMeta('a0')
    await makeSection(sectionsDir(workDir), 10, 'ch', meta, 'prose here')
    expect(await getSummaries(workDir, meta.id)).toEqual({ short: null, long: null })

    await putSummary(workDir, meta.id, 'short', 'S text', { source: 'user' })
    expect(await getSummaries(workDir, meta.id)).toEqual({ short: 'S text', long: null })

    await putSummary(workDir, meta.id, 'long', 'L text', { source: 'agent', runId: ulid() })
    expect(await getSummaries(workDir, meta.id)).toEqual({ short: 'S text', long: 'L text' })
  })

  it('reads null/null on an interior section and throws for unknown ids', async () => {
    const meta = newMeta('a0', { kind: 'part' })
    await makeSection(sectionsDir(workDir), 10, 'part', meta)
    expect(await getSummaries(workDir, meta.id)).toEqual({ short: null, long: null })
    await expect(getSummaries(workDir, ulid())).rejects.toBeInstanceOf(SectionNotFoundError)
  })
})

describe('illustration slot (§2.5 three states)', () => {
  it('putIllustration writes the PNG and the meta', async () => {
    const meta = newMeta('a0')
    const dir = await makeSection(sectionsDir(workDir), 10, 'ch', meta, 'x')
    const illo = illustrationFixture()
    await putIllustration(workDir, meta.id, PNG_BYTES, illo)
    expect(new Uint8Array(await fsp.readFile(path.join(dir, 'illustration.png')))).toEqual(
      PNG_BYTES,
    )
    expect((await readSectionMeta(dir)).enrichments.illustration).toEqual(illo)
  })

  it('suppressIllustration removes the PNG and writes the tombstone', async () => {
    const meta = newMeta('a0')
    const dir = await makeSection(sectionsDir(workDir), 10, 'ch', meta, 'x')
    await putIllustration(workDir, meta.id, PNG_BYTES, illustrationFixture())
    await suppressIllustration(workDir, meta.id)
    await expect(fsp.stat(path.join(dir, 'illustration.png'))).rejects.toThrow()
    const slot = (await readSectionMeta(dir)).enrichments.illustration
    expect(slot).toMatchObject({ suppressed: true })
  })

  it('clearSuppression lifts a tombstone back to null and leaves a present image alone', async () => {
    const meta = newMeta('a0')
    const dir = await makeSection(sectionsDir(workDir), 10, 'ch', meta, 'x')
    await suppressIllustration(workDir, meta.id)
    await clearSuppression(workDir, meta.id)
    expect((await readSectionMeta(dir)).enrichments.illustration).toBeNull()

    const illo = illustrationFixture()
    await putIllustration(workDir, meta.id, PNG_BYTES, illo)
    await clearSuppression(workDir, meta.id)
    expect((await readSectionMeta(dir)).enrichments.illustration).toEqual(illo)
  })
})
