import { type InputHTMLAttributes, type ReactNode, useId } from 'react'

/**
 * Minimal accessible labeled text input. The label is always rendered and always associated
 * (htmlFor/id) so tests and screen readers address fields by name.
 */

export interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string
  /** Small helper/provenance text rendered after the label (e.g. "set by COWRITE_X"). */
  hint?: ReactNode
}

export function TextInput({ label, hint, id, style, ...rest }: TextInputProps) {
  const autoId = useId()
  const inputId = id ?? autoId
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
      <label htmlFor={inputId} style={{ color: 'var(--fg-muted)', fontSize: 12 }}>
        {label}
        {hint ? (
          <span style={{ color: 'var(--fg-faint)', marginLeft: 'var(--space-2)' }}>{hint}</span>
        ) : null}
      </label>
      <input
        id={inputId}
        style={{
          background: 'var(--bg-raised)',
          border: '1px solid var(--border-strong)',
          borderRadius: 'var(--radius-1)',
          color: 'var(--fg)',
          font: 'inherit',
          padding: '6px 10px',
          ...style,
        }}
        {...rest}
      />
    </div>
  )
}
