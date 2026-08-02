import { type ReactNode, useEffect, useRef } from 'react'
import { testids } from '../testids.js'

/**
 * Minimal accessible modal dialog: role="dialog", aria-modal, labelled by its title,
 * Esc/backdrop closes, focus moves in on open. Deliberately not a focus-trap library —
 * good enough for the handful of confirm/create dialogs in MVP.
 */

export interface DialogProps {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
}

export function Dialog({ open, title, onClose, children }: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    panelRef.current?.focus()
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open) return null

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-close is supplementary; Esc is the accessible path
    // biome-ignore lint/a11y/useKeyWithClickEvents: the document-level Escape listener is the keyboard equivalent
    <div
      onClick={onClose}
      style={{
        alignItems: 'center',
        background: 'oklch(0 0 0 / 0.4)',
        display: 'flex',
        inset: 0,
        justifyContent: 'center',
        position: 'fixed',
        zIndex: 100,
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid={testids.dialog}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg-raised)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-2)',
          boxShadow: 'var(--shadow-2)',
          maxWidth: 480,
          minWidth: 320,
          padding: 'var(--space-5)',
        }}
      >
        <h2 style={{ fontSize: 16, marginTop: 0 }}>{title}</h2>
        {children}
      </div>
    </div>
  )
}
