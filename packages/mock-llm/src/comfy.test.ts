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

async function submit(promptText: string): Promise<string> {
  const res = await postJson(`${comfy.url}/prompt`, {
    prompt: workflow(promptText),
    client_id: 'test-client',
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

    const viewRes = await fetch(
      `${comfy.url}/view?filename=${image?.filename}&subfolder=&type=output`,
    )
    expect(viewRes.status).toBe(200)
    expect(viewRes.headers.get('content-type')).toBe('image/png')
    const png = Buffer.from(await viewRes.arrayBuffer())
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
    const png = Buffer.from(
      await (await fetch(`${comfy.url}/view?filename=${image?.filename}`)).arrayBuffer(),
    )
    expect(readTextChunks(png)).toEqual({})
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

  it('hang destroys the submit connection after ms', async () => {
    comfy = await createMockComfy()
    comfy.scenario.hang(30)
    await expect(postJson(`${comfy.url}/prompt`, { prompt: workflow('x') })).rejects.toThrow()
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
