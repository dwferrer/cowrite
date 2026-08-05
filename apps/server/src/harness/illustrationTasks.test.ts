import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { type ComfyConfig, ComfyConfig as ComfyConfigSchema } from '@cowrite/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ComfyClient } from '../illustration/ctx.js'
import { buildIllustrationRuntime, retryablePipelineDetail } from './illustrationTasks.js'

describe('retryablePipelineDetail', () => {
  it('marks transient failures retryable and config/target/format faults not', () => {
    for (const d of [
      'comfy_unreachable',
      'comfy_timeout',
      'comfy_exec_error',
      'budget_exhausted',
      'compose_failed',
      'critique_failed',
    ]) {
      expect(retryablePipelineDetail(d)).toBe(true)
    }
    for (const d of [
      'workflow_invalid',
      'commit_target_missing',
      'commit_failed',
      'transcode_failed',
    ]) {
      expect(retryablePipelineDetail(d)).toBe(false)
    }
  })
})

/**
 * First-run workflow auto-registration (docs/08 §3, §18): copying the sample default.json to
 * disk must ALSO register a `workflows.default` entry, or a config that set only `baseUrl`
 * leaves the default routes dangling (`config_missing` forever).
 */

let dir: string
beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cowrite-illust-rt-'))
})
afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true })
})

const stubClient: ComfyClient = {
  health: () => Promise.resolve({ ok: true }),
  generate: () => Promise.reject(new Error('unused')),
}

describe('buildIllustrationRuntime — default workflow auto-registration (§18)', () => {
  it('a bare baseUrl config (empty workflows) resolves the default routes after the sample copy', async () => {
    const comfy: ComfyConfig = ComfyConfigSchema.parse({
      baseUrl: 'http://127.0.0.1:65500',
      workflowsDir: path.join(dir, 'workflows'),
    })
    expect(comfy.workflows).toEqual({}) // the config itself named no workflows

    const runtime = await buildIllustrationRuntime(comfy, {
      configDir: dir,
      buildComfyClient: () => stubClient,
    })

    // The default routes now resolve to a valid workflow, not config_missing.
    expect(runtime.registry.report.route.section.ok).toBe(true)
    expect(runtime.registry.report.route.world.ok).toBe(true)
    const resolved = runtime.registry.resolve('section')
    expect('configMissing' in resolved).toBe(false)
    // The workflow report lists the auto-registered default as valid.
    expect(runtime.registry.report.workflows).toContainEqual(
      expect.objectContaining({ name: 'default', ok: true }),
    )
    // The original config object was not mutated.
    expect(comfy.workflows).toEqual({})
    runtime.close()
  })
})
