/**
 * `createMockComfy()` — the scriptable mock ComfyUI (docs/09-testing.md §2, docs/08 §2.1, §11).
 *
 * Implements the full documented subset: `POST /prompt` (returns `prompt_id`; 400 with node
 * errors for `rejectSubmit`), `GET /history/:id` (`{}` until the job's deterministic
 * `queueMs + execMs` deadline passes, then the terminal record — computed from `Date.now()`,
 * no timers needed for polling correctness), `GET /view` (a tiny valid PNG — optionally colored
 * per `fixture` — with the submitted workflow JSON, injected `%prompt%` text included, embedded
 * in a `tEXt` chunk keyed `prompt`, and the fixture name in a `tEXt` chunk keyed `fixture`),
 * `GET /system_stats`, `POST /interrupt` (emits `execution_interrupted` for the running job),
 * and `POST /queue {delete}` (drops a still-queued job). `WS /ws?clientId=` streams the standard
 * progress sequence (`status` on connect, `execution_start`, `progress` × N, `executed` +
 * a terminal `executing{node:null}`, or `execution_error`) — pushed via timers, independent of
 * whether any client is connected, so HTTP-only (polling) tests and WS tests both work.
 * Control routes (`/__mock/scenario`, `/__mock/reset`, `/__mock/state`) mirror the LLM mock.
 */
import { WebSocket, WebSocketServer } from 'ws'
import {
  handleControlRoutes,
  readJsonBody,
  sendJson,
  startMockServer,
  type TimerPool,
} from './base.js'
import { addTextChunk, buildPng, type PngOptions } from './png.js'
import { ScenarioQueue, type ScenarioState } from './scenario.js'

export interface ComfyMatch {
  /** The submitted workflow JSON (stringified) must include this substring. */
  promptIncludes?: string
}

/** Options shared by the two "renders an image" step kinds (`image`, `dropWs`). */
interface ComfyImageOpts {
  /** Simulated render time from `execution_start` to terminal, ms. */
  execMs?: number
  /** Simulated time the job sits queued before `execution_start` fires, ms. */
  queueMs?: number
  /** Number of `progress` WS messages emitted evenly across `execMs`. */
  progressTicks?: number
  /** Embed the submitted workflow JSON (injected `%prompt%` text included) in a `tEXt` chunk
   *  keyed `prompt`. Default true — the end-to-end injection probe. */
  embedPromptText?: boolean
  /** Names the served PNG: a `tEXt` chunk keyed `fixture` carries this value, and the fill
   *  color is derived deterministically from it, so a best-of test can assert which committed
   *  image won without touching the pipeline internals. */
  fixture?: string
}

export type ComfyStep =
  | ({ type: 'image'; match?: ComfyMatch } & ComfyImageOpts)
  | { type: 'rejectSubmit'; nodeErrors?: Record<string, unknown>; match?: ComfyMatch }
  | { type: 'executionError'; nodeId?: string; message?: string; match?: ComfyMatch }
  /** Submits and renders exactly like `image`, but the WS connection is forcibly dropped
   *  mid-run and no terminal WS event is ever sent for this job — the client must fall back
   *  to `/history` polling to observe completion. */
  | ({ type: 'dropWs' } & ComfyImageOpts & { match?: ComfyMatch })
  /** Submits fine (returns a `prompt_id`) and starts executing, but never reaches a terminal
   *  state on its own — exercises the client's exec timeout and the pipeline's budget gate.
   *  Only `/interrupt` or `POST /queue {delete}` ends it. */
  | { type: 'hang'; ms?: number; match?: ComfyMatch }
  /** Renders and completes via `/history` exactly like `image`, but the WS emits NO events for
   *  this job — no `execution_start`, no progress, no terminal (a cold/never-connected or
   *  instantly-dropped socket, before `execution_start`). The job still starts (so `/queue
   *  {delete}` is a no-op once running and only `/interrupt` ends it). Exercises the client's
   *  cold-WS exec-deadline arming and interrupt-vs-dequeue choice (§4). */
  | ({ type: 'coldWs' } & ComfyImageOpts & { match?: ComfyMatch })

export interface CapturedPromptRequest {
  /** The submitted api-format workflow graph. */
  prompt: unknown
  clientId: string | undefined
  body: Record<string, unknown>
}

export class ComfyScenario {
  readonly queue = new ScenarioQueue<ComfyStep>()

  /** Script a successful job. */
  image(opts?: ComfyImageOpts & { match?: ComfyMatch }): this {
    this.queue.push({ type: 'image', ...opts })
    return this
  }

  /** Script a 400 on submit with per-node validation errors. */
  rejectSubmit(nodeErrors?: Record<string, unknown>, match?: ComfyMatch): this {
    this.queue.push({ type: 'rejectSubmit', nodeErrors, match })
    return this
  }

  /** Script a job that submits fine but fails during execution (visible via `/history` + WS). */
  executionError(nodeId?: string, message?: string, match?: ComfyMatch): this {
    this.queue.push({ type: 'executionError', nodeId, message, match })
    return this
  }

  /** Script a job whose WS stays cold (no `execution_start`/progress/terminal ever): it renders
   *  and completes via `/history` only. The client must arm its exec deadline and choose
   *  `/interrupt` without ever seeing a WS confirmation (§4). */
  coldWs(opts?: ComfyImageOpts & { match?: ComfyMatch }): this {
    this.queue.push({ type: 'coldWs', ...opts })
    return this
  }

  /** Script a job whose WS connection is forcibly dropped mid-run: the client must fall back
   *  to `/history` polling to observe completion. */
  dropWs(opts?: ComfyImageOpts & { match?: ComfyMatch }): this {
    this.queue.push({ type: 'dropWs', ...opts })
    return this
  }

  /** Script a job that starts but never terminates on its own (no terminal WS event, `/history`
   *  never completes) — exercises timeouts and the budget gate. Ends via `/interrupt` or
   *  `/queue {delete}`. `ms` delays `execution_start` (default 0). */
  hang(ms?: number, match?: ComfyMatch): this {
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
  /** The `/ws` URL, minted with a stable mock `clientId` — pass your own `?clientId=` if you
   *  need a specific one. */
  wsUrl: string
  port: number
  scenario: ComfyScenario
  /** Every `POST /prompt` body received, in order. */
  requests: CapturedPromptRequest[]
  close: () => Promise<void>
}

/** A job created by `image` | `executionError` | `dropWs` | `hang` (never `rejectSubmit`,
 *  which never reaches this far). */
interface Job {
  promptId: string
  step: Extract<ComfyStep, { type: 'image' | 'executionError' | 'dropWs' | 'hang' | 'coldWs' }>
  workflow: unknown
  filename: string
  queueMs: number
  execMs: number
  progressTicks: number
  /** Epoch ms after which `/history` reports the job terminal (its natural outcome) —
   *  `Infinity` for `hang`, so it never completes on its own. */
  readyAt: number
  started: boolean
  interrupted: boolean
  deleted: boolean
}

const OUTPUT_NODE_ID = '9'

function matchStep(step: ComfyStep, workflowJson: string): string | null {
  const includes = step.match?.promptIncludes
  if (includes !== undefined && !workflowJson.includes(includes)) {
    return `submitted workflow does not include ${JSON.stringify(includes)}`
  }
  return null
}

/** Deterministic fixture → fill color, so distinct fixture names render visibly distinct PNGs
 *  without needing a real image asset registry. */
function fixtureColor(fixture: string | undefined): PngOptions | undefined {
  if (fixture === undefined) return undefined
  let hash = 0
  for (let i = 0; i < fixture.length; i++) {
    hash = (hash * 31 + fixture.charCodeAt(i)) >>> 0
  }
  return { rgb: [hash & 0xff, (hash >>> 8) & 0xff, (hash >>> 16) & 0xff] }
}

function wsSend(ws: WebSocket, type: string, data: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, data }))
  }
}

function broadcast(sockets: Set<WebSocket>, type: string, data: unknown): void {
  for (const ws of sockets) wsSend(ws, type, data)
}

/** Schedule the WS push sequence for a job. Pushes are timer-driven regardless of whether any
 *  socket is connected (an HTTP-only/polling test never opens `/ws` at all); each callback
 *  re-checks `interrupted`/`deleted` so a job ended early never emits a stale event after the
 *  fact. */
function scheduleJobEvents(job: Job, sockets: Set<WebSocket>, timers: TimerPool): void {
  const live = (): boolean => !job.interrupted && !job.deleted

  if (job.step.type === 'coldWs') {
    // Cold WS: the job genuinely starts (so /queue{delete} is a no-op once running and only
    // /interrupt ends it) but the socket emits NOTHING — no execution_start, no progress, no
    // terminal. Completion is observable via /history only. (§4)
    timers.schedule(() => {
      if (live()) job.started = true
    }, job.queueMs)
    return
  }

  timers.schedule(() => {
    if (!live()) return
    job.started = true
    broadcast(sockets, 'execution_start', { prompt_id: job.promptId })
  }, job.queueMs)

  if (job.step.type === 'hang') return // execution_start only, ever

  if (job.step.type === 'executionError') {
    const step = job.step
    timers.schedule(() => {
      if (!live()) return
      broadcast(sockets, 'execution_error', {
        prompt_id: job.promptId,
        node_id: step.nodeId ?? '3',
        node_type: 'MockNode',
        exception_message: step.message ?? 'mock execution error',
        exception_type: 'MockException',
        traceback: [],
      })
    }, job.queueMs + Math.min(job.execMs, 1))
    return
  }

  // image / dropWs: evenly spaced progress ticks, then a terminal event.
  for (let i = 1; i <= job.progressTicks; i++) {
    const at = job.queueMs + Math.round((job.execMs * i) / (job.progressTicks + 1))
    timers.schedule(() => {
      if (!live()) return
      broadcast(sockets, 'progress', {
        value: i,
        max: job.progressTicks,
        prompt_id: job.promptId,
        node: OUTPUT_NODE_ID,
      })
    }, at)
  }

  if (job.step.type === 'dropWs') {
    const dropAt = job.queueMs + Math.max(1, Math.round(job.execMs / 2))
    timers.schedule(() => {
      if (!live()) return
      // Simulate a network drop: terminate every connected socket without a close handshake.
      // No `executed`/`executing` ever follows — the client must poll `/history` to finish.
      for (const ws of sockets) ws.terminate()
    }, dropAt)
    return
  }

  timers.schedule(() => {
    if (!live()) return
    broadcast(sockets, 'executed', {
      prompt_id: job.promptId,
      node: OUTPUT_NODE_ID,
      output: { images: [{ filename: job.filename, subfolder: '', type: 'output' }] },
    })
    broadcast(sockets, 'executing', { prompt_id: job.promptId, node: null })
  }, job.queueMs + job.execMs)
}

export interface MockComfyOptions {
  /** Listen port; 0 (default) picks an ephemeral port. */
  port?: number
  /** When true, an unscripted `POST /prompt` arriving with an empty queue renders a plain
   *  always-succeed image instead of failing loudly (docs/09-testing.md §2.4) — the demo/e2e
   *  posture (`pnpm mock:comfy`, `standalone.ts`), never the default for hermetic tests, which
   *  keep the strict "unmatched request is a bug" behavior. */
  autoSucceed?: boolean
}

/** Boot the mock on an ephemeral port by default. Always `close()` it (afterEach/afterAll). */
export async function createMockComfy(options?: MockComfyOptions): Promise<MockComfy> {
  const scenario = new ComfyScenario()
  const requests: CapturedPromptRequest[] = []
  const jobs = new Map<string, Job>()
  const sockets = new Set<WebSocket>()
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
      const auto = options?.autoSucceed === true && scenario.queue.pending === 0
      const step: ComfyStep = auto
        ? { type: 'image' }
        : scenario.queue.take('POST /prompt', (s) => matchStep(s, workflowJson))

      if (step.type === 'rejectSubmit') {
        sendJson(res, 400, {
          error: {
            type: 'prompt_outputs_failed_validation',
            message: 'Prompt outputs failed validation',
          },
          node_errors: step.nodeErrors ?? {},
        })
        return
      }

      promptCounter += 1
      const promptId = `mock-prompt-${promptCounter}`
      let queueMs = 0
      let execMs = 0
      let progressTicks = 0
      if (step.type === 'hang') {
        queueMs = step.ms ?? 0
        execMs = Number.POSITIVE_INFINITY
      } else if (step.type === 'executionError') {
        queueMs = 0
        execMs = 0
      } else {
        queueMs = step.queueMs ?? 0
        execMs = step.execMs ?? 0
        progressTicks = step.progressTicks ?? 4
      }
      const job: Job = {
        promptId,
        step,
        workflow: body.prompt,
        filename: `mock-${promptCounter}.png`,
        queueMs,
        execMs,
        progressTicks,
        readyAt: Date.now() + queueMs + execMs,
        started: false,
        interrupted: false,
        deleted: false,
      }
      jobs.set(promptId, job)
      scheduleJobEvents(job, sockets, base.timers)
      sendJson(res, 200, { prompt_id: promptId, number: promptCounter, node_errors: {} })
      return
    }

    if (pathname.startsWith('/history/') && req.method === 'GET') {
      const promptId = pathname.slice('/history/'.length)
      const job = jobs.get(promptId)
      if (job === undefined || job.deleted) {
        sendJson(res, 200, {})
        return
      }
      if (job.interrupted) {
        sendJson(res, 200, {
          [promptId]: {
            status: {
              status_str: 'error',
              completed: false,
              messages: [['execution_interrupted', { prompt_id: promptId }]],
            },
            outputs: {},
          },
        })
        return
      }
      if (Date.now() < job.readyAt) {
        sendJson(res, 200, {}) // still queued/executing (or a `hang` job: readyAt is Infinity)
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
      let fixture: string | undefined
      let embed = false
      if (job.step.type === 'image' || job.step.type === 'dropWs') {
        fixture = job.step.fixture
        embed = job.step.embedPromptText ?? true
      }
      let png = buildPng(fixtureColor(fixture))
      if (embed) {
        // Same convention as real ComfyUI: the submitted graph JSON under tEXt key "prompt",
        // so tests assert prompt injection straight from the served bytes.
        png = addTextChunk(png, 'prompt', JSON.stringify(job.workflow ?? null))
      }
      if (fixture !== undefined) {
        png = addTextChunk(png, 'fixture', fixture)
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

    if (pathname === '/interrupt' && req.method === 'POST') {
      await readJsonBody(req).catch(() => undefined) // real API sends no body; drain either way
      // Real ComfyUI has exactly one execution slot; interrupt whatever job is still in
      // flight, most-recently-submitted first.
      const running = [...jobs.values()]
        .reverse()
        .find((j) => !j.interrupted && !j.deleted && Date.now() < j.readyAt)
      if (running !== undefined) {
        running.interrupted = true
        broadcast(sockets, 'execution_interrupted', { prompt_id: running.promptId })
      }
      sendJson(res, 200, {})
      return
    }

    if (pathname === '/queue' && req.method === 'POST') {
      const body = (await readJsonBody(req)) as { delete?: unknown } | undefined
      const ids = Array.isArray(body?.delete)
        ? body.delete.filter((id): id is string => typeof id === 'string')
        : []
      for (const id of ids) {
        const job = jobs.get(id)
        // Only a still-queued job can be dequeued; an executing one needs `/interrupt`.
        if (job !== undefined && !job.started && !job.interrupted) {
          job.deleted = true
        }
      }
      sendJson(res, 200, {})
      return
    }

    sendJson(res, 404, {
      error: { type: 'not_found', message: `no route for ${req.method} ${pathname}` },
    })
  }, options?.port ?? 0)

  const wss = new WebSocketServer({ noServer: true })
  base.server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url ?? '/', 'http://mock')
    if (pathname !== '/ws') {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws)
      ws.on('close', () => sockets.delete(ws))
      wsSend(ws, 'status', { status: { exec_info: { queue_remaining: jobs.size } } })
    })
  })

  return {
    url: base.url,
    wsUrl: `${base.url.replace(/^http/, 'ws')}/ws?clientId=mock-client`,
    port: base.port,
    scenario,
    requests,
    close: async () => {
      for (const ws of sockets) ws.terminate()
      wss.close()
      await base.close()
    },
  }
}
