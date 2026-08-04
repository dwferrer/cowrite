import { pushToast } from '../ui/Toast.js'
import { ApiError } from './client.js'

/**
 * Shared task-create error surface (docs/04-frontend.md §8.1, §14): a 409 `config_missing`
 * must never be a bare error toast — it links to /settings; a 409 `busy` names the running
 * task ("already writing"). Everything else toasts the envelope message.
 */
export function toastTaskCreateError(err: unknown, gotoSettings: () => void): void {
  if (err instanceof ApiError) {
    if (err.code === 'config_missing') {
      pushToast('Models are not configured — set up endpoints in Settings', {
        tone: 'error',
        action: { label: 'Open Settings', onClick: gotoSettings },
        ttlMs: 0, // blocking callout, not a transient — dismissed explicitly
      })
      return
    }
    if (err.code === 'busy') {
      pushToast('The agent is already writing — cancel the running task first', { tone: 'error' })
      return
    }
    pushToast(err.message, { tone: 'error' })
    return
  }
  pushToast(err instanceof Error ? err.message : 'Could not start the task', { tone: 'error' })
}
