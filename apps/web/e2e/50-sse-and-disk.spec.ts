import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { createWork, E2E_URL, e2eDataDir, ensureConfigured } from './util'

/**
 * The Stage-2 demo-gate assertions that are API-shaped rather than UI-shaped
 * (docs/10-roadmap.md Stage-2 gate): the per-work SSE stream opens with `hello` and
 * echoes a `snippet.created` after the REST 2xx, and the files the API writes are
 * human-readable markdown on disk.
 */

interface SseFrame {
  event: string
  data: string
}

/** Minimal SSE reader over fetch streaming — collects frames until `until` matches. */
async function readSseUntil(
  url: string,
  until: (frame: SseFrame) => boolean,
  act?: () => Promise<void>,
  timeoutMs = 15_000,
): Promise<SseFrame[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const frames: SseFrame[] = []
  try {
    const res = await fetch(url, {
      headers: { accept: 'text/event-stream' },
      signal: controller.signal,
    })
    expect(res.ok).toBe(true)
    expect(res.headers.get('content-type') ?? '').toContain('text/event-stream')
    const body = res.body
    if (body === null) throw new Error('SSE response had no body')
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let acted = false
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let sep = buffer.indexOf('\n\n')
      while (sep !== -1) {
        const raw = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)
        sep = buffer.indexOf('\n\n')
        const lines = raw.split('\n')
        const event = lines
          .find((l) => l.startsWith('event:'))
          ?.slice('event:'.length)
          .trim()
        const data = lines
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice('data:'.length).trim())
          .join('\n')
        if (event === undefined) continue // comment/heartbeat frames
        const frame = { event, data }
        frames.push(frame)
        if (until(frame)) return frames
      }
      // fire the mutation only after the stream is live (first frame seen)
      if (!acted && frames.length > 0 && act !== undefined) {
        acted = true
        await act()
      }
    }
    return frames
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

test('SSE: hello on connect, snippet.created after the REST write', async ({ request }) => {
  await ensureConfigured(request)
  const work = await createWork(request, 'SSE Gate Work')
  const text = 'A snippet whose creation must echo on the event stream.'

  const frames = await readSseUntil(
    `${E2E_URL}/api/works/${work.id}/events`,
    (frame) => frame.event === 'snippet.created' && frame.data.includes('echo on the event'),
    async () => {
      const res = await request.post(`/api/works/${work.id}/snippets`, { data: { text } })
      expect(res.status()).toBe(201)
    },
  )

  expect(frames[0]?.event).toBe('hello')
  const created = frames.find((f) => f.event === 'snippet.created')
  expect(created).toBeDefined()
  const payload = JSON.parse(created?.data ?? '{}') as { snippet?: { text?: string } }
  expect(payload.snippet?.text).toBe(text)

  // the write landed as a human-readable markdown file under the work's frontier dir
  const snippetsDir = join(e2eDataDir(), 'works', work.slug, 'frontier', 'snippets')
  const files = readdirSync(snippetsDir).filter((f) => f.endsWith('.md'))
  expect(files.length).toBe(1)
  const fileName = files[0]
  if (fileName === undefined) throw new Error('no snippet file written')
  const content = readFileSync(join(snippetsDir, fileName), 'utf8')
  expect(content).toContain(text)

  // work.json is human-readable too
  const meta = readFileSync(join(e2eDataDir(), 'works', work.slug, 'work.json'), 'utf8')
  expect(meta).toContain('"SSE Gate Work"')
})
