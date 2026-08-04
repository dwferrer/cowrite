/** Small helpers shared by this package's own tests (fetch-based SSE consumption). */

export interface SseEvent {
  data: string
}

/**
 * Read an SSE response body to completion, returning each `data:` payload in order.
 * Throws whatever the underlying stream throws (e.g. on a died-mid-stream socket) —
 * with `collected` carrying the events seen so far attached to the error.
 */
export async function readSse(res: Response): Promise<string[]> {
  const collected: string[] = []
  if (res.body === null) throw new Error('response has no body')
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk as Uint8Array, { stream: true })
      let sep = buffer.indexOf('\n\n')
      while (sep !== -1) {
        const frame = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)
        for (const line of frame.split('\n')) {
          if (line.startsWith('data: ')) collected.push(line.slice('data: '.length))
        }
        sep = buffer.indexOf('\n\n')
      }
    }
  } catch (err) {
    throw Object.assign(err instanceof Error ? err : new Error(String(err)), { collected })
  }
  return collected
}

/** POST JSON helper. */
export async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}
