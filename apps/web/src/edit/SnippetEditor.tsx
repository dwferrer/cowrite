import { useEffect, useRef, useState } from 'react'
import { ApiError } from '../api/client.js'
import { clearCrashCopy, readCrashCopy, useDocUiStore } from '../state/docUiStore.js'
import { testids } from '../testids.js'
import { Button } from '../ui/Button.js'
import { ConflictBanner } from '../ui/ConflictBanner.js'
import { pushToast } from '../ui/Toast.js'

/**
 * The plaintext editor (docs/04-frontend.md §7.1): auto-growing textarea, body font,
 * markdown as source. Enter = newline; Ctrl-Enter = save (one PATCH = one revision); Esc or
 * the visible Cancel button cancels (inline confirm when dirty). Every keystroke routes
 * through docUiStore.updateDraft — the ONE crash-copy writer (leading throttle, 500 ms),
 * which also keeps the store's editing draft fresh; a leftover copy offers "Restore
 * unsaved edit?". A 409 keeps the editor open with the draft and offers theirs/mine.
 *
 * The editing signal (POST /editing) is fired by docUiStore.beginEdit/endEdit — the parents
 * (SnippetBlock, FrontierBar) route open/close through the store.
 */

export interface SnippetEditorProps {
  workId: string
  /** Snippet id, or a stable pseudo-id ('new') for the frontier compose editor. */
  blockId: string
  initial: string
  /**
   * Commits the draft — one call, one revision. Must throw ApiError('conflict') on a 409;
   * implementations read the freshest baseRev/baseHash at call time so a "Keep mine" retry
   * resubmits against the reloaded base.
   */
  onSave(text: string): Promise<unknown>
  /** Called after a successful save or a cancel — parents close the editor + fire signals. */
  onClose(): void
}

export function SnippetEditor({ workId, blockId, initial, onSave, onClose }: SnippetEditorProps) {
  const [draft, setDraft] = useState(initial)
  const [conflict, setConflict] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [crashOffer, setCrashOffer] = useState<string | null>(() => {
    const copy = readCrashCopy(workId, blockId)
    return copy !== null && copy !== initial ? copy : null
  })
  const [saving, setSaving] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const dirty = draft !== initial

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  const updateDraft = (text: string) => {
    setDraft(text)
    // single-writer crash mirror + store-draft freshness (docUiStore owns the throttle)
    useDocUiStore.getState().updateDraft(workId, blockId, text)
  }

  const close = () => {
    clearCrashCopy(workId, blockId) // also cancels any pending trailing mirror
    onClose()
  }

  const doSave = async () => {
    if (saving) return
    setSaving(true)
    setConflict(false)
    try {
      await onSave(draft)
      close()
    } catch (err) {
      if (err instanceof ApiError && err.code === 'conflict') {
        setConflict(true)
        pushToast('Changed elsewhere — reloaded', { tone: 'error' })
      } else {
        pushToast(err instanceof Error ? err.message : 'Save failed', { tone: 'error' })
      }
    } finally {
      setSaving(false)
    }
  }

  const cancel = () => {
    if (dirty) setConfirmDiscard(true)
    else close()
  }

  // Esc pressed while focus is outside the textarea (global keymap routes it here)
  useEffect(() => {
    const onCancelEvent = () => cancel()
    window.addEventListener('cowrite:editor-cancel', onCancelEvent)
    return () => window.removeEventListener('cowrite:editor-cancel', onCancelEvent)
  })

  const rows = Math.max(3, draft.split('\n').length + 1)

  return (
    <div
      data-testid={testids.snippetEditor}
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}
    >
      {crashOffer !== null ? (
        <div className="editor-banner" data-testid={testids.editorDraftRestore}>
          <span style={{ flex: 1 }}>Restore unsaved edit?</span>
          <Button
            variant="ghost"
            onClick={() => {
              setDraft(crashOffer)
              setCrashOffer(null)
            }}
          >
            Restore
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              clearCrashCopy(workId, blockId)
              setCrashOffer(null)
            }}
          >
            Discard
          </Button>
        </div>
      ) : null}

      <textarea
        ref={textareaRef}
        className="snippet-editor__textarea"
        aria-label="Edit text"
        value={draft}
        rows={rows}
        onChange={(e) => updateDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && e.ctrlKey) {
            e.preventDefault()
            e.stopPropagation()
            void doSave()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            cancel()
          }
        }}
      />

      {conflict ? (
        <ConflictBanner
          message="Changed elsewhere — keep whose version?"
          testidPrefix={testids.snippetConflict}
          onTakeTheirs={close}
          onKeepMine={() => void doSave()}
        />
      ) : null}

      {confirmDiscard ? (
        <div className="editor-banner" data-testid={testids.editorDiscardConfirm}>
          <span style={{ flex: 1 }}>Discard changes?</span>
          <Button variant="danger" onClick={close}>
            Discard
          </Button>
          <Button variant="ghost" onClick={() => setConfirmDiscard(false)}>
            Keep editing
          </Button>
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end' }}>
        <Button data-testid={testids.editorCancel} onClick={cancel}>
          Cancel
        </Button>
        <Button
          data-testid={testids.editorSave}
          variant="primary"
          disabled={saving || draft.trim().length === 0}
          onClick={() => void doSave()}
        >
          Save <kbd style={{ fontFamily: 'var(--font-ui)', opacity: 0.8 }}>⌃⏎</kbd>
        </Button>
      </div>
    </div>
  )
}
