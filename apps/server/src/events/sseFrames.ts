import type { WorkEvent } from '@cowrite/shared'
import type { EventSink } from './bus.js'

/**
 * THE in-process SSE frame parser: an EventSink that reassembles the bus's wire frames
 * (arbitrary chunk boundaries included) and hands each `data:` payload back as a parsed
 * WorkEvent — exactly the bytes and framing a browser EventSource would see. Shared by
 * the CLI's stdout streamer and the test suites' bus captures so there is exactly one
 * frame-splitting implementation against the bus. (mock-llm's `readSse` stays separate:
 * it consumes fetch Response bodies of the OpenAI mock, not bus EventSinks.)
 *
 * Comment frames (`:hb`, `:closed`) carry no `data:` line and parse to nothing.
 */
export function createSseFrameSink(onEvent: (event: WorkEvent) => void): EventSink {
  let buffer = ''
  return {
    write: (chunk) => {
      buffer += chunk
      for (;;) {
        const at = buffer.indexOf('\n\n')
        if (at === -1) return
        const frame = buffer.slice(0, at)
        buffer = buffer.slice(at + 2)
        for (const line of frame.split('\n')) {
          if (line.startsWith('data: ')) onEvent(JSON.parse(line.slice(6)) as WorkEvent)
        }
      }
    },
    end: () => {},
  }
}
