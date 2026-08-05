import { afterEach, describe, expect, it } from 'vitest'
import { createMockComfy, type MockComfy } from './comfy.js'
import { PNG_SIGNATURE, readTextChunks } from './png.js'
import { postJson } from './testUtil.js'

let comfy: MockComfy

afterEach(async () => {
  await comfy.close()
})

/** A minimal api-format workflow with an injected `%prompt%` text, as the pipeline submits. */
function workflow(promptText: string): Record<string, unknown> {
  return {
    '3': { class_type: 'KSampler', inputs: { seed: 42, steps: 20 } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: promptText } },
    '9': { class_type: 'SaveImage', inputs: { images: ['8', 0] } },
  }
}

interface HistoryRecord {
  status: {
    status_str: string
    completed: boolean
    messages: Array<[string, Record<string, unknown>]>
  }
  outputs: Record<string, { images: Array<{ filename: string; subfolder: string; type: string }> }>
}

async function submit(promptText: string, extra?: Record<string, unknown>): Promise<string> {
  const res = await postJson(`${comfy.url}/prompt`, {
    prompt: workflow(promptText),
    client_id: 'test-client',
    ...extra,
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { prompt_id: string; node_errors: Record<string, unknown> }
  expect(body.node_errors).toEqual({})
  return body.prompt_id
}

async function history(promptId: string): Promise<Record<string, HistoryRecord>> {
  return (await (await fetch(`${comfy.url}/history/${promptId}`)).json()) as Record<
    string,
    HistoryRecord
  >
}

async function fetchView(filename: string): Promise<Buffer> {
  const res = await fetch(`${comfy.url}/view?filename=${filename}&subfolder=&type=output`)
  expect(res.status).toBe(200)
  return Buffer.from(await res.arrayBuffer())
}

// ---------------------------------------------------------------------------
// A real WS consumer (Node's built-in client WebSocket) — no extra client dep.
// ---------------------------------------------------------------------------

interface WsMsg {
  type: string
  data: Record<string, unknown>
}

function wsConnect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.addEventListener('open', () => resolve(ws), { once: true })
    ws.addEventListener('error', () => reject(new Error(`ws connect failed: ${url}`)), {
      once: true,
    })
  })
}

/** Collect exactly `count` JSON messages off `ws`, in order. */
function collectWsMessages(ws: WebSocket, count: number, timeoutMs = 2000): Promise<WsMsg[]> {
  return new Promise((resolve, reject) => {
    const out: WsMsg[] = []
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`timed out waiting for ${count} ws message(s); got ${JSON.stringify(out)}`))
    }, timeoutMs)
    const onMessage = (ev: MessageEvent): void => {
      out.push(JSON.parse(String(ev.data)) as WsMsg)
      if (out.length >= count) {
        cleanup()
        resolve(out)
      }
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      ws.removeEventListener('message', onMessage)
    }
    ws.addEventListener('message', onMessage)
  })
}

describe('happy path', () => {
  it('submit → history → view returns a PNG with the injected prompt in a tEXt chunk', async () => {
    comfy = await createMockComfy()
    comfy.scenario.image()
    const injected = 'a lighthouse keeper holding a cracked storm glass, oil painting'
    const promptId = await submit(injected)
    expect(promptId).toBe('mock-prompt-1')

    const h = await history(promptId)
    const record = h[promptId]
    expect(record?.status.completed).toBe(true)
    const image = record?.outputs['9']?.images[0]
    expect(image).toBeDefined()

    const png = await fetchView(image?.filename ?? '')
    expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true)

    // The end-to-end injection probe: the submitted workflow JSON — injected prompt text
    // included — is readable from the committed bytes alone.
    const chunks = readTextChunks(png)
    expect(chunks.prompt).toBeDefined()
    expect(chunks.prompt).toContain(injected)
    expect(JSON.parse(chunks.prompt ?? '')).toEqual(workflow(injected))

    // The request was captured for white-box assertions too.
    expect(comfy.requests).toHaveLength(1)
    expect(comfy.requests[0]?.clientId).toBe('test-client')
    comfy.scenario.assertDrained()
  })

  it('execMs delays history completion for polling tests (no timers involved)', async () => {
    comfy = await createMockComfy()
    comfy.scenario.image({ execMs: 80 })
    const promptId = await submit('slow render')
    expect(await history(promptId)).toEqual({}) // still executing
    await new Promise((resolve) => setTimeout(resolve, 100))
    const h = await history(promptId)
    expect(h[promptId]?.status.completed).toBe(true)
    comfy.scenario.assertDrained()
  })

  it('embedPromptText: false serves a clean PNG', async () => {
    comfy = await createMockComfy()
    comfy.scenario.image({ embedPromptText: false })
    const promptId = await submit('no embedding please')
    const image = (await history(promptId))[promptId]?.outputs['9']?.images[0]
    const png = await fetchView(image?.filename ?? '')
    expect(readTextChunks(png)).toEqual({})
    comfy.scenario.assertDrained()
  })

  it('fixture: names the served PNG via a tEXt chunk, so a best-of test can tell winners apart', async () => {
    comfy = await createMockComfy()
    comfy.scenario.image({ fixture: 'attempt-1-mediocre' })
    comfy.scenario.image({ fixture: 'attempt-2-best' })
    comfy.scenario.image({ fixture: 'attempt-3-regressed' })

    const ids = [await submit('a'), await submit('b'), await submit('c')]
    const filenames = await Promise.all(
      ids.map(async (id) => (await history(id))[id]?.outputs['9']?.images[0]?.filename ?? ''),
    )
    const fixtures = await Promise.all(
      filenames.map(async (f) => readTextChunks(await fetchView(f)).fixture),
    )
    expect(fixtures).toEqual(['attempt-1-mediocre', 'attempt-2-best', 'attempt-3-regressed'])
    // Distinct fixtures render visibly distinct bytes, not just distinct tEXt.
    const bodies = await Promise.all(filenames.map((f) => fetchView(f)))
    expect(bodies[0]?.equals(bodies[1] ?? Buffer.alloc(0))).toBe(false)
    comfy.scenario.assertDrained()
  })
})

describe('failure injection', () => {
  it('rejectSubmit returns 400 with node_errors', async () => {
    comfy = await createMockComfy()
    comfy.scenario.rejectSubmit({ '6': { errors: [{ message: 'bad text input' }] } })
    const res = await postJson(`${comfy.url}/prompt`, { prompt: workflow('x') })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { node_errors: Record<string, unknown> }
    expect(body.node_errors['6']).toBeDefined()
    comfy.scenario.assertDrained()
  })

  it('executionError submits fine but history reports the error', async () => {
    comfy = await createMockComfy()
    comfy.scenario.executionError('3', 'CUDA out of memory (mock)')
    const promptId = await submit('doomed job')
    const record = (await history(promptId))[promptId]
    expect(record?.status.status_str).toBe('error')
    expect(record?.status.completed).toBe(false)
    const [kind, detail] = record?.status.messages[0] ?? []
    expect(kind).toBe('execution_error')
    expect(detail?.node_id).toBe('3')
    expect(detail?.exception_message).toBe('CUDA out of memory (mock)')
    expect(record?.outputs).toEqual({})
    comfy.scenario.assertDrained()
  })

  it('executionError also streams execution_start + execution_error over WS', async () => {
    comfy = await createMockComfy()
    comfy.scenario.executionError('3', 'CUDA out of memory (mock)')
    const ws = await wsConnect(comfy.wsUrl)
    const pending = collectWsMessages(ws, 3) // status, execution_start, execution_error
    await submit('doomed job')
    const [status, start, error] = await pending
    expect(status?.type).toBe('status')
    expect(start?.type).toBe('execution_start')
    expect(error?.type).toBe('execution_error')
    expect(error?.data.node_id).toBe('3')
    expect(error?.data.exception_message).toBe('CUDA out of memory (mock)')
    ws.close()
    comfy.scenario.assertDrained()
  })

  it('an unscripted submit fails loudly', async () => {
    comfy = await createMockComfy()
    const res = await postJson(`${comfy.url}/prompt`, { prompt: workflow('x') })
    expect(res.status).toBe(500)
    expect(() => comfy.scenario.assertDrained()).toThrow(/unscripted request/)
    comfy.scenario.reset()
  })

  it('match.promptIncludes rejects a workflow missing the substring', async () => {
    comfy = await createMockComfy()
    comfy.scenario.image({ match: { promptIncludes: 'lighthouse' } })
    const res = await postJson(`${comfy.url}/prompt`, { prompt: workflow('a plain meadow') })
    expect(res.status).toBe(500)
    expect(() => comfy.scenario.assertDrained()).toThrow(/does not include "lighthouse"/)
    comfy.scenario.reset()
  })
})

describe('WS progress stream', () => {
  it('streams status, execution_start, progress × N, executed, executing(null) in order', async () => {
    comfy = await createMockComfy()
    comfy.scenario.image({ queueMs: 5, execMs: 30, progressTicks: 2 })
    const ws = await wsConnect(comfy.wsUrl)
    const pending = collectWsMessages(ws, 6)
    const promptId = await submit('a scene with progress')
    const [status, start, p1, p2, executed, done] = await pending

    expect(status?.type).toBe('status')
    expect(start?.type).toBe('execution_start')
    expect(start?.data.prompt_id).toBe(promptId)
    expect(p1?.type).toBe('progress')
    expect(p1?.data).toMatchObject({ value: 1, max: 2 })
    expect(p2?.type).toBe('progress')
    expect(p2?.data).toMatchObject({ value: 2, max: 2 })
    expect(executed?.type).toBe('executed')
    const images = (executed?.data.output as { images: Array<{ filename: string }> }).images
    expect(images[0]?.filename).toBeDefined()
    expect(done?.type).toBe('executing')
    expect(done?.data.node).toBeNull()

    ws.close()
    comfy.scenario.assertDrained()
  })

  it('a WS-only consumer needs no /history polling to learn the outcome', async () => {
    comfy = await createMockComfy()
    comfy.scenario.image({ execMs: 10, progressTicks: 0 })
    const ws = await wsConnect(comfy.wsUrl)
    const pending = collectWsMessages(ws, 3) // status, execution_start, executed
    await submit('quick one')
    const [, , executed] = await pending
    expect(executed?.type).toBe('executed')
    ws.close()
    comfy.scenario.assertDrained()
  })
})

describe('dropWs: forces the /history polling fallback', () => {
  it('drops the socket mid-run; no terminal WS event ever arrives, but /history completes', async () => {
    comfy = await createMockComfy()
    comfy.scenario.dropWs({ execMs: 60, progressTicks: 1, fixture: 'polled-winner' })
    const ws = await wsConnect(comfy.wsUrl)

    const closed = new Promise<void>((resolve) => {
      ws.addEventListener('close', () => resolve(), { once: true })
    })
    const promptId = await submit('needs polling')
    await closed // the mock terminated the connection mid-run

    // No further WS messages will ever come for this job — /history is the only path left.
    expect(await history(promptId)).toEqual({})
    let record: HistoryRecord | undefined
    for (let i = 0; i < 20 && record?.status.completed !== true; i++) {
      await new Promise((resolve) => setTimeout(resolve, 15))
      record = (await history(promptId))[promptId]
    }
    expect(record?.status.completed).toBe(true)
    const filename = record?.outputs['9']?.images[0]?.filename ?? ''
    const png = await fetchView(filename)
    expect(readTextChunks(png).fixture).toBe('polled-winner')
    comfy.scenario.assertDrained()
  })
})

describe('hang, /interrupt, and /queue delete', () => {
  it('hang submits fine, starts executing, but /history never completes on its own', async () => {
    comfy = await createMockComfy()
    comfy.scenario.hang(5)
    const promptId = await submit('stuck forever')
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(await history(promptId)).toEqual({}) // still "running" well past any real render time
    // Ends the scenario cleanly via interrupt (see next test) rather than leaving it dangling.
    await postJson(`${comfy.url}/interrupt`, {})
    comfy.scenario.assertDrained()
  })

  it('/interrupt emits execution_interrupted for the running job and history reflects it', async () => {
    comfy = await createMockComfy()
    comfy.scenario.hang(0)
    const ws = await wsConnect(comfy.wsUrl)
    const pending = collectWsMessages(ws, 2) // status, execution_start
    const promptId = await submit('budget will run out')
    await pending // wait for execution_start so the job is unambiguously "running"

    const interrupted = collectWsMessages(ws, 1)
    const res = await postJson(`${comfy.url}/interrupt`, {})
    expect(res.status).toBe(200)
    const [msg] = await interrupted
    expect(msg?.type).toBe('execution_interrupted')
    expect(msg?.data.prompt_id).toBe(promptId)

    const record = (await history(promptId))[promptId]
    expect(record?.status.status_str).toBe('error')
    expect(record?.status.completed).toBe(false)
    expect(record?.status.messages[0]?.[0]).toBe('execution_interrupted')

    ws.close()
    comfy.scenario.assertDrained()
  })

  it('/interrupt on a budget-gate scenario: attempt 1 image, attempt 2 hangs and is interrupted', async () => {
    comfy = await createMockComfy()
    comfy.scenario.image({ fixture: 'attempt-1-committed' })
    comfy.scenario.hang(0)
    const first = await submit('attempt one')
    const firstRecord = (await history(first))[first]
    expect(firstRecord?.status.completed).toBe(true)

    const second = await submit('attempt two, doomed to hang')
    await new Promise((resolve) => setTimeout(resolve, 10))
    const interruptRes = await postJson(`${comfy.url}/interrupt`, {})
    expect(interruptRes.status).toBe(200)
    const secondRecord = (await history(second))[second]
    expect(secondRecord?.status.status_str).toBe('error')

    // The pipeline would now commit attempt 1 — its image is still fetchable.
    const filename = firstRecord?.outputs['9']?.images[0]?.filename ?? ''
    expect(readTextChunks(await fetchView(filename)).fixture).toBe('attempt-1-committed')
    comfy.scenario.assertDrained()
  })

  it('POST /queue {delete} drops a still-queued job before it ever starts', async () => {
    comfy = await createMockComfy()
    comfy.scenario.image({ queueMs: 200 })
    const promptId = await submit('will be dequeued')
    const del = await postJson(`${comfy.url}/queue`, { delete: [promptId] })
    expect(del.status).toBe(200)
    // Even long after the job would have completed, it never does — it was dequeued.
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(await history(promptId)).toEqual({})
    comfy.scenario.assertDrained()
  })

  it('/queue {delete} does not touch a job that already started executing', async () => {
    comfy = await createMockComfy()
    comfy.scenario.image({ queueMs: 0, execMs: 30 })
    const promptId = await submit('already running')
    await new Promise((resolve) => setTimeout(resolve, 10)) // let execution_start fire
    await postJson(`${comfy.url}/queue`, { delete: [promptId] })
    await new Promise((resolve) => setTimeout(resolve, 30))
    const record = (await history(promptId))[promptId]
    expect(record?.status.completed).toBe(true) // ran to completion, undisturbed
    comfy.scenario.assertDrained()
  })
})

describe('misc surface', () => {
  it('GET /system_stats answers the health probe', async () => {
    comfy = await createMockComfy()
    const res = await fetch(`${comfy.url}/system_stats`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { system: { comfyui_version: string }; devices: unknown[] }
    expect(body.system.comfyui_version).toContain('mock')
    expect(body.devices.length).toBeGreaterThan(0)
  })

  it('GET /history for an unknown id returns {}', async () => {
    comfy = await createMockComfy()
    expect(await history('nope')).toEqual({})
  })

  it('GET /view for an unknown filename returns 404', async () => {
    comfy = await createMockComfy()
    const res = await fetch(`${comfy.url}/view?filename=missing.png`)
    expect(res.status).toBe(404)
  })

  it('/interrupt with nothing running is a harmless no-op', async () => {
    comfy = await createMockComfy()
    const res = await postJson(`${comfy.url}/interrupt`, {})
    expect(res.status).toBe(200)
  })

  it('control routes: enqueue over HTTP, state, reset (clears jobs and captures)', async () => {
    comfy = await createMockComfy()
    await postJson(`${comfy.url}/__mock/scenario`, { steps: [{ type: 'image' }] })
    const promptId = await submit('scripted remotely')
    expect((await history(promptId))[promptId]?.status.completed).toBe(true)

    const state = (await (await fetch(`${comfy.url}/__mock/state`)).json()) as {
      pending: number
      consumed: number
    }
    expect(state).toEqual({ pending: 0, consumed: 1, errors: [] })

    await postJson(`${comfy.url}/__mock/reset`, {})
    expect(await history(promptId)).toEqual({}) // jobs cleared
    expect(comfy.requests).toHaveLength(0)
    comfy.scenario.assertDrained()
  })
})

describe('autoSucceed: the standalone/demo posture', () => {
  it('renders a plain success image for unscripted submits instead of failing', async () => {
    comfy = await createMockComfy({ autoSucceed: true })
    const promptId = await submit('nothing scripted, demo mode')
    const record = (await history(promptId))[promptId]
    expect(record?.status.completed).toBe(true)
    comfy.scenario.assertDrained() // the queue was never touched, so it's trivially drained
  })

  it('still prefers an explicitly scripted step over the auto default', async () => {
    comfy = await createMockComfy({ autoSucceed: true })
    comfy.scenario.executionError('3', 'scripted takes precedence')
    const promptId = await submit('scripted')
    const record = (await history(promptId))[promptId]
    expect(record?.status.status_str).toBe('error')
    comfy.scenario.assertDrained()
  })
})
