import { api } from '@cowrite/shared'

/**
 * Editor-open declaration (docs/04-frontend.md §7.1): opening a snippet editor POSTs the
 * snippet id, closing it POSTs null, so consolidation's eligible prefix can never freeze the
 * passage under the cursor (02 §6.2). Fire-and-forget with one retry — `keepalive` lets the
 * close signal survive tab teardown.
 */
export function signalEditing(workId: string, snippetId: string | null): void {
  const url = api.setEditing.path(workId)
  const send = () =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ snippetId }),
      keepalive: true,
    }).then((res) => {
      if (!res.ok) throw new Error(`editing signal failed: HTTP ${res.status}`)
    })
  send().catch(() => {
    send().catch(() => {
      // best-effort only — the server also clears the flag when SSE subscribers drop to zero
    })
  })
}
