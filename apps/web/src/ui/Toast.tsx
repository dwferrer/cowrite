import { create } from 'zustand'
import { testids } from '../testids.js'
import { Button } from './Button.js'

/**
 * Minimal toast system: a tiny store (`pushToast` callable from anywhere, incl. the SSE
 * reducer later) + one <Toaster/> mounted at the app root. role="status" so screen readers
 * announce without stealing focus.
 */

export interface ToastAction {
  label: string
  onClick: () => void
}

export interface ToastItem {
  id: number
  /** Optional stable identity (e.g. `undo:<opId>`): pushing the same key replaces the
   *  existing toast, and `dismissByKey` removes it from anywhere (the SSE reducer). */
  key?: string
  message: string
  tone: 'info' | 'error'
  action?: ToastAction
}

export interface ToastOptions {
  tone?: 'info' | 'error'
  action?: ToastAction
  ttlMs?: number
  key?: string
}

interface ToastState {
  toasts: ToastItem[]
  push(message: string, opts?: ToastOptions): void
  dismiss(id: number): void
  dismissByKey(key: string): void
}

let nextToastId = 1

export const useToastStore = create<ToastState>()((set, get) => ({
  toasts: [],
  push: (message, opts) => {
    const id = nextToastId++
    const toast: ToastItem = {
      id,
      ...(opts?.key === undefined ? {} : { key: opts.key }),
      message,
      tone: opts?.tone ?? 'info',
      ...(opts?.action ? { action: opts.action } : {}),
    }
    set((state) => ({
      // same key ⇒ replace (a re-attach re-offering the undo toast must not stack)
      toasts: [...state.toasts.filter((t) => opts?.key === undefined || t.key !== opts.key), toast],
    }))
    const ttl = opts?.ttlMs ?? 6_000
    if (ttl > 0) setTimeout(() => get().dismiss(id), ttl)
  },
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
  dismissByKey: (key) => set((state) => ({ toasts: state.toasts.filter((t) => t.key !== key) })),
}))

export function pushToast(message: string, opts?: ToastOptions): void {
  useToastStore.getState().push(message, opts)
}

export function dismissToastByKey(key: string): void {
  useToastStore.getState().dismissByKey(key)
}

export function Toaster() {
  const toasts = useToastStore((s) => s.toasts)
  const dismiss = useToastStore((s) => s.dismiss)
  if (toasts.length === 0) return null
  return (
    <div
      style={{
        bottom: 'var(--space-4)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-2)',
        position: 'fixed',
        right: 'var(--space-4)',
        zIndex: 200,
      }}
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role="status"
          data-testid={testids.toast}
          style={{
            alignItems: 'center',
            background: 'var(--bg-raised)',
            border: `1px solid ${toast.tone === 'error' ? 'var(--danger)' : 'var(--border-strong)'}`,
            borderRadius: 'var(--radius-1)',
            boxShadow: 'var(--shadow-1)',
            display: 'flex',
            gap: 'var(--space-3)',
            maxWidth: 420,
            padding: 'var(--space-2) var(--space-3)',
          }}
        >
          <span style={{ flex: 1 }}>{toast.message}</span>
          {toast.action ? (
            <Button
              variant="ghost"
              onClick={() => {
                toast.action?.onClick()
                dismiss(toast.id)
              }}
            >
              {toast.action.label}
            </Button>
          ) : null}
          <Button variant="ghost" aria-label="Dismiss" onClick={() => dismiss(toast.id)}>
            ✕
          </Button>
        </div>
      ))}
    </div>
  )
}
