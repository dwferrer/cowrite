import { useEffect, useRef, useState } from 'react'
import { Button } from '../../ui/Button.js'

/**
 * The one-line illustration guidance box (docs/04-frontend.md §10; 08 §5), shared by the section
 * header's "Regenerate…" menu and the world-entry image pane. It owns the single copy of the box
 * behavior: the text value, focus-on-open, the 500-char cap (08 §4.2 rule 6), and the
 * Enter-submits / Escape-cancels key handling. The parent owns only whether the box is mounted
 * (open) and what a submit does; each surface passes its own testids so the two stay
 * independently addressable in tests and e2e.
 */

/** ≤ 500 chars — matches the composer's guidance clamp (08 §4.2). */
const GUIDANCE_MAX_CHARS = 500

export interface RegenerateGuidanceBoxProps {
  /** Optional testid on the wrapper (the section header addresses the whole box; the world pane
   *  addresses the input directly, so it omits this). */
  boxTestId?: string
  inputTestId: string
  submitTestId: string
  cancelTestId: string
  placeholder: string
  submitLabel: string
  cancelLabel?: string
  /** Disables submit while a run is already pending. */
  pending?: boolean
  /** `plain` renders the header-menu buttons; `ui` renders the styled `Button`s the world pane uses. */
  buttons?: 'plain' | 'ui'
  onSubmit: (guidance: string) => void
  onCancel: () => void
}

export function RegenerateGuidanceBox({
  boxTestId,
  inputTestId,
  submitTestId,
  cancelTestId,
  placeholder,
  submitLabel,
  cancelLabel = 'Cancel',
  pending = false,
  buttons = 'plain',
  onSubmit,
  onCancel,
}: RegenerateGuidanceBoxProps) {
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const submit = () => onSubmit(value)

  return (
    <div className="regenerate-guidance-box" data-testid={boxTestId}>
      <input
        ref={inputRef}
        type="text"
        data-testid={inputTestId}
        className="quick-edit-box__input"
        placeholder={placeholder}
        value={value}
        maxLength={GUIDANCE_MAX_CHARS}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            submit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
          }
        }}
      />
      {buttons === 'ui' ? (
        <>
          <Button data-testid={submitTestId} disabled={pending} onClick={submit}>
            {submitLabel}
          </Button>
          <Button variant="ghost" data-testid={cancelTestId} onClick={onCancel}>
            {cancelLabel}
          </Button>
        </>
      ) : (
        <>
          <button type="button" data-testid={submitTestId} disabled={pending} onClick={submit}>
            {submitLabel}
          </button>
          <button type="button" data-testid={cancelTestId} onClick={onCancel}>
            {cancelLabel}
          </button>
        </>
      )}
    </div>
  )
}
