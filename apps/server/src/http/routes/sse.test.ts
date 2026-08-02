import path from 'node:path'
import { SnippetDto, WorkEvent } from '@cowrite/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildFixtureWork, FIX } from '../../storage/index/fixture.js'
import { destroyTestCtx, makeTestCtx, type TestCtx } from './testUtil.js'

/**
 * SSE-follows-REST (docs/03-api.md §8.2, §12): mutate through a resource route and
 * assert the canonical WorkEvent arrives on the work's stream with a payload hydrated
 * enough to patch the client cache without a refetch.
 */

interface Frame {
  event?: string
  id?: string
  data?: unknown
}

interface Collector {
  frames: Frame[]
  waitFor(type: string, timeoutMs?: number): Promise<Frame>
  destroy(): void
}

function collectFrames(stream: NodeJS.ReadableStream & { destroy?: () => void }): Collector {
  let buf = ''
  const frames: Frame[] = []
  const waiters: Array<{ type: string; resolve: (f: Frame) => void }> = []
  stream.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8')
    let idx = buf.indexOf('\n\n')
    while (idx !== -1) {
      const raw = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      idx = buf.indexOf('\n\n')
      if (raw.startsWith(':')) continue // heartbeat / close comments
      const frame: Frame = {}
      for (const line of raw.split('\n')) {
        if (line.startsWith('event: ')) frame.event = line.slice('event: '.length)
        else if (line.startsWith('id: ')) frame.id = line.slice('id: '.length)
        else if (line.startsWith('data: ')) frame.data = JSON.parse(line.slice('data: '.length))
      }
      frames.push(frame)
      for (let i = waiters.length - 1; i >= 0; i--) {
        const waiter = waiters[i]
        if (waiter !== undefined && waiter.type === frame.event) {
          waiters.splice(i, 1)
          waiter.resolve(frame)
        }
      }
    }
  })
  return {
    frames,
    waitFor: (type, timeoutMs = 5000) => {
      const existing = frames.find((f) => f.event === type)
      if (existing !== undefined) return Promise.resolve(existing)
      return new Promise<Frame>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timed out waiting for SSE '${type}'`)),
          timeoutMs,
        )
        waiters.push({
          type,
          resolve: (f) => {
            clearTimeout(timer)
            resolve(f)
          },
        })
      })
    },
    destroy: () => stream.destroy?.(),
  }
}

let ctx: TestCtx
let workId: string

beforeEach(async () => {
  ctx = await makeTestCtx()
  await buildFixtureWork(path.join(ctx.dataDir, 'works'))
  workId = FIX.workId
})

afterEach(async () => {
  await destroyTestCtx(ctx)
})

async function openStream(query = ''): Promise<Collector> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/works/${workId}/events${query}`,
    payloadAsStream: true,
  })
  expect(res.statusCode).toBe(200)
  return collectFrames(res.stream())
}

describe('SSE follows REST', () => {
  it('starts with hello, then delivers snippet.created with the hydrated SnippetDto', async () => {
    const sse = await openStream()
    const hello = await sse.waitFor('hello')
    expect(sse.frames[0]).toBe(hello)

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/works/${workId}/snippets`,
      payload: { text: 'Streamed into being.' },
    })
    expect(res.statusCode).toBe(201)
    const created = SnippetDto.parse(res.json())

    const frame = await sse.waitFor('snippet.created')
    const event = WorkEvent.parse(frame.data)
    if (event.type !== 'snippet.created') throw new Error('wrong event type')
    // hydrated payload: the full DTO, byte-equal to what REST returned — no refetch needed
    expect(event.snippet).toEqual(created)
    // the domain event follows its REST 2xx on the one monotonic cursor
    expect(frame.id).toMatch(/^[0-9A-Z]{26}:\d+$/)
    sse.destroy()
  })

  it('delivers snippet.revised after PATCH and snippet.deleted after DELETE, in order', async () => {
    const sse = await openStream()
    await sse.waitFor('hello')

    const patch = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/works/${workId}/snippets/${FIX.snip1}`,
      payload: { text: 'Revised over the wire.', baseRev: 3 },
    })
    expect(patch.statusCode).toBe(200)
    const revised = await sse.waitFor('snippet.revised')
    const revisedEvent = WorkEvent.parse(revised.data)
    if (revisedEvent.type !== 'snippet.revised') throw new Error('wrong event type')
    expect(revisedEvent.snippet.text).toBe('Revised over the wire.')
    expect(revisedEvent.snippet.rev).toBe(4)

    const del = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/works/${workId}/snippets/${FIX.snip2}`,
    })
    expect(del.statusCode).toBe(204)
    const deleted = await sse.waitFor('snippet.deleted')
    const deletedEvent = WorkEvent.parse(deleted.data)
    if (deletedEvent.type !== 'snippet.deleted') throw new Error('wrong event type')
    expect(deletedEvent.id).toBe(FIX.snip2)

    // strict per-work ordering: revise seq < delete seq
    const seqOf = (frame: Frame): number => Number(frame.id?.split(':')[1] ?? Number.NaN)
    expect(seqOf(revised)).toBeLessThan(seqOf(deleted))
    sse.destroy()
  })

  it('?lastEventId resumes exactly like the Last-Event-ID header (manual reconnects)', async () => {
    const first = await openStream()
    await first.waitFor('hello')

    // two mutations → two frames; remember the FIRST frame's cursor
    const a = await ctx.app.inject({
      method: 'POST',
      url: `/api/works/${workId}/snippets`,
      payload: { text: 'First streamed line.' },
    })
    expect(a.statusCode).toBe(201)
    const firstFrame = await first.waitFor('snippet.created')
    const b = await ctx.app.inject({
      method: 'POST',
      url: `/api/works/${workId}/snippets`,
      payload: { text: 'Second streamed line.' },
    })
    expect(b.statusCode).toBe(201)
    first.destroy()

    // a manual reconnect cannot set the header — the query param is the fallback cursor
    const resumed = await openStream(`?lastEventId=${encodeURIComponent(firstFrame.id ?? '')}`)
    await resumed.waitFor('hello')
    const replayed = await resumed.waitFor('snippet.created')
    const event = WorkEvent.parse(replayed.data)
    if (event.type !== 'snippet.created') throw new Error('wrong event type')
    // exact replay from the ring — no resync (no invalidate-everything round trip)
    expect(event.snippet.text).toBe('Second streamed line.')
    expect(resumed.frames.some((f) => f.event === 'resync')).toBe(false)
    resumed.destroy()
  })

  it('delivers situation.changed with the new text after PUT /situation', async () => {
    const sse = await openStream()
    await sse.waitFor('hello')

    const current = (
      await ctx.app.inject({
        method: 'GET',
        url: `/api/works/${workId}/situation`,
      })
    ).json() as { hash: string }
    const put = await ctx.app.inject({
      method: 'PUT',
      url: `/api/works/${workId}/situation`,
      payload: { text: 'The storm makes landfall.', baseHash: current.hash },
    })
    expect(put.statusCode).toBe(200)

    const frame = await sse.waitFor('situation.changed')
    const event = WorkEvent.parse(frame.data)
    if (event.type !== 'situation.changed') throw new Error('wrong event type')
    expect(event.text).toBe('The storm makes landfall.')
    sse.destroy()
  })

  it('delivers enrichment.updated with the fresh SectionRow after a user title edit', async () => {
    const sse = await openStream()
    await sse.waitFor('hello')

    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/works/${workId}/sections/${FIX.sec1}`,
      payload: { title: 'Signals in the Fog' },
    })
    expect(res.statusCode).toBe(200)

    const frame = await sse.waitFor('enrichment.updated')
    const event = WorkEvent.parse(frame.data)
    if (event.type !== 'enrichment.updated') throw new Error('wrong event type')
    expect(event.kind).toBe('title')
    expect(event.sectionId).toBe(FIX.sec1)
    expect(event.section.title).toBe('Signals in the Fog')
    expect(event.section.titleSource).toBe('user')
    sse.destroy()
  })
})
