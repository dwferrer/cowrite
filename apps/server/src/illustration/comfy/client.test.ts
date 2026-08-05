import { createMockComfy, type MockComfy, readTextChunks } from '@cowrite/mock-llm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { readPngDimensions } from '../../storage/lib/png.js'
import {
  ComfyAborted,
  type ComfyClientOptions,
  ComfyExecError,
  ComfyHttpClient,
  type ComfyProgress,
  ComfyTimeoutError,
  WorkflowInvalidError,
} from './client.js'
import { deriveInjectionMap, inject } from './inject.js'

/**
 * `ComfyHttpClient` tests against `@cowrite/mock-llm`'s mock ComfyUI (docs/08 §2.3, §11): one
 * server for the file, scenario + captured requests reset per test, every client closed after
 * so no socket outlives its test. Timeouts and the WS-idle poll cadence are shrunk to ms scale
 * so the polling/deadline paths run fast while staying faithful to the algorithm.
 */

let comfy: MockComfy
const openClients: ComfyHttpClient[] = []

beforeAll(async () => {
  comfy = await createMockComfy()
})

afterAll(async () => {
  await comfy.close()
})

beforeEach(() => {
  comfy.scenario.reset()
  comfy.requests.length = 0
})

afterEach(() => {
  for (const c of openClients.splice(0)) c.close()
  comfy.scenario.assertDrained()
})

const FAST_TIMEOUTS = {
  healthTimeoutMs: 500,
  connectTimeoutMs: 2_000,
  queueTimeoutMs: 5_000,
  execTimeoutMs: 5_000,
  wsFallbackMs: 60,
}

/** A client at `baseUrl` (default the mock) with a fetch spy recording request pathnames. */
function makeClient(overrides?: Partial<ComfyClientOptions>): {
  client: ComfyHttpClient
  calls: string[]
} {
  const calls: string[] = []
  const fetchImpl: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : String(input)
    calls.push(new URL(url).pathname)
    return fetch(input, init)
  }
  const client = new ComfyHttpClient({
    baseUrl: comfy.url,
    timeouts: FAST_TIMEOUTS,
    pollIntervalMs: 20,
    fetchImpl,
    logger: { warn: () => undefined },
    ...overrides,
  })
  openClients.push(client)
  return { client, calls }
}

/** A minimal valid SDXL-shaped graph with `%prompt%`/`%seed%`/`%output%` markers. */
function validGraph(): Record<string, unknown> {
  return {
    '6': {
      class_type: 'CLIPTextEncode',
      _meta: { title: '%prompt%' },
      inputs: { text: 'placeholder', clip: ['4', 1] },
    },
    '3': {
      class_type: 'KSampler',
      _meta: { title: 'KSampler %seed%' },
      inputs: { seed: 0, steps: 28, positive: ['6', 0], latent_image: ['5', 0] },
    },
    '5': {
      class_type: 'EmptyLatentImage',
      _meta: { title: '%width% %height%' },
      inputs: { width: 1216, height: 832 },
    },
    '9': {
      class_type: 'SaveImage',
      _meta: { title: '%output%' },
      inputs: { images: ['8', 0], filename_prefix: 'cowrite' },
    },
  }
}

/** Inject a known prompt so tests can assert it round-trips through the tEXt chunk. */
function injectedWorkflow(prompt: string): {
  workflow: Record<string, unknown>
  outputNodeId: string
} {
  const json = validGraph()
  const derived = deriveInjectionMap(json)
  if (!derived.ok) throw new Error('fixture graph must be valid')
  const workflow = inject({ json, injections: derived.injections }, { prompt, seed: 12_345 })
  return { workflow, outputNodeId: derived.injections.outputNodeId }
}

function generateArgs(
  prompt: string,
  extra?: Partial<{
    deadlineMs: number
    execTimeoutMs: number
    signal: AbortSignal
    onProgress: (p: ComfyProgress) => void
  }>,
) {
  const { workflow, outputNodeId } = injectedWorkflow(prompt)
  return {
    workflow,
    outputNodeId,
    deadlineMs: 10_000,
    signal: new AbortController().signal,
    onProgress: () => undefined,
    ...extra,
  }
}

describe('ComfyHttpClient.generate — happy path', () => {
  it('completes with progress and round-trips the injected prompt via the tEXt chunk', async () => {
    comfy.scenario.image({ queueMs: 60, execMs: 150, progressTicks: 4 })
    const { client } = makeClient()
    const progress: ComfyProgress[] = []

    const res = await client.generate(
      generateArgs('a lighthouse at dusk', { onProgress: (p) => progress.push(p) }),
    )

    expect(readPngDimensions(res.png)).not.toBeNull()
    expect(res.promptId).toMatch(/^mock-prompt-/)
    expect(res.durationMs).toBeGreaterThanOrEqual(0)
    // The mock embeds the submitted graph JSON (with the injected text) under tEXt key "prompt".
    expect(readTextChunks(res.png).prompt).toContain('a lighthouse at dusk')
    // Progress arrived over the WS: a `generating` phase and at least one numeric sampler pct.
    expect(progress.some((p) => p.phase === 'generating')).toBe(true)
    expect(progress.some((p) => p.pct !== null)).toBe(true)
  })

  it('submits with the process client_id and the injected workflow', async () => {
    comfy.scenario.image({ queueMs: 20, execMs: 40 })
    const { client } = makeClient()
    await client.generate(generateArgs('a red door'))

    expect(comfy.requests).toHaveLength(1)
    const req = comfy.requests[0]
    expect(typeof req?.clientId).toBe('string')
    expect(JSON.stringify(req?.prompt)).toContain('a red door')
  })
})

describe('ComfyHttpClient.generate — polling fallback', () => {
  it('completes via /history polling when the WS drops mid-run', async () => {
    comfy.scenario.dropWs({ queueMs: 40, execMs: 260, progressTicks: 4 })
    const { client, calls } = makeClient()

    const res = await client.generate(generateArgs('a storm at sea'))

    expect(readPngDimensions(res.png)).not.toBeNull()
    // The terminal state was observed by polling, not the (dropped) socket.
    expect(calls.some((p) => p.startsWith('/history/'))).toBe(true)
  })
})

describe('ComfyHttpClient.generate — failures', () => {
  it('maps an execution_error to a typed ComfyExecError with node + message', async () => {
    comfy.scenario.executionError('3', 'CUDA out of memory')
    const { client } = makeClient()

    const err = await client.generate(generateArgs('x')).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ComfyExecError)
    expect((err as ComfyExecError).message).toContain('CUDA out of memory')
    expect((err as ComfyExecError).nodeId).toBe('3')
  })

  it('rejects a 400 submit as WorkflowInvalidError carrying node_errors (no retry)', async () => {
    comfy.scenario.rejectSubmit({ '3': { class_type: 'KSampler', errors: ['bad seed'] } })
    const { client } = makeClient()

    const err = await client.generate(generateArgs('x')).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(WorkflowInvalidError)
    expect((err as WorkflowInvalidError).nodeErrors).toHaveProperty('3')
    // A 400 is terminal — exactly one submit attempt, never the retry pair.
    expect(comfy.requests).toHaveLength(1)
  })

  it('interrupts and throws ComfyTimeoutError when the hard deadline passes on a hung job', async () => {
    comfy.scenario.hang(40)
    const { client, calls } = makeClient()

    const err = await client
      .generate(generateArgs('x', { deadlineMs: 200 }))
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ComfyTimeoutError)
    expect(calls).toContain('/interrupt')
  })
})

describe('ComfyHttpClient.generate — per-workflow exec timeout (§3)', () => {
  it('uses the per-call execTimeoutMs for the internal exec deadline, not the global one', async () => {
    // Global exec timeout is generous (5 s); the per-call value is tiny, so a hung job that has
    // started executing is killed by the PER-CALL exec deadline, fast.
    comfy.scenario.hang(0)
    const { client, calls } = makeClient()
    const started = Date.now()
    const err = await client
      .generate(generateArgs('x', { deadlineMs: 5_000, execTimeoutMs: 80 }))
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ComfyTimeoutError)
    expect((err as ComfyTimeoutError).kind).toBe('exec')
    expect(calls).toContain('/interrupt')
    // It fired on the 80 ms per-call deadline, nowhere near the 5 s hard deadline / global exec.
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})

describe('ComfyHttpClient.generate — cold WS (§4)', () => {
  it('completes via /history polling when the WS never emits execution_start', async () => {
    comfy.scenario.coldWs({ queueMs: 20, execMs: 80 })
    const { client, calls } = makeClient()

    const res = await client.generate(generateArgs('a cold socket'))
    expect(readPngDimensions(res.png)).not.toBeNull()
    // No WS terminal was ever sent — completion came from /history.
    expect(calls.some((p) => p.startsWith('/history/'))).toBe(true)
  })

  it('interrupts (not just dequeues) a running job whose WS never confirmed execution', async () => {
    // A long cold-WS render: the socket never confirms execution_start, so the client must
    // ASSUME the job may be executing and, on the hard deadline, /interrupt it — a bare
    // /queue{delete} would no-op and starve the single slot.
    comfy.scenario.coldWs({ queueMs: 5, execMs: 5_000 })
    const { client, calls } = makeClient()
    const err = await client
      .generate(generateArgs('x', { deadlineMs: 200 }))
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ComfyTimeoutError)
    expect(calls).toContain('/interrupt')
  })

  it('observes a caller abort promptly on the cold-WS poll path and interrupts', async () => {
    comfy.scenario.coldWs({ queueMs: 5, execMs: 5_000 })
    const controller = new AbortController()
    const { client, calls } = makeClient()
    setTimeout(() => controller.abort(), 120)

    const err = await client
      .generate(generateArgs('x', { signal: controller.signal }))
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ComfyAborted)
    expect(calls).toContain('/interrupt')
  })
})

describe('ComfyHttpClient.generate — abort', () => {
  it('interrupts ComfyUI and throws ComfyAborted on signal abort', async () => {
    comfy.scenario.image({ queueMs: 40, execMs: 5_000 })
    const controller = new AbortController()
    const { client, calls } = makeClient()
    setTimeout(() => controller.abort(), 120)

    const err = await client
      .generate(generateArgs('x', { signal: controller.signal }))
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ComfyAborted)
    expect(calls).toContain('/interrupt')
  })
})

describe('ComfyHttpClient.health', () => {
  it('reports ok against a live mock and caches the result', async () => {
    const { client, calls } = makeClient()
    const first = await client.health()
    const second = await client.health()

    expect(first).toEqual({ ok: true })
    expect(second).toEqual({ ok: true })
    // 60 s cache: only the first call hits /system_stats.
    expect(calls.filter((p) => p === '/system_stats')).toHaveLength(1)
  })

  it('reports not-ok with a detail when ComfyUI is unreachable', async () => {
    // Port 1 refuses instantly; health must degrade, not throw.
    const { client } = makeClient({ baseUrl: 'http://127.0.0.1:1' })
    const res = await client.health()

    expect(res.ok).toBe(false)
    expect(res.detail).toBeTruthy()
  })
})
