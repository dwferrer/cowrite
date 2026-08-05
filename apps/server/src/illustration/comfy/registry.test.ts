import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ComfyConfig } from '@cowrite/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  loadWorkflowRegistry,
  SAMPLE_WORKFLOW_FILENAME,
  sampleWorkflowPath,
  type WorkflowRegistry,
} from './registry.js'

/** A minimal valid api-format graph with %prompt%/%seed%/%output% markers. */
function validGraph(): Record<string, unknown> {
  return {
    '6': {
      class_type: 'CLIPTextEncode',
      _meta: { title: '%prompt%' },
      inputs: { text: 'placeholder' },
    },
    '3': {
      class_type: 'KSampler',
      _meta: { title: 'KSampler %seed%' },
      inputs: { seed: 0, steps: 20 },
    },
    '9': { class_type: 'SaveImage', _meta: { title: '%output%' }, inputs: { images: ['8', 0] } },
  }
}

let dir: string

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cowrite-wf-'))
})

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true })
})

async function writeWorkflow(file: string, graph: unknown): Promise<void> {
  await fsp.writeFile(path.join(dir, file), JSON.stringify(graph), 'utf8')
}

function config(overrides: Record<string, unknown> = {}): ComfyConfig {
  return ComfyConfig.parse({
    baseUrl: 'http://127.0.0.1:8188',
    workflows: { default: { file: 'default.json', label: 'Default (SDXL scene)' } },
    ...overrides,
  })
}

function load(cfg: ComfyConfig): Promise<WorkflowRegistry> {
  return loadWorkflowRegistry(cfg, { workflowsDir: dir })
}

describe('loadWorkflowRegistry — happy path', () => {
  it('resolves a valid workflow with injections, exec timeout, and a content hash', async () => {
    await writeWorkflow('default.json', validGraph())
    const reg = await load(config())

    expect(reg.report.workflows).toEqual([
      { name: 'default', label: 'Default (SDXL scene)', ok: true },
    ])
    expect(reg.report.route).toEqual({
      section: { name: 'default', ok: true },
      world: { name: 'default', ok: true },
    })

    const wf = reg.resolve('section')
    expect('configMissing' in wf).toBe(false)
    if (!('configMissing' in wf)) {
      expect(wf.injections).toEqual({ promptNodeId: '6', seedNodeIds: ['3'], outputNodeId: '9' })
      expect(wf.execTimeoutMs).toBe(300_000)
      expect(wf.contentHash).toMatch(/^xxh64:[0-9a-f]{16}$/)
      expect(Object.isFrozen(wf.json)).toBe(true)
    }
  })

  it('applies a per-workflow execTimeoutMs override', async () => {
    await writeWorkflow('hq.json', validGraph())
    const cfg = config({
      workflows: { default: { file: 'hq.json', label: 'HQ', execTimeoutMs: 600_000 } },
    })
    const reg = await load(cfg)
    const wf = reg.resolve('section')
    if ('configMissing' in wf) throw new Error('expected resolved')
    expect(wf.execTimeoutMs).toBe(600_000)
  })

  it('content hash is stable across key order', async () => {
    const g = validGraph()
    await writeWorkflow('default.json', g)
    const reg1 = await load(config())
    // Re-serialize with reversed key order.
    const reversed = Object.fromEntries(Object.entries(g).reverse())
    await writeWorkflow('default.json', reversed)
    const reg2 = await load(config())
    const a = reg1.resolve('section')
    const b = reg2.resolve('section')
    if ('configMissing' in a || 'configMissing' in b) throw new Error('expected resolved')
    expect(a.contentHash).toBe(b.contentHash)
  })

  it('the shipped sample workflow validates', async () => {
    const raw = await fsp.readFile(sampleWorkflowPath(), 'utf8')
    await fsp.writeFile(path.join(dir, SAMPLE_WORKFLOW_FILENAME), raw, 'utf8')
    const reg = await load(
      config({ workflows: { default: { file: SAMPLE_WORKFLOW_FILENAME, label: 'Sample' } } }),
    )
    expect(reg.report.workflows[0]?.ok).toBe(true)
    const wf = reg.resolve('section')
    if ('configMissing' in wf) throw new Error('sample must resolve')
    expect(wf.injections.promptNodeId).toBe('6')
    expect(wf.injections.seedNodeIds).toEqual(['3'])
    expect(wf.injections.outputNodeId).toBe('9')
    expect(wf.injections.widthNodeId).toBe('5')
  })
})

describe('loadWorkflowRegistry — validation & error records (never throws)', () => {
  it('records a missing file, not a throw', async () => {
    const reg = await load(config())
    expect(reg.report.workflows[0]).toMatchObject({ name: 'default', ok: false })
    expect(reg.report.workflows[0]?.error).toMatch(/not found/)
  })

  it('records invalid JSON', async () => {
    await fsp.writeFile(path.join(dir, 'default.json'), '{ not json', 'utf8')
    const reg = await load(config())
    expect(reg.report.workflows[0]?.ok).toBe(false)
    expect(reg.report.workflows[0]?.error).toMatch(/not valid JSON/)
  })

  it('records a marker validation failure (missing %seed%)', async () => {
    const g = validGraph()
    g['3'] = { class_type: 'KSampler', _meta: { title: 'KSampler' }, inputs: { seed: 0 } }
    await writeWorkflow('default.json', g)
    const reg = await load(config())
    expect(reg.report.workflows[0]?.ok).toBe(false)
    expect(reg.report.workflows[0]?.error).toMatch(/No %seed% marker/)
  })

  it('resolve() on a broken workflow returns configMissing carrying the error', async () => {
    const g = validGraph()
    delete g['9'] // no output node, no %output%
    g['8'] = { class_type: 'VAEDecode', _meta: { title: 'Decode' }, inputs: {} }
    await writeWorkflow('default.json', g)
    const reg = await load(config())
    const wf = reg.resolve('section')
    expect('configMissing' in wf).toBe(true)
    if ('configMissing' in wf) expect(wf.configMissing).toMatch(/invalid/)
  })
})

describe('loadWorkflowRegistry — routes', () => {
  it('records a dangling route name and resolve() reports it', async () => {
    await writeWorkflow('default.json', validGraph())
    const cfg = config({ route: { section: 'nope', world: 'default' } })
    const reg = await load(cfg)

    expect(reg.report.route.section).toEqual({ name: 'nope', ok: false })
    expect(reg.report.route.world).toEqual({ name: 'default', ok: true })

    const section = reg.resolve('section')
    expect('configMissing' in section).toBe(true)
    if ('configMissing' in section)
      expect(section.configMissing).toMatch(/not defined in comfyui.workflows/)

    const world = reg.resolve('world')
    expect('configMissing' in world).toBe(false)
  })

  it('empty workflows map: every route is config_missing but load still succeeds', async () => {
    const cfg = ComfyConfig.parse({ baseUrl: 'http://127.0.0.1:8188' })
    const reg = await load(cfg)
    expect(reg.report.workflows).toEqual([])
    expect(reg.resolve('section')).toHaveProperty('configMissing')
    expect(reg.resolve('world')).toHaveProperty('configMissing')
  })
})
