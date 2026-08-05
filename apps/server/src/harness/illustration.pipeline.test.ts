import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createMockComfy, createMockLlm, type MockComfy } from '@cowrite/mock-llm'
import { AppConfig, type ComfyConfig, type Task } from '@cowrite/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../app.js'
import { resourceRoutes } from '../http/routes/index.js'
import { WorkRegistry } from '../http/workRegistry.js'
import type { ZodApp } from '../http/zod.js'
import { createStorage, type StorageService } from '../storage/service.js'
import { AgentHarness } from './service.js'
import {
  attachCapture,
  createWork,
  eventsOf,
  type HarnessTestCtx,
  openWork,
  seedFrozenSection,
  until,
  waitForTerminal,
} from './testUtil.js'

/**
 * Stage-5 illustration pipeline integration (docs/08 §11 golden scenarios): the real Fastify
 * app over temp-dir storage, the low lane pointed at an in-process mock LLM (scripted
 * composer + VLM critique), and a real ComfyUI client talking to the in-process mock ComfyUI.
 * Asserts the `task.progress` phase sequence on the work stream, the run-file `RunEvent`s, the
 * `IllustrationSlot` written to disk, the `run_artifacts` index row, and the served PNG.
 */

type IllustrationCtx = HarnessTestCtx & { comfy: MockComfy; workflowsDir: string }

function imagePromptText(paragraph: string): string {
  return `Here is the prompt:\n<image-prompt>\n${paragraph}\n</image-prompt>`
}

function critiqueText(c: {
  verdict: 'accept' | 'revise'
  overall: number
  advice?: string
}): string {
  const body = {
    verdict: c.verdict,
    scores: { subject: 4, consistency: 4, craft: 4, mood: 4 },
    overall: c.overall,
    problems: [],
    promptAdvice: c.advice ?? '',
  }
  return `\`\`\`json\n${JSON.stringify(body)}\n\`\`\``
}

async function makeCtx(
  options: { route?: { section?: string; world?: string } } = {},
): Promise<IllustrationCtx> {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cowrite-illust-'))
  const workflowsDir = path.join(dataDir, 'workflows')
  const storage = createStorage(dataDir)
  const works = new WorkRegistry(storage)
  const llm = await createMockLlm()
  const comfy = await createMockComfy()

  const comfyui: ComfyConfig = {
    baseUrl: comfy.url,
    workflowsDir,
    workflows: { default: { file: 'default.json', label: 'Default' } },
    route: {
      section: options.route?.section ?? 'default',
      world: options.route?.world ?? 'default',
    },
    loop: { maxAttempts: 3, acceptScore: 7 },
    timeouts: {
      healthTimeoutMs: 3_000,
      connectTimeoutMs: 5_000,
      queueTimeoutMs: 120_000,
      execTimeoutMs: 300_000,
      wsFallbackMs: 10_000,
    },
  }
  const config = AppConfig.parse({
    models: {
      high: { baseUrl: `${llm.url}/v1`, model: 'mock-high' },
      low: { baseUrl: `${llm.url}/v1`, model: 'mock-low' },
    },
    comfyui,
  })
  const harness = new AgentHarness({
    config: () => config,
    laneDeps: { sleepImpl: async () => {} },
    illustration: { configDir: dataDir }, // workflowsDir is explicit; sample is seeded here
  })
  harness.reloadIllustration()
  works.onClose((open) => harness.closeWork(open))
  const app = buildApp({
    config: { current: () => config },
    works,
    version: '0.0.1-test',
    webDist: null,
    plugins: [resourceRoutes({ works, storage, harness })],
  }) as ZodApp
  return {
    dataDir,
    storage: storage as StorageService,
    works,
    harness,
    llm,
    app,
    comfy,
    workflowsDir,
  }
}

async function destroy(ctx: IllustrationCtx): Promise<void> {
  await ctx.works.closeAll()
  await ctx.app.close()
  await ctx.llm.close()
  await ctx.comfy.close()
  await fsp.rm(ctx.dataDir, { recursive: true, force: true })
}

async function submitTask(
  ctx: IllustrationCtx,
  workId: string,
  payload: Record<string, unknown>,
): Promise<Task> {
  const res = await ctx.app.inject({ method: 'POST', url: `/api/works/${workId}/tasks`, payload })
  expect(res.statusCode, res.body).toBe(202)
  return res.json() as Task
}

/** Read the on-disk illustration slot from a section's section.json. */
async function readSectionSlot(
  ctx: IllustrationCtx,
  workId: string,
  sectionId: string,
): Promise<unknown> {
  const open = await openWork(ctx, workId)
  const row = open.handle.getSection(sectionId)
  if (row === null) throw new Error('no section row')
  const raw = await fsp.readFile(
    path.join(open.handle.workDir, row.dirPath, 'section.json'),
    'utf8',
  )
  return (JSON.parse(raw) as { enrichments: { illustration: unknown } }).enrichments.illustration
}

let ctx: IllustrationCtx

beforeEach(async () => {
  ctx = await makeCtx()
})

afterEach(async () => {
  await destroy(ctx)
})

describe('illustrate-accept-first (§4.1 early accept)', () => {
  it('composes, generates once, critiques accept, and commits the winner end to end', async () => {
    const work = await createWork(ctx, 'Illustrated')
    const sectionId = await seedFrozenSection(ctx, work.id, {
      content: 'The lighthouse keeper watched the storm break over the black water.\n',
      longSummary: 'A keeper faces a storm at his lighthouse.',
    })
    const open = await openWork(ctx, work.id)
    const capture = attachCapture(open.bus)

    ctx.llm.scenario
      .respond(
        imagePromptText(
          'A weathered keeper on a storm-lashed lighthouse gallery, wide shot, cold blue light.',
        ),
      )
      .respond(critiqueText({ verdict: 'accept', overall: 8 }))
    ctx.comfy.scenario.image()

    const task = await submitTask(ctx, work.id, { kind: 'illustrate-section', sectionId })
    const terminal = await waitForTerminal(ctx, work.id, task.id)
    expect(terminal.status).toBe('done')

    // task.progress phase sequence (§8): composing → submitting/generating → critiquing → committing.
    const phases = eventsOf(capture, 'task.progress').map((e) => e.phase)
    expect(phases[0]).toBe('composing')
    expect(phases).toContain('generating')
    expect(phases).toContain('critiquing')
    expect(phases.at(-1)).toBe('committing')

    // A committed artifact + enrichment.updated for the illustration slot.
    const artifacts = eventsOf(capture, 'task.artifact').map((e) => e.artifact)
    expect(artifacts).toContainEqual({ kind: 'illustration', sectionId, state: 'committed' })
    expect(
      eventsOf(capture, 'enrichment.updated').some(
        (e) => e.sectionId === sectionId && e.kind === 'illustration',
      ),
    ).toBe(true)

    // The run file transcript: meta → compose message/output → vlm.critique toolCall → result.
    const runRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/works/${work.id}/runs/${task.id}`,
    })
    expect(runRes.statusCode).toBe(200)
    const events = runRes.json() as Array<Record<string, unknown>>
    expect(events[0]?.type).toBe('meta')
    expect(events.some((e) => e.type === 'toolCall' && e.name === 'vlm.critique')).toBe(true)
    const result = events.at(-1) as { type: string; status: string; artifacts: unknown[] }
    expect(result.type).toBe('result')
    expect(result.status).toBe('ok')
    expect(result.artifacts).toContainEqual({ kind: 'illustration', sectionId, state: 'committed' })

    // The IllustrationSlot on disk: an agent meta with the winning prompt + workflow + seed.
    const slot = (await readSectionSlot(ctx, work.id, sectionId)) as {
      source: string
      runId: string
      prompt: string
      workflow: string
      seed: number
      attempts: number
      score: number
    }
    expect(slot.source).toBe('agent')
    expect(slot.runId).toBe(task.id)
    expect(slot.workflow).toBe('default')
    expect(slot.attempts).toBe(1)
    expect(slot.score).toBe(8)
    expect(typeof slot.seed).toBe('number')

    // The run_artifacts index row links image → run (03 §3.9 provenance).
    const linked = await ctx.app.inject({
      method: 'GET',
      url: `/api/works/${work.id}/runs?artifact=illustration:${sectionId}`,
    })
    expect(linked.statusCode).toBe(200)
    expect((linked.json() as Array<{ runId: string }>).some((r) => r.runId === task.id)).toBe(true)

    // The committed PNG streams.
    const png = await ctx.app.inject({
      method: 'GET',
      url: `/api/works/${work.id}/sections/${sectionId}/illustration`,
    })
    expect(png.statusCode).toBe(200)
    expect(png.headers['content-type']).toBe('image/png')

    ctx.comfy.scenario.assertDrained()
  })
})

describe('revise-then-accept (§4.1 revise loop)', () => {
  it('a revise verdict rewrites the prompt, re-generates, and commits the second attempt', async () => {
    const work = await createWork(ctx, 'Revised')
    const sectionId = await seedFrozenSection(ctx, work.id, {
      longSummary: 'A ship at anchor in fog.',
    })
    const open = await openWork(ctx, work.id)
    const capture = attachCapture(open.bus)

    ctx.llm.scenario
      .respond(imagePromptText('A ship at anchor, fog on the water, wide shot.'))
      .respond(
        critiqueText({ verdict: 'revise', overall: 5, advice: 'add the anchored ship clearly' }),
      )
      .respond(
        imagePromptText('A three-masted ship at anchor, thick fog, lantern glow, wide shot.'),
      )
      .respond(critiqueText({ verdict: 'accept', overall: 8 }))
    ctx.comfy.scenario.image().image()

    const task = await submitTask(ctx, work.id, { kind: 'illustrate-section', sectionId })
    const terminal = await waitForTerminal(ctx, work.id, task.id)
    expect(terminal.status).toBe('done')

    expect(eventsOf(capture, 'task.progress').map((e) => e.phase)).toContain('revising')
    const slot = (await readSectionSlot(ctx, work.id, sectionId)) as {
      attempts: number
      score: number
    }
    expect(slot.attempts).toBe(2)
    expect(slot.score).toBe(8)
    ctx.comfy.scenario.assertDrained()
  })
})

describe('cancel-mid-generate (§4.4 discard semantics)', () => {
  it('cancelling a hung generation interrupts ComfyUI and writes no file', async () => {
    const work = await createWork(ctx, 'Cancelled')
    const sectionId = await seedFrozenSection(ctx, work.id, { longSummary: 'A dark corridor.' })
    const open = await openWork(ctx, work.id)
    const capture = attachCapture(open.bus)

    ctx.llm.scenario.respond(
      imagePromptText('A dark corridor, single flickering bulb, tight framing.'),
    )
    ctx.comfy.scenario.hang() // generation starts but never completes on its own

    const task = await submitTask(ctx, work.id, { kind: 'illustrate-section', sectionId })
    // Wait until generation is under way, then cancel.
    const t0 = Date.now()
    while (
      !eventsOf(capture, 'task.progress').some(
        (e) => e.phase === 'generating' || e.phase === 'submitting',
      )
    ) {
      if (Date.now() - t0 > 8000) throw new Error('generation never started')
      await new Promise((r) => setTimeout(r, 10))
    }
    const cancel = await ctx.app.inject({
      method: 'POST',
      url: `/api/works/${work.id}/tasks/${task.id}/cancel`,
    })
    expect(cancel.statusCode).toBe(202)

    const terminal = await waitForTerminal(ctx, work.id, task.id)
    expect(terminal.status).toBe('cancelled')
    // Discard semantics: no illustration committed.
    const png = await ctx.app.inject({
      method: 'GET',
      url: `/api/works/${work.id}/sections/${sectionId}/illustration`,
    })
    expect(png.statusCode).toBe(404)
  })
})

describe('world-image-happy (§4)', () => {
  it('generates and commits a world-entry image with a null-content-hash sidecar meta', async () => {
    const work = await createWork(ctx, 'World')
    const entryRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/works/${work.id}/world`,
      payload: {
        name: 'Mara Voss',
        body: 'A weathered woman in her forties with cropped grey hair.',
      },
    })
    expect(entryRes.statusCode).toBe(201)
    const entryId = (entryRes.json() as { id: string }).id

    ctx.llm.scenario
      .respond(
        imagePromptText(
          'A weathered woman in her forties with cropped grey hair, close portrait, warm light.',
        ),
      )
      .respond(critiqueText({ verdict: 'accept', overall: 9 }))
    ctx.comfy.scenario.image()

    const task = await submitTask(ctx, work.id, { kind: 'world-image', entryId })
    const terminal = await waitForTerminal(ctx, work.id, task.id)
    expect(terminal.status).toBe('done')

    const image = await ctx.app.inject({
      method: 'GET',
      url: `/api/works/${work.id}/world/${entryId}/image`,
    })
    expect(image.statusCode).toBe(200)

    const open = await openWork(ctx, work.id)
    const sidecarRaw = await fsp.readFile(
      path.join(open.handle.workDir, 'world', 'images', `${entryId}.json`),
      'utf8',
    )
    const meta = JSON.parse(sidecarRaw) as { source: string; sourceHash: null; entities: string[] }
    expect(meta.source).toBe('agent')
    expect(meta.sourceHash).toBeNull() // world images carry no section content (§6)
    expect(meta.entities).toContain(entryId)
  })
})

describe('config_missing (§3 registry errors are task-time)', () => {
  it('a dangling route name fails submit with 409 config_missing, never a boot failure', async () => {
    const bad = await makeCtx({ route: { section: 'nonesuch' } })
    try {
      const work = await createWork(bad, 'Broken Route')
      const sectionId = await seedFrozenSection(bad, work.id, { longSummary: 'x' })
      const res = await bad.app.inject({
        method: 'POST',
        url: `/api/works/${work.id}/tasks`,
        payload: { kind: 'illustrate-section', sectionId },
      })
      expect(res.statusCode).toBe(409)
      expect((res.json() as { error: { code: string } }).error.code).toBe('config_missing')
    } finally {
      await destroy(bad)
    }
  })
})

describe('delete-writes-tombstone + illustrate-clears-tombstone (§5 slot transitions)', () => {
  it('deleting writes a tombstone the sweep respects; a user illustrate lifts it and commits', async () => {
    const work = await createWork(ctx, 'Tombstone')
    const sectionId = await seedFrozenSection(ctx, work.id, {
      longSummary: 'A quiet room at dusk.',
    })

    // Upload a user image, then delete it → tombstone.
    const png = minimalPng()
    const up = await ctx.app.inject({
      method: 'POST',
      url: `/api/works/${work.id}/sections/${sectionId}/illustration`,
      headers: { 'content-type': 'image/png' },
      payload: png,
    })
    expect(up.statusCode).toBe(200)
    const del = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/works/${work.id}/sections/${sectionId}/illustration`,
    })
    expect(del.statusCode).toBe(204)
    const tombstone = (await readSectionSlot(ctx, work.id, sectionId)) as { suppressed?: boolean }
    expect(tombstone.suppressed).toBe(true)

    // A user "Illustrate" on the suppressed section clears the tombstone and commits an agent image.
    ctx.llm.scenario
      .respond(imagePromptText('A quiet room at dusk, soft amber light through a tall window.'))
      .respond(critiqueText({ verdict: 'accept', overall: 8 }))
    ctx.comfy.scenario.image()

    const task = await submitTask(ctx, work.id, { kind: 'illustrate-section', sectionId })
    const terminal = await waitForTerminal(ctx, work.id, task.id)
    expect(terminal.status).toBe('done')
    const slot = (await readSectionSlot(ctx, work.id, sectionId)) as {
      source?: string
      suppressed?: boolean
    }
    expect(slot.suppressed).toBeUndefined()
    expect(slot.source).toBe('agent')
  })
})

describe('SSE reconnect resumes the illustration caption (§19)', () => {
  it('replays a live illustration task.state + latest task.progress on a fresh attach', async () => {
    const work = await createWork(ctx, 'Reconnect')
    const sectionId = await seedFrozenSection(ctx, work.id, { longSummary: 'A storm at sea.' })
    // Compose succeeds, then generate hangs — the task stays mid-run with progress recorded.
    ctx.llm.scenario.respond(imagePromptText('A storm breaking over black water.'))
    ctx.comfy.scenario.hang(0)
    const task = await submitTask(ctx, work.id, { kind: 'illustrate-section', sectionId })

    const open = await openWork(ctx, work.id)
    const cap1 = attachCapture(open.bus)
    // Wait until the pipeline has emitted a progress frame (so the harness recorded the latest).
    await until(
      () => eventsOf(cap1, 'task.progress').some((e) => e.taskId === task.id),
      'live progress',
    )

    // A fresh EventSource (a refreshed tab) must replay the illustration state + latest progress.
    const cap2 = attachCapture(open.bus)
    const state = await until(
      () => eventsOf(cap2, 'task.state').find((e) => e.lane === 'illustration'),
      'replayed illustration state',
    )
    expect(state.task.id).toBe(task.id)
    expect(state.target).toEqual({ kind: 'section', id: sectionId })
    const progress = eventsOf(cap2, 'task.progress').find((e) => e.taskId === task.id)
    expect(progress).toBeDefined()

    cap1.detach()
    cap2.detach()
    await ctx.app.inject({
      method: 'POST',
      url: `/api/works/${work.id}/tasks/${task.id}/cancel`,
    })
  })
})

describe('scheduler never resurrects deleted art (§13)', () => {
  it('a scheduler-initiated illustrate does NOT lift a tombstone; a user illustrate does', async () => {
    const work = await createWork(ctx, 'NoResurrect')
    const sectionId = await seedFrozenSection(ctx, work.id, { longSummary: 'A quiet room.' })

    // Upload + delete a user image → tombstone.
    const png = minimalPng()
    await ctx.app.inject({
      method: 'POST',
      url: `/api/works/${work.id}/sections/${sectionId}/illustration`,
      headers: { 'content-type': 'image/png' },
      payload: png,
    })
    await ctx.app.inject({
      method: 'DELETE',
      url: `/api/works/${work.id}/sections/${sectionId}/illustration`,
    })
    expect(
      ((await readSectionSlot(ctx, work.id, sectionId)) as { suppressed?: boolean }).suppressed,
    ).toBe(true)

    const open = await openWork(ctx, work.id)
    const clearSpy = vi.spyOn(open.handle, 'clearSuppression')

    // A scheduler-initiated run whose generate fails: with the bug it would have lifted the
    // tombstone at enqueue time, leaving a null slot the sweep re-illustrates (resurrection).
    ctx.llm.scenario.respond(imagePromptText('A quiet room at dusk.'))
    for (let i = 0; i < 6; i++) ctx.comfy.scenario.executionError('3', 'CUDA OOM')
    const submit = (
      ctx.harness as unknown as {
        submitIllustration: (
          o: typeof open,
          s: { kind: 'illustrate-section'; sectionId: string },
          initiator: 'user' | 'scheduler',
        ) => Promise<{ outcome: Promise<{ status: string }> }>
      }
    ).submitIllustration.bind(ctx.harness)

    const sched = await submit(open, { kind: 'illustrate-section', sectionId }, 'scheduler')
    await sched.outcome
    expect(clearSpy).not.toHaveBeenCalled()
    // The tombstone survives — the failed scheduler run neither committed nor lifted suppression.
    expect(
      ((await readSectionSlot(ctx, work.id, sectionId)) as { suppressed?: boolean }).suppressed,
    ).toBe(true)

    // A user "Illustrate" DOES lift it.
    const user = await submit(open, { kind: 'illustrate-section', sectionId }, 'user')
    // cancel it immediately — we only care that suppression was cleared at enqueue.
    expect(clearSpy).toHaveBeenCalledWith(sectionId)
    void user.outcome.catch(() => {})
  })
})

describe('GET /api/illustration/health (§8 report shape)', () => {
  it('reports comfy reachable, the workflow valid, and both routes resolved', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/illustration/health' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      ok: boolean
      comfy: { ok: boolean }
      workflows: Array<{ name: string; ok: boolean }>
      route: { section: { name: string; ok: boolean }; world: { name: string; ok: boolean } }
    }
    expect(body.comfy.ok).toBe(true)
    expect(body.workflows).toContainEqual(expect.objectContaining({ name: 'default', ok: true }))
    expect(body.route.section).toEqual({ name: 'default', ok: true })
    expect(body.route.world).toEqual({ name: 'default', ok: true })
    expect(body.ok).toBe(true)
  })
})

/** A tiny but valid PNG (1×1) for the user-upload path. */
function minimalPng(): Buffer {
  return Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4' +
      '890000000d49444154789c626001000000050001a5f645400000000049454e44ae426082',
    'hex',
  )
}
