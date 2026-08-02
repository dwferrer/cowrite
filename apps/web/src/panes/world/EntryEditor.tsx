import type { WorldEntryDto } from '@cowrite/shared'
import { useEffect, useState } from 'react'
import { ApiError } from '../../api/client.js'
import { usePatchWorldEntry } from '../../api/queries.js'
import { Markdown } from '../../render/Markdown.js'
import { testids } from '../../testids.js'
import { Button } from '../../ui/Button.js'
import { ConflictBanner } from '../../ui/ConflictBanner.js'
import { TextInput } from '../../ui/TextInput.js'
import { pushToast } from '../../ui/Toast.js'
import { EntryImage } from './EntryImage.js'

/**
 * World-entry detail editor (docs/04-frontend.md §9.3): inline-editable name, a keys chip
 * editor (zero keys is valid), the shortSummary one-liner, the image block, and an
 * always-editable markdown body with a rendered-preview toggle. Ctrl-Enter saves the body,
 * Esc reverts; a stale-body 409 offers reload-and-retry.
 */

export interface EntryEditorProps {
  workId: string
  entry: WorldEntryDto
  readonly?: boolean
}

export function EntryEditor({ workId, entry, readonly = false }: EntryEditorProps) {
  const patch = usePatchWorldEntry(workId)
  const [name, setName] = useState(entry.name)
  const [shortSummary, setShortSummary] = useState(entry.shortSummary ?? '')
  const [body, setBody] = useState(entry.body)
  const [keyInput, setKeyInput] = useState('')
  const [preview, setPreview] = useState(false)
  /** The 409 payload — its currentHash is the ONLY valid base for a 'Keep mine' retry. */
  const [bodyConflict, setBodyConflict] = useState<{
    currentHash: string
    currentText: string
  } | null>(null)

  // external change (SSE world.changed → refetch) refreshes fields we are not editing
  // biome-ignore lint/correctness/useExhaustiveDependencies: sync from server on entry identity/content change only
  useEffect(() => {
    setName(entry.name)
    setShortSummary(entry.shortSummary ?? '')
    setBody(entry.body)
    setBodyConflict(null)
  }, [entry.id, entry.updatedAt])

  const commit = (input: Parameters<typeof patch.mutate>[0]['patch']) => {
    patch.mutate(
      { entryId: entry.id, patch: input },
      {
        onSuccess: () => {
          setBodyConflict(null)
        },
        onError: (err) => {
          if (err instanceof ApiError && err.code === 'conflict') {
            const details = err.details as { currentHash?: string; currentText?: string }
            setBodyConflict({
              currentHash: details.currentHash ?? '',
              currentText: details.currentText ?? '',
            })
          } else {
            pushToast(err instanceof Error ? err.message : 'Save failed', { tone: 'error' })
          }
        },
      },
    )
  }

  const addKey = () => {
    const key = keyInput.trim()
    if (key.length === 0) return
    if (entry.keys.includes(key)) {
      setKeyInput('')
      return
    }
    commit({ keys: [...entry.keys, key] })
    setKeyInput('')
  }

  const removeKey = (key: string) => {
    commit({ keys: entry.keys.filter((k) => k !== key) })
  }

  const saveBody = () => {
    if (body === entry.body) return
    // every body replacement carries the concurrency token (03 §3.5)
    commit({ body, baseHash: entry.bodyHash })
  }

  const bodyDirty = body !== entry.body

  return (
    <div
      data-testid={testids.worldEntryDetail}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-3)',
        padding: 'var(--space-3)',
      }}
    >
      <TextInput
        label="Name"
        data-testid={testids.worldEntryName}
        value={name}
        disabled={readonly}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => {
          const next = name.trim()
          if (next.length > 0 && next !== entry.name) commit({ name: next })
          else setName(entry.name)
        }}
      />

      <div>
        <span style={{ color: 'var(--fg-muted)', fontSize: 12 }}>
          Keys (aliases that highlight in the text — zero is fine)
        </span>
        <div
          style={{
            alignItems: 'center',
            display: 'flex',
            flexWrap: 'wrap',
            gap: 'var(--space-1)',
            marginTop: 4,
          }}
        >
          {entry.keys.map((key) => (
            <span key={key} className="key-chip" data-testid={testids.worldKeyChip}>
              {key}
              {readonly ? null : (
                <button
                  type="button"
                  className="key-chip__remove"
                  aria-label={`Remove key ${key}`}
                  onClick={() => removeKey(key)}
                >
                  ✕
                </button>
              )}
            </span>
          ))}
          {readonly ? null : (
            <input
              data-testid={testids.worldKeyInput}
              aria-label="Add key"
              placeholder="add key…"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ',') {
                  e.preventDefault()
                  addKey()
                } else if (e.key === 'Escape') {
                  e.stopPropagation()
                  setKeyInput('')
                }
              }}
              onBlur={addKey}
              style={{
                background: 'var(--bg-raised)',
                border: '1px dashed var(--border-strong)',
                borderRadius: 'var(--radius-1)',
                color: 'var(--fg)',
                font: 'inherit',
                padding: '2px 8px',
                width: 110,
              }}
            />
          )}
        </div>
      </div>

      <TextInput
        label="One-line summary"
        data-testid={testids.worldShortSummary}
        value={shortSummary}
        disabled={readonly}
        onChange={(e) => setShortSummary(e.target.value)}
        onBlur={() => {
          const next = shortSummary.trim()
          if (next !== (entry.shortSummary ?? '')) {
            commit({ shortSummary: next.length > 0 ? next : null })
          }
        }}
      />

      <EntryImage workId={workId} entry={entry} readonly={readonly} />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
        <div style={{ alignItems: 'center', display: 'flex', gap: 'var(--space-2)' }}>
          <span style={{ color: 'var(--fg-muted)', flex: 1, fontSize: 12 }}>Body (markdown)</span>
          <Button
            variant="ghost"
            data-testid={testids.worldBodyPreview}
            aria-pressed={preview}
            onClick={() => setPreview((p) => !p)}
          >
            {preview ? 'edit' : 'preview'}
          </Button>
        </div>

        {bodyConflict !== null ? (
          <ConflictBanner
            message="Changed elsewhere — keep whose version?"
            testidPrefix={testids.worldConflict}
            onTakeTheirs={() => {
              // adopt the 409's server text — fresher than any cached entry.body
              setBody(bodyConflict.currentText)
              setBodyConflict(null)
            }}
            onKeepMine={() => {
              // resubmit against the REFETCHED hash from the 409 — retrying with the
              // stale entry.bodyHash would just 409 again, forever
              const retryHash = bodyConflict.currentHash
              setBodyConflict(null)
              commit({ body, baseHash: retryHash })
            }}
          />
        ) : null}

        {preview ? (
          <div
            className="prose"
            style={{
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-1)',
              padding: 'var(--space-3)',
            }}
          >
            <Markdown markdown={body} />
          </div>
        ) : (
          <textarea
            data-testid={testids.worldBodyText}
            aria-label="Entry body"
            value={body}
            disabled={readonly}
            rows={Math.max(8, body.split('\n').length + 1)}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && e.ctrlKey) {
                e.preventDefault()
                e.stopPropagation()
                saveBody()
              } else if (e.key === 'Escape') {
                e.stopPropagation()
                setBody(entry.body) // Esc reverts
              }
            }}
            style={{
              background: 'var(--bg-raised)',
              border: '1px solid var(--border-strong)',
              borderRadius: 'var(--radius-1)',
              color: 'var(--fg)',
              font: 'inherit',
              padding: 'var(--space-2)',
              resize: 'vertical',
            }}
          />
        )}

        {bodyDirty && !readonly ? (
          <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={() => setBody(entry.body)}>
              Revert
            </Button>
            <Button data-testid={testids.worldBodySave} variant="primary" onClick={saveBody}>
              Save <kbd style={{ fontFamily: 'var(--font-ui)', opacity: 0.8 }}>⌃⏎</kbd>
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  )
}
