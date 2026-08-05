/**
 * Shared plumbing for both mock servers: ephemeral-port `node:http` bootstrap with socket
 * tracking (so `close()` is instant and leak-free), a timer pool (so no timer outlives the
 * server — deterministic teardown), body reading, and the `/__mock/*` control routes.
 */
import http from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { ScenarioError, type ScenarioQueue } from './scenario.js'

/** Timers that are all cleared (and their sleepers resolved) when the server closes. */
export class TimerPool {
  private pending = new Map<NodeJS.Timeout, () => void>()

  schedule(fn: () => void, ms: number): void {
    const timeout = setTimeout(() => {
      this.pending.delete(timeout)
      fn()
    }, ms)
    this.pending.set(timeout, fn)
  }

  /** A cancellable sleep: resolves after `ms`, or immediately when the pool is cleared. */
  sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve()
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pending.delete(timeout)
        resolve()
      }, ms)
      this.pending.set(timeout, resolve)
    })
  }

  clearAll(): void {
    for (const [timeout, resolve] of this.pending) {
      clearTimeout(timeout)
      resolve()
    }
    this.pending.clear()
  }
}

export interface MockHttpServer {
  url: string
  port: number
  timers: TimerPool
  /** The raw server, exposed so a caller (the ComfyUI mock) can attach a WS `upgrade` handler. */
  server: http.Server
  close: () => Promise<void>
}

export type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>

/**
 * Start an http server on 127.0.0.1 with tracked sockets and timers.
 * `port` defaults to 0 (ephemeral) — what in-process tests always want.
 */
export async function startMockServer(handler: Handler, port = 0): Promise<MockHttpServer> {
  const timers = new TimerPool()
  const sockets = new Set<Socket>()
  const server = http.createServer((req, res) => {
    handler(req, res).catch((err: unknown) => {
      if (res.writableEnded) return
      const message = err instanceof Error ? err.message : String(err)
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' })
      }
      res.end(JSON.stringify({ error: { type: 'mock_scenario_error', message } }))
    })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  const { port: boundPort } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${boundPort}`,
    port: boundPort,
    timers,
    server,
    close: async () => {
      timers.clearAll()
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      })
    },
  }
}

export async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.trim() === '') return undefined
  try {
    return JSON.parse(raw)
  } catch {
    throw new ScenarioError(`request body is not valid JSON: ${raw.slice(0, 200)}`)
  }
}

export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/**
 * Handle the cross-process control routes shared by both mocks:
 * `POST /__mock/scenario` (append raw steps), `POST /__mock/reset`, `GET /__mock/state`.
 * Returns true when the request was a control request (and has been answered).
 */
export async function handleControlRoutes<Step>(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  queue: ScenarioQueue<Step>,
  onReset: () => void,
): Promise<boolean> {
  if (pathname === '/__mock/scenario' && req.method === 'POST') {
    const body = await readJsonBody(req)
    const steps = Array.isArray(body)
      ? body
      : body !== null &&
          typeof body === 'object' &&
          Array.isArray((body as { steps?: unknown }).steps)
        ? (body as { steps: unknown[] }).steps
        : null
    if (steps === null) {
      sendJson(res, 400, {
        error: {
          type: 'bad_request',
          message: 'expected a JSON array of steps or { steps: [...] }',
        },
      })
      return true
    }
    queue.push(...(steps as Step[]))
    sendJson(res, 200, { ok: true, pending: queue.pending })
    return true
  }
  if (pathname === '/__mock/reset' && req.method === 'POST') {
    onReset()
    sendJson(res, 200, { ok: true })
    return true
  }
  if (pathname === '/__mock/state' && req.method === 'GET') {
    sendJson(res, 200, queue.state())
    return true
  }
  return false
}
