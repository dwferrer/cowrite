import type { Fidelity } from '@cowrite/shared'
import { create } from 'zustand'
import { signalEditing } from '../api/editingSignal.js'

/**
 * Session-scoped document UI state (docs/04-frontend.md §4.4) — selection, the open editor
 * draft, revision peeking, follow-bottom. Never persisted, except the editor draft's
 * crash copy which mirrors (throttled) to localStorage.
 */

/** Pure UI ergonomics alias of the shared Fidelity vocabulary (04 §5.3). */
export type FoldLevel = Fidelity

export interface BlockRef {
  kind: 'snippet' | 'section'
  id: string
}

export interface EditingState extends BlockRef {
  workId: string
  draft: string
  baseRev?: number
  baseHash?: string
}

const CRASH_COPY_THROTTLE_MS = 500

function draftKey(workId: string, blockId: string): string {
  return `cowrite:draft:${workId}:${blockId}`
}

/** Leftover crash copy for a block, if any (offered as "Restore unsaved edit?" on mount). */
export function readCrashCopy(workId: string, blockId: string): string | null {
  try {
    return localStorage.getItem(draftKey(workId, blockId))
  } catch {
    return null
  }
}

// The ONE crash-copy writer: a leading-edge throttle (first keystroke writes through,
// later ones coalesce into a trailing write) so the mirror stays fresh under continuous
// typing. Module-level state — at most one editor is open at a time (04 §7.1).
let lastMirrorAt = 0
let mirrorTimer: ReturnType<typeof setTimeout> | undefined
let pendingMirror: { workId: string; blockId: string } | null = null

function cancelPendingMirror(): void {
  if (mirrorTimer !== undefined) clearTimeout(mirrorTimer)
  mirrorTimer = undefined
  pendingMirror = null
}

function writeCrashCopy(workId: string, blockId: string, text: string): void {
  lastMirrorAt = Date.now()
  try {
    localStorage.setItem(draftKey(workId, blockId), text)
  } catch {
    // storage unavailable — crash copies are best-effort
  }
}

function mirrorCrashCopy(workId: string, blockId: string, text: string): void {
  cancelPendingMirror()
  // clamped at 0 so clock skew can never stretch the wait past one throttle window
  const elapsed = Math.max(0, Date.now() - lastMirrorAt)
  if (elapsed >= CRASH_COPY_THROTTLE_MS) {
    writeCrashCopy(workId, blockId, text)
    return
  }
  pendingMirror = { workId, blockId }
  mirrorTimer = setTimeout(() => {
    mirrorTimer = undefined
    pendingMirror = null
    writeCrashCopy(workId, blockId, text)
  }, CRASH_COPY_THROTTLE_MS - elapsed)
}

/** Also cancels a pending trailing mirror for the block, so a close can never lose the
 *  race to a timer that would resurrect the just-cleared copy. */
export function clearCrashCopy(workId: string, blockId: string): void {
  if (
    pendingMirror !== null &&
    pendingMirror.workId === workId &&
    pendingMirror.blockId === blockId
  ) {
    cancelPendingMirror()
  }
  try {
    localStorage.removeItem(draftKey(workId, blockId))
  } catch {
    // storage unavailable — crash copies are best-effort
  }
}

interface DocUiState {
  selection: BlockRef | null
  editing: EditingState | null
  peekRevision: { snippetId: string; rev: number } | null
  followBottom: boolean
  /** Selecting clears any revision peek (04 §7.2). */
  select(ref: BlockRef | null): void
  /** Clears selection and peek; fires the editing signal for snippets (04 §7.1). */
  beginEdit(
    workId: string,
    ref: BlockRef,
    initial: string,
    base?: { baseRev?: number; baseHash?: string },
  ): void
  /**
   * THE draft write path (single crash-copy writer): keeps `editing.draft` fresh when
   * the block has a store session and mirrors the localStorage crash copy either way
   * (leading throttle, 500 ms) — the compose editor ('new') has no store session but
   * still gets its crash copy.
   */
  updateDraft(workId: string, blockId: string, text: string): void
  /** `save: true` when the draft was committed — the crash copy is cleared either way. */
  endEdit(): void
  setPeekRevision(peek: { snippetId: string; rev: number } | null): void
  setFollowBottom(followBottom: boolean): void
  /** SSE reducer hook: drop any refs pointing at a deleted/consumed entity (04 §4.1). */
  clearRefsFor(id: string): void
}

export const useDocUiStore = create<DocUiState>()((set, get) => ({
  selection: null,
  editing: null,
  peekRevision: null,
  followBottom: true,

  select: (ref) => set({ selection: ref, peekRevision: null }),

  beginEdit: (workId, ref, initial, base) => {
    // fresh session: cancel any pending mirror and let the first keystroke write through
    cancelPendingMirror()
    lastMirrorAt = 0
    set({
      selection: null,
      peekRevision: null,
      editing: {
        ...ref,
        workId,
        draft: initial,
        ...(base?.baseRev !== undefined ? { baseRev: base.baseRev } : {}),
        ...(base?.baseHash !== undefined ? { baseHash: base.baseHash } : {}),
      },
    })
    if (ref.kind === 'snippet') signalEditing(workId, ref.id)
  },

  updateDraft: (workId, blockId, text) => {
    const editing = get().editing
    if (editing !== null && editing.workId === workId && editing.id === blockId) {
      set({ editing: { ...editing, draft: text } })
    }
    mirrorCrashCopy(workId, blockId, text)
  },

  endEdit: () => {
    const editing = get().editing
    if (!editing) return
    clearCrashCopy(editing.workId, editing.id) // also cancels a pending trailing mirror
    set({ editing: null })
    if (editing.kind === 'snippet') signalEditing(editing.workId, null)
  },

  setPeekRevision: (peekRevision) => set({ peekRevision }),

  setFollowBottom: (followBottom) => set({ followBottom }),

  clearRefsFor: (id) => {
    const { selection, editing, peekRevision } = get()
    const patch: Partial<Pick<DocUiState, 'selection' | 'editing' | 'peekRevision'>> = {}
    if (selection?.id === id) patch.selection = null
    if (editing?.id === id) {
      // Same teardown as endEdit: the edited entity is gone, so the crash copy must not
      // offer a "restore" into nothing and the server-side editing signal must clear
      // (a deleted snippet could otherwise pin consolidation until the SSE drop).
      patch.editing = null
      clearCrashCopy(editing.workId, editing.id) // also cancels a pending trailing mirror
      if (editing.kind === 'snippet') signalEditing(editing.workId, null)
    }
    if (peekRevision?.snippetId === id) patch.peekRevision = null
    if (Object.keys(patch).length > 0) set(patch)
  },
}))
