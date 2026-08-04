/**
 * `createMockComfy()` — the scriptable mock ComfyUI (docs/09-testing.md §2, docs/08 §2.1).
 *
 * Implements the polled subset our client reaches for first: `POST /prompt` (returns
 * `prompt_id`; 400 with node errors for `rejectSubmit`), `GET /history/:id` (`{}` until the
 * job's deterministic `execMs` deadline passes, then the terminal record), `GET /view`
 * (a tiny valid PNG with the submitted workflow JSON — injected `%prompt%` text included —
 * embedded in a `tEXt` chunk keyed `prompt`), and `GET /system_stats`. The `/ws` progress
 * endpoint is deliberately absent: polling is the first-class fallback path.
 * Control routes (`/__mock/scenario`, `/__mock/reset`, `/__mock/state`) mirror the LLM mock.
 */
import { handleControlRoutes, readJsonBody, sendJson, startMockServer } from './base.js'
import { addTextChunk, buildPng } from './png.js'
import { ScenarioQueue, type ScenarioState } from './scenario.js'

export interface ComfyMatch {
  /** The submitted workflow JSON (stringified) must include this substring. */
  promptIncludes?: string
}

export type ComfyStep =
  | { type: 'image'; execMs?: number; embedPromptText?: boolean; match?: ComfyMatch }
  | { type: 'rejectSubmit'; nodeErrors?: Record<string, unknown>; match?: ComfyMatch }
  | { type: 'executionError'; nodeId?: string; message?: string; match?: ComfyMatch }
  | { type: 'hang'; ms: number; match?: ComfyMatch }

export interface CapturedPromptRequest {
  /** The submitted api-format workflow graph. */
  prompt: unknown
  clientId: string | undefined
  body: Record<string, unknown>
}

export class ComfyScenario {
  readonly queue = new ScenarioQueue<ComfyStep>()

  /** Script a successful job. `execMs` delays history completion for polling tests. */
  image(opts?: { execMs?: number; embedPromptText?: boolean; match?: ComfyMatch }): this {
    this.queue.push({
      type: 'image',
      execMs: opts?.execMs,
      embedPromptText: opts?.embedPromptText,
      match: opts?.match,
    })
    return this
  }

  /** Script a 400 on submit with per-node validation errors. */
  rejectSubmit(nodeErrors?: Record<string, unknown>, match?: ComfyMatch): this {
    this.queue.push({ type: 'rejectSubmit', nodeErrors, match })
    return this
  }

  /** Script a job that submits fine but fails during execution (visible via /history). */
  executionError(nodeId?: string, message?: string, match?: ComfyMatch): this {
    this.queue.push({ type: 'executionError', nodeId, message, match })
    return this
  }

  /** Hold the submit connection open for `ms`, then destroy it. */
  hang(ms: number, match?: ComfyMatch): this {
    this.queue.push({ type: 'hang', ms, match })
    return this
  }

  /** Append raw JSON steps (the control-route shape). */
  enqueue(steps: ComfyStep[]): this {
    this.queue.push(...steps)
    return this
  }

  reset(): void {
    this.queue.reset()
  }

  assertDrained(): void {
    this.queue.assertDrained()
  }

  get pending(): number {
    return this.queue.pending
  }

  state(): ScenarioState {
    return this.queue.state()
  }
}

export interface MockComfy {
  url: string
  port: number
  scenario: ComfyScenario
  /** Every `POST /prompt` body received, in order. */
  requests: CapturedPromptRequest[]
  close: () => Promise<void>
}

interface Job {
  step: Extract<ComfyStep, { type: 'image' | 'executionError' }>
  workflow: unknown
  /** Epoch ms after which /history reports the job terminal — no timers needed. */
  readyAt: number
  filename: string
}

const OUTPUT_NODE_ID = '9'

function matchStep(step: ComfyStep, workflowJson: string): string | null {
  const includes = step.match?.promptIncludes
  if (includes !== undefined && !workflowJson.includes(includes)) {
    return `submitted workflow does not include ${JSON.stringify(includes)}`
  }
  return null
}

export interface MockComfyOptions {
  /** Listen port; 0 (default) picks an ephemeral port. */
  port?: number
}

/** Boot the mock on an ephemeral port by default. Always `close()` it (afterEach/afterAll). */
export async function createMockComfy(options?: MockComfyOptions): Promise<MockComfy> {
  const scenario = new ComfyScenario()
  const requests: CapturedPromptRequest[] = []
  const jobs = new Map<string, Job>()
  let promptCounter = 0

  const reset = (): void => {
    scenario.reset()
    requests.length = 0
    jobs.clear()
  }

  const base = await startMockServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://mock')
    const pathname = url.pathname

    if (await handleControlRoutes(req, res, pathname, scenario.queue, reset)) return

    if (pathname === '/prompt' && req.method === 'POST') {
      const body = (await readJsonBody(req)) as Record<string, unknown>
      const captured: CapturedPromptRequest = {
        prompt: body.prompt,
        clientId: typeof body.client_id === 'string' ? body.client_id : undefined,
        body,
      }
      requests.push(captured)
      const workflowJson = JSON.stringify(body.prompt ?? null)
      const step = scenario.queue.take('POST /prompt', (s) => matchStep(s, workflowJson))

      switch (step.type) {
        case 'rejectSubmit': {
          sendJson(res, 400, {
            error: {
              type: 'prompt_outputs_failed_validation',
              message: 'Prompt outputs failed validation',
            },
            node_errors: step.nodeErrors ?? {},
          })
          return
        }
        case 'hang': {
          base.timers.schedule(() => res.socket?.destroy(), step.ms)
          return
        }
        case 'image':
        case 'executionError': {
          promptCounter += 1
          const promptId = `mock-prompt-${promptCounter}`
          jobs.set(promptId, {
            step,
            workflow: body.prompt,
            readyAt: Date.now() + (step.type === 'image' ? (step.execMs ?? 0) : 0),
            filename: `mock-${promptCounter}.png`,
          })
          sendJson(res, 200, { prompt_id: promptId, number: promptCounter, node_errors: {} })
          return
        }
      }
    }

    if (pathname.startsWith('/history/') && req.method === 'GET') {
      const promptId = pathname.slice('/history/'.length)
      const job = jobs.get(promptId)
      if (job === undefined || Date.now() < job.readyAt) {
        sendJson(res, 200, {})
        return
      }
      if (job.step.type === 'executionError') {
        sendJson(res, 200, {
          [promptId]: {
            status: {
              status_str: 'error',
              completed: false,
              messages: [
                [
                  'execution_error',
                  {
                    node_id: job.step.nodeId ?? '3',
                    node_type: 'MockNode',
                    exception_message: job.step.message ?? 'mock execution error',
                  },
                ],
              ],
            },
            outputs: {},
          },
        })
        return
      }
      sendJson(res, 200, {
        [promptId]: {
          status: { status_str: 'success', completed: true, messages: [] },
          outputs: {
            [OUTPUT_NODE_ID]: {
              images: [{ filename: job.filename, subfolder: '', type: 'output' }],
            },
          },
        },
      })
      return
    }

    if (pathname === '/view' && req.method === 'GET') {
      const filename = url.searchParams.get('filename')
      const job = [...jobs.values()].find((j) => j.filename === filename)
      if (job === undefined) {
        sendJson(res, 404, {
          error: { type: 'not_found', message: `unknown file ${String(filename)}` },
        })
        return
      }
      let png = buildPng()
      const embed = job.step.type === 'image' ? (job.step.embedPromptText ?? true) : false
      if (embed) {
        // Same convention as real ComfyUI: the submitted graph JSON under tEXt key "prompt",
        // so tests assert prompt injection straight from the served bytes.
        png = addTextChunk(png, 'prompt', JSON.stringify(job.workflow ?? null))
      }
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length })
      res.end(png)
      return
    }

    if (pathname === '/system_stats' && req.method === 'GET') {
      sendJson(res, 200, {
        system: { os: 'mock', comfyui_version: 'mock-0.1.0', python_version: 'mock' },
        devices: [{ name: 'mock-gpu', type: 'cpu', vram_total: 0, vram_free: 0 }],
      })
      return
    }

    sendJson(res, 404, {
      error: { type: 'not_found', message: `no route for ${req.method} ${pathname}` },
    })
  }, options?.port ?? 0)

  return {
    url: base.url,
    port: base.port,
    scenario,
    requests,
    close: base.close,
  }
}
