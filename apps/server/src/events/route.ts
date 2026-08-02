import type { FastifyInstance } from 'fastify'
import type { WorkRegistry } from '../http/workRegistry.js'
import type { EventSink } from './bus.js'

/**
 * `GET /api/works/:w/events` — the one SSE stream per open work (docs/03-api.md §3.13,
 * §8). Opening the stream is the work-open observable (§4.1): the route lazily opens the
 * work, attaches the connection to the bus (hello → replay/resync/snapshots → live), and
 * wires the subscriber count into the registry so the reconcile timer and idle-close
 * clock track SSE presence. `Last-Event-ID` drives §8.3 resume negotiation.
 */

export function registerEventsRoute(app: FastifyInstance, works: WorkRegistry): void {
  app.get('/api/works/:w/events', async (req, reply) => {
    const { w } = req.params as { w: string }
    // Resolve/open BEFORE hijacking so an unknown work still gets the JSON 404 envelope.
    const open = await works.open(w)
    // §8.3 resume cursor: the native `Last-Event-ID` header, with `?lastEventId=` as the
    // fallback for manual reconnects (a fresh EventSource cannot set the header).
    const lastEventIdHeader = req.headers['last-event-id']
    const lastEventIdQuery = (req.query as { lastEventId?: string } | undefined)?.lastEventId
    const lastEventId =
      typeof lastEventIdHeader === 'string'
        ? lastEventIdHeader
        : typeof lastEventIdQuery === 'string'
          ? lastEventIdQuery
          : undefined

    reply.hijack()
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-content-type-options': 'nosniff',
    })
    if (typeof reply.raw.flushHeaders === 'function') reply.raw.flushHeaders()

    const sink: EventSink = {
      write: (chunk) => {
        reply.raw.write(chunk)
      },
      end: () => {
        reply.raw.end()
      },
    }
    const detach = open.bus.attach(sink, lastEventId)
    works.retain(open.slug)

    let cleaned = false
    const cleanup = (): void => {
      if (cleaned) return
      cleaned = true
      detach()
      works.release(open.slug)
    }
    req.raw.on('close', cleanup)
    reply.raw.on('close', cleanup)
  })
}
