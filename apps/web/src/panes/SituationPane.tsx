import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { ApiError } from '../api/client.js'
import { useWorkStatusStore } from '../api/events.js'
import { qk, useSaveSituation, useSituation } from '../api/queries.js'
import { Markdown } from '../render/Markdown.js'
import { testids } from '../testids.js'
import { Button } from '../ui/Button.js'
import { ConflictBanner } from '../ui/ConflictBanner.js'
import { useSituationBridge } from './situationBridge.js'

/**
 * The situation pane (docs/04-frontend.md §9.1): an always-editable scratchpad with its own
 * scroll. Rendered markdown at rest; click (or focus) swaps in the plaintext textarea.
 *
 * Saving runs through ONE controller: `{lastAckedText, lastAckedHash}` live in the work
 * status store (next to the SSE reducer — no stale closures, and hello/focus refetches
 * cannot rebase the hash under a dirty draft), `{inFlight, queued}` live in a ref here.
 * Dirty ≡ draft !== lastAckedText. Debounce, blur, and keep-mine all enqueue; there is at
 * most one save in flight, always against the acked hash; success updates the acked state
 * and runs the queued text. A 409 surfaces theirs/mine: 'Theirs' adopts the server text,
 * 'Mine' rebases the acked hash onto the conflict's currentHash and re-enqueues the draft
 * (converging in one retry). An incoming foreign `situation.changed` while dirty shows
 * the "changed on disk" chip instead of clobbering (the SSE reducer consults the store).
 */

const SAVE_DEBOUNCE_MS = 1_000

interface ConflictInfo {
  currentText: string
  currentHash: string
  updatedAt: string | null
  /** The text whose save 409'd — 'Mine' falls back to it when the draft was dropped. */
  heldText: string
}

export interface SituationPaneProps {
  workId: string
  width: number
}

export function SituationPane({ workId, width }: SituationPaneProps) {
  const qc = useQueryClient()
  const situation = useSituation(workId)
  const save = useSaveSituation(workId)
  const setDirty = useWorkStatusStore((s) => s.setSituationDirty)
  const changedOnDisk = useWorkStatusStore((s) => s.situationChangedOnDisk)
  const pendingAppend = useSituationBridge((s) => s.pending)
  const consumeAppend = useSituationBridge((s) => s.consume)

  const [draft, setDraftState] = useState<string | null>(null) // null = tracking acked text
  const draftRef = useRef<string | null>(null)
  const setDraft = (value: string | null) => {
    draftRef.current = value
    setDraftState(value)
  }
  const [editing, setEditing] = useState(false)
  const [conflict, setConflict] = useState<ConflictInfo | null>(null)
  /** Single-save-in-flight queue; the acked base lives in the work status store. */
  const ctrlRef = useRef<{ inFlight: string | null; queued: string | null }>({
    inFlight: null,
    queued: null,
  })
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Adopt refetched server data into the acked state — the dirty-guard lives at this
  // cache-adjacent point: while the draft is dirty (or a save is in flight) a refetch
  // must NOT rebase the hash under it; the next save then 409s and prompts instead of
  // silently overwriting a foreign edit.
  useEffect(() => {
    const data = situation.data
    if (!data) return
    const status = useWorkStatusStore.getState()
    const acked = status.situationAcked
    if (acked === null) {
      status.setSituationAcked({ text: data.text, hash: data.hash })
      return
    }
    if (data.hash === acked.hash) return
    if (status.situationDirty || ctrlRef.current.inFlight !== null) return // dirty-guard
    status.setSituationAcked({ text: data.text, hash: data.hash })
  }, [situation.data])

  const runSave = (value: string) => {
    const ctrl = ctrlRef.current
    const status = useWorkStatusStore.getState()
    ctrl.inFlight = value
    status.setSituationInFlightText(value)
    save.mutate(
      { text: value, baseHash: status.situationAcked?.hash ?? null },
      {
        onSuccess: (res) => {
          const st = useWorkStatusStore.getState()
          ctrl.inFlight = null
          st.setSituationInFlightText(null)
          st.setSituationAcked({ text: value, hash: res.hash })
          // a self-echo that raced ahead of this response must not leave a chip behind
          if (st.situationChangedOnDisk?.text === value) st.setSituationChangedOnDisk(null)
          setConflict(null)
          const queued = ctrl.queued
          ctrl.queued = null
          if (queued !== null && queued !== value) {
            runSave(queued)
            return
          }
          if (draftRef.current === null || draftRef.current === value) {
            setDraft(null)
            st.setSituationDirty(false)
          }
        },
        onError: (err) => {
          const st = useWorkStatusStore.getState()
          ctrl.inFlight = null
          ctrl.queued = null
          st.setSituationInFlightText(null)
          if (err instanceof ApiError && err.code === 'conflict') {
            const details = err.details as {
              currentText?: string
              currentHash?: string
              updatedAt?: string
            }
            setConflict({
              currentText: details.currentText ?? '',
              currentHash: details.currentHash ?? '',
              updatedAt: details.updatedAt ?? null,
              heldText: value,
            })
          }
        },
      },
    )
  }

  /** The one entry point every save path uses (debounce, blur, keep-mine). */
  const enqueue = (value: string) => {
    if (debounceRef.current !== undefined) {
      clearTimeout(debounceRef.current)
      debounceRef.current = undefined
    }
    const status = useWorkStatusStore.getState()
    if (value === status.situationAcked?.text && ctrlRef.current.inFlight === null) {
      setDraft(null) // nothing to save — back to tracking
      status.setSituationDirty(false)
      return
    }
    const ctrl = ctrlRef.current
    if (ctrl.inFlight !== null) {
      ctrl.queued = value
      return
    }
    runSave(value)
  }

  const onChange = (value: string) => {
    setDraft(value)
    const acked = useWorkStatusStore.getState().situationAcked
    setDirty(value !== (acked?.text ?? situation.data?.text ?? ''))
    if (debounceRef.current !== undefined) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      const current = draftRef.current
      if (current !== null) enqueue(current)
    }, SAVE_DEBOUNCE_MS)
  }

  /** Adopt a server version (chip or 409) as the new base and drop local edits. */
  const adoptServer = (text: string, hash: string, updatedAt: string | null) => {
    const status = useWorkStatusStore.getState()
    status.setSituationAcked({ text, hash })
    qc.setQueryData(
      qk.situation(workId),
      (old: { text: string; updatedAt: string; hash: string } | undefined) => ({
        text,
        updatedAt: updatedAt ?? old?.updatedAt ?? new Date().toISOString(),
        hash,
      }),
    )
    status.setSituationChangedOnDisk(null)
    status.setSituationDirty(false)
    setDraft(null)
    setConflict(null)
  }

  // copy-selection-from-doc appends (04 §9.1)
  useEffect(() => {
    if (!pendingAppend || pendingAppend.workId !== workId) return
    const req = consumeAppend()
    if (!req) return
    const current = draft ?? situation.data?.text ?? ''
    const joined = current.length > 0 ? `${current.trimEnd()}\n\n${req.markdown}` : req.markdown
    setEditing(true)
    onChange(joined)
  })

  useEffect(
    () => () => {
      if (debounceRef.current !== undefined) clearTimeout(debounceRef.current)
    },
    [],
  )

  useEffect(() => {
    if (editing) textareaRef.current?.focus()
  }, [editing])

  const text = draft ?? situation.data?.text ?? ''

  return (
    <aside
      className="situation-pane"
      data-testid={testids.situationPane}
      style={{ width }}
      aria-label="Situation"
    >
      <div
        style={{
          alignItems: 'center',
          color: 'var(--fg-muted)',
          display: 'flex',
          fontSize: 12,
          gap: 'var(--space-2)',
          marginBottom: 'var(--space-2)',
        }}
      >
        <span style={{ flex: 1 }}>✎ situation</span>
        {save.isSuccess && draft === null ? (
          <span data-testid={testids.situationSavedTick} style={{ color: 'var(--ok)' }}>
            saved ✓
          </span>
        ) : null}
      </div>

      {changedOnDisk ? (
        <div
          data-testid={testids.situationConflictChip}
          style={{
            alignItems: 'center',
            background: 'var(--warn-bg)',
            borderRadius: 'var(--radius-1)',
            display: 'flex',
            fontSize: 12,
            gap: 'var(--space-2)',
            marginBottom: 'var(--space-2)',
            padding: 'var(--space-1) var(--space-2)',
          }}
        >
          <span style={{ flex: 1 }}>changed on disk</span>
          <Button
            variant="ghost"
            onClick={() => {
              // drop local edits, adopt the disk version (its hash rode the event)
              adoptServer(changedOnDisk.text, changedOnDisk.hash, changedOnDisk.updatedAt)
            }}
          >
            Take theirs
          </Button>
        </div>
      ) : null}

      {conflict !== null ? (
        <ConflictBanner
          message="Changed elsewhere — keep whose version?"
          testidPrefix={testids.situationConflict}
          onTakeTheirs={() => {
            // theirs: the 409 payload IS the disk version — adopt it, drop the draft
            adoptServer(conflict.currentText, conflict.currentHash, conflict.updatedAt)
          }}
          onKeepMine={() => {
            // mine: rebase the acked hash onto the conflict's currentHash, then
            // re-enqueue the draft (falling back to the text that 409'd when the
            // draft state was dropped) — converges in exactly one retry
            const status = useWorkStatusStore.getState()
            status.setSituationAcked({
              text: conflict.currentText,
              hash: conflict.currentHash,
            })
            setConflict(null)
            const value = draftRef.current ?? conflict.heldText
            setDraft(value)
            status.setSituationDirty(true)
            enqueue(value)
          }}
        />
      ) : null}

      {editing ? (
        <textarea
          ref={textareaRef}
          className="instruction-surface"
          data-testid={testids.situationText}
          aria-label="Situation notes"
          value={text}
          onChange={(e) => onChange(e.target.value)}
          onBlur={() => {
            setEditing(false)
            const current = draftRef.current
            if (current !== null) enqueue(current)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation()
              textareaRef.current?.blur()
            }
          }}
          style={{
            color: 'var(--fg)',
            flex: 1,
            minHeight: 200,
            padding: 'var(--space-2)',
            resize: 'none',
          }}
        />
      ) : (
        // biome-ignore lint/a11y/noStaticElementInteractions: the rendered view swaps to a real textarea; the button below is the keyboard path
        // biome-ignore lint/a11y/useKeyWithClickEvents: focusable edit affordance provided via the Edit button
        <div
          className="instruction-surface situation-rest"
          data-testid={testids.situationRendered}
          onClick={() => setEditing(true)}
          style={{
            cursor: 'text',
            flex: 1,
            minHeight: 200,
            overflowY: 'auto',
            padding: 'var(--space-2)',
          }}
        >
          {text.trim().length > 0 ? (
            <Markdown markdown={text} />
          ) : (
            <span style={{ color: 'var(--fg-faint)' }}>
              Notes for the agent — goals, tone, what happens next…
            </span>
          )}
          <div style={{ marginTop: 'var(--space-2)' }}>
            <Button variant="ghost" onClick={() => setEditing(true)} aria-label="Edit situation">
              edit
            </Button>
          </div>
        </div>
      )}
    </aside>
  )
}
