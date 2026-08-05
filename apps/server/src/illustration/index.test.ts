import { beforeAll, describe, expect, it } from 'vitest'
import { loadTemplates, type TemplateSet } from '../prompt/templates/loader.js'
import type { SectionRow } from '../storage/index/db.js'
import type { WorkflowRegistry } from './comfy/registry.js'
import { IllustrationAbortedError, IllustrationError } from './ctx.js'
import { IllustrationPipeline } from './index.js'
import {
  critiqueText,
  FakeStorage,
  fakeRegistry,
  fakeWorkflow,
  imagePromptText,
  makeCtx,
} from './testkit.js'

let templates: TemplateSet
beforeAll(async () => {
  templates = await loadTemplates()
})

const SECTION_ID = '01J2KF8T4YB1HZQX7WN2SDEA11'
const ENTRY_ID = '01J2N9AAE2QRSTK4MP7Y3XCD02'

function sectionRow(overrides: Partial<SectionRow> = {}): SectionRow {
  return {
    id: SECTION_ID,
    parentId: null,
    kind: 'chapter',
    orderKey: 'a0',
    title: 'The Storm Glass',
    titleSource: 'agent',
    dirPath: 'sections/001-the-storm-glass.abc',
    wordCount: 3,
    contentHash: 'xxh64:1111111111111111',
    frozenAt: '2026-08-01T00:00:00.000Z',
    shortSummaryStale: false,
    longSummaryStale: false,
    illustrationStale: true,
    illustrationHash: null,
    illustrationWidth: null,
    illustrationHeight: null,
    shortSummary: null,
    longSummary: 'Mara retrieves the storm glass.',
    ...overrides,
  }
}

function sectionStorage(): FakeStorage {
  const storage = new FakeStorage()
  storage.sections.set(SECTION_ID, {
    row: sectionRow(),
    content: 'Mara retrieves it.',
    contentHash: 'xxh64:1111111111111111',
    long: 'Mara retrieves the storm glass from the sealed lamp room.',
  })
  return storage
}

function scriptHappyLoop(h: ReturnType<typeof makeCtx>): void {
  h.comfy.pngs = [Buffer.from('winner-png')]
  h.lowClient.promptResponses = [imagePromptText('a woman with cropped grey hair holds a lantern')]
  h.lowClient.critiqueResponses = [critiqueText({ verdict: 'accept', overall: 8 })]
}

describe('IllustrationPipeline.runSectionIllustration', () => {
  it('commits the winner with a full IllustrationMeta and returns the artifact', async () => {
    const storage = sectionStorage()
    const h = makeCtx(templates, { storage, runId: '01J2P7R9GT5W0ZNXK3M8QAB4CD' })
    scriptHappyLoop(h)

    const pipeline = new IllustrationPipeline({ now: () => new Date('2026-08-04T12:00:00.000Z') })
    const artifacts = await pipeline.runSectionIllustration(SECTION_ID, 'dusk light', h.ctx)

    expect(artifacts).toEqual([{ kind: 'illustration', sectionId: SECTION_ID, state: 'committed' }])
    expect(storage.puts).toHaveLength(1)
    const put = storage.puts[0]
    expect(put?.kind).toBe('section')
    expect(put?.png.toString()).toBe('winner-png')
    const meta = put?.meta
    expect(meta?.source).toBe('agent')
    expect(meta?.runId).toBe('01J2P7R9GT5W0ZNXK3M8QAB4CD')
    expect(meta?.sourceHash).toBe('xxh64:1111111111111111')
    expect(meta?.sourceWordCount).toBe(3) // wordCount('Mara retrieves it.')
    expect(meta?.prompt).toBe('a woman with cropped grey hair holds a lantern')
    expect(meta?.workflow).toBe('default')
    expect(meta?.score).toBe(8)
    expect(meta?.guidance).toBe('dusk light')
    // the committing phase fired
    expect(h.progress.some((p) => p.phase === 'committing')).toBe(true)
  })

  it('throws config_missing when the route workflow is broken/dangling', async () => {
    const registry: WorkflowRegistry = {
      report: {
        workflows: [],
        route: { section: { name: 'default', ok: false }, world: { name: 'default', ok: false } },
      },
      resolve: () => ({
        configMissing: 'route points at workflow "default", which is not defined',
      }),
    }
    const h = makeCtx(templates, { storage: sectionStorage(), registry })
    const pipeline = new IllustrationPipeline()
    await expect(
      pipeline.runSectionIllustration(SECTION_ID, undefined, h.ctx),
    ).rejects.toMatchObject({ code: 'config_missing' })
  })

  it('fails pipeline/comfy_unreachable when the health gate is down', async () => {
    const h = makeCtx(templates, { storage: sectionStorage() })
    h.comfy.healthOk = false
    const pipeline = new IllustrationPipeline()
    await expect(
      pipeline.runSectionIllustration(SECTION_ID, undefined, h.ctx),
    ).rejects.toMatchObject({ code: 'pipeline', detail: 'comfy_unreachable' })
  })

  it('fails pipeline/commit_target_missing when the commit throws (section gone mid-run)', async () => {
    const storage = sectionStorage()
    storage.putShouldThrow = true // a vanished section: not_found-coded
    const h = makeCtx(templates, { storage })
    scriptHappyLoop(h)
    const pipeline = new IllustrationPipeline()
    await expect(
      pipeline.runSectionIllustration(SECTION_ID, undefined, h.ctx),
    ).rejects.toMatchObject({ code: 'pipeline', detail: 'commit_target_missing' })
  })

  it('a disk/permission commit error is a real pipeline failure with the cause logged, NOT commit_target_missing (§15)', async () => {
    const storage = sectionStorage()
    const cause = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    storage.putThrow = cause
    const h = makeCtx(templates, { storage })
    scriptHappyLoop(h)
    const warnings: string[] = []
    const pipeline = new IllustrationPipeline({ warn: (m) => warnings.push(m) })
    const err = await pipeline.runSectionIllustration(SECTION_ID, undefined, h.ctx).catch((e) => e)
    expect(err).toBeInstanceOf(IllustrationError)
    expect(err.code).toBe('pipeline')
    expect(err.detail).toBe('commit_failed')
    expect(err.cause).toBe(cause) // original cause preserved
    expect(warnings.some((w) => w.includes('EACCES'))).toBe(true) // cause logged
    expect(storage.puts).toHaveLength(0)
  })

  it('transcodes non-PNG winner bytes to PNG before commit (§16)', async () => {
    const storage = sectionStorage()
    // JPEG magic bytes — not a PNG; must be transcoded before commit.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01])
    let transcodeCalls = 0
    const imageOps = {
      downscalePng: (p: Uint8Array) => Promise.resolve(p),
      transcodeToPng: (_p: Uint8Array) => {
        transcodeCalls++
        return Promise.resolve(pngBytes)
      },
    }
    const h = makeCtx(templates, { storage, imageOps })
    h.comfy.pngs = [jpeg]
    h.lowClient.promptResponses = [imagePromptText('p1')]
    h.lowClient.critiqueResponses = [critiqueText({ verdict: 'accept', overall: 8 })]

    const pipeline = new IllustrationPipeline()
    await pipeline.runSectionIllustration(SECTION_ID, undefined, h.ctx)
    expect(transcodeCalls).toBe(1)
    const committed = storage.puts[0]?.png as Uint8Array
    expect([...committed.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  })

  it('a transcode failure fails the attempt with a pipeline detail (§16)', async () => {
    const storage = sectionStorage()
    const imageOps = {
      downscalePng: (p: Uint8Array) => Promise.resolve(p),
      transcodeToPng: () => Promise.reject(new Error('undecodable buffer')),
    }
    const h = makeCtx(templates, { storage, imageOps })
    h.comfy.pngs = [Buffer.from([0xff, 0xd8, 0xff])] // non-PNG
    h.lowClient.promptResponses = [imagePromptText('p1')]
    h.lowClient.critiqueResponses = [critiqueText({ verdict: 'accept', overall: 8 })]
    const pipeline = new IllustrationPipeline({ warn: () => {} })
    await expect(
      pipeline.runSectionIllustration(SECTION_ID, undefined, h.ctx),
    ).rejects.toMatchObject({ code: 'pipeline', detail: 'transcode_failed' })
    expect(storage.puts).toHaveLength(0)
  })

  it('an abort that races the final critique drops the candidate before commit (§6)', async () => {
    const storage = sectionStorage()
    // A non-PNG winner forces transcode; transcode aborts the run mid-commit — the pre-put
    // guard must then DROP the candidate rather than commit it.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
    const imageOps = {
      downscalePng: (p: Uint8Array) => Promise.resolve(p),
      transcodeToPng: (p: Uint8Array) => {
        h.abort()
        return Promise.resolve(p)
      },
    }
    const h = makeCtx(templates, { storage, imageOps })
    h.comfy.pngs = [jpeg]
    h.lowClient.promptResponses = [imagePromptText('p1')]
    h.lowClient.critiqueResponses = [critiqueText({ verdict: 'accept', overall: 8 })]
    const pipeline = new IllustrationPipeline()
    await expect(
      pipeline.runSectionIllustration(SECTION_ID, undefined, h.ctx),
    ).rejects.toBeInstanceOf(IllustrationAbortedError)
    expect(storage.puts).toHaveLength(0)
  })
})

describe('IllustrationPipeline.runWorldImage', () => {
  it('commits a world image with entities [entryId] and null source hashes', async () => {
    const storage = new FakeStorage()
    storage.worldEntries.set(ENTRY_ID, {
      meta: { id: ENTRY_ID, name: 'The storm glass' },
      body: 'A teardrop of cloudy glass on a brass gimbal.',
    })
    const h = makeCtx(templates, {
      storage,
      registry: fakeRegistry(fakeWorkflow()),
      runId: '01J2P7R9GT5W0ZNXK3M8QAB4CD',
    })
    h.comfy.pngs = [Buffer.from('glass-png')]
    h.lowClient.promptResponses = [imagePromptText('a teardrop of cloudy glass, glowing softly')]
    h.lowClient.critiqueResponses = [critiqueText({ verdict: 'accept', overall: 9 })]

    const pipeline = new IllustrationPipeline()
    const artifacts = await pipeline.runWorldImage(ENTRY_ID, undefined, h.ctx)

    expect(artifacts).toEqual([{ kind: 'world-image', entryId: ENTRY_ID, state: 'committed' }])
    const meta = storage.puts[0]?.meta
    expect(meta?.entities).toEqual([ENTRY_ID])
    expect(meta?.sourceHash).toBeNull()
    expect(meta?.sourceWordCount).toBeNull()
    expect(meta?.score).toBe(9)
  })

  it('propagates IllustrationError as the failure type', async () => {
    const storage = new FakeStorage() // no entry registered
    const h = makeCtx(templates, { storage })
    const pipeline = new IllustrationPipeline()
    const err = await pipeline.runWorldImage(ENTRY_ID, undefined, h.ctx).catch((e) => e)
    expect(err).toBeInstanceOf(IllustrationError)
    expect(err.detail).toBe('commit_target_missing')
  })
})
