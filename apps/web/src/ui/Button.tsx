import type { ButtonHTMLAttributes } from 'react'

/**
 * Minimal accessible button atom. Variants map to token colors; everything else is native
 * <button> semantics (real focus, real disabled).
 */

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'danger' | 'ghost'
}

const baseStyle: React.CSSProperties = {
  alignItems: 'center',
  border: '1px solid var(--border-strong)',
  borderRadius: 'var(--radius-1)',
  cursor: 'pointer',
  display: 'inline-flex',
  font: 'inherit',
  gap: 'var(--space-1)',
  padding: '6px 12px',
}

const variantStyle: Record<NonNullable<ButtonProps['variant']>, React.CSSProperties> = {
  default: { background: 'var(--bg-raised)', color: 'var(--fg)' },
  primary: {
    background: 'var(--accent)',
    borderColor: 'var(--accent)',
    color: 'var(--bg-raised)',
  },
  danger: { background: 'var(--bg-raised)', borderColor: 'var(--danger)', color: 'var(--danger)' },
  ghost: { background: 'transparent', borderColor: 'transparent', color: 'var(--fg-muted)' },
}

export function Button({ variant = 'default', style, type, disabled, ...rest }: ButtonProps) {
  return (
    <button
      type={type ?? 'button'}
      disabled={disabled}
      style={{
        ...baseStyle,
        ...variantStyle[variant],
        ...(disabled ? { cursor: 'not-allowed', opacity: 0.5 } : {}),
        ...style,
      }}
      {...rest}
    />
  )
}
