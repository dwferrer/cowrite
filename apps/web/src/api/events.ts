import { api, type SectionRow, type SnippetDto, WORK_EVENT_TYPES, WorkEvent } from '@cowrite/shared'
import { type QueryClient, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { create } from 'zustand'
import { useDocUiStore } from '../state/docUiStore.js'
import { signalEditing } from './editingSignal.js'
import { byOrderKey, qk } from './queries.js'

/**
 * SSE subscription + the WorkEvent → cache reducer (docs/04-frontend.md §4.3).
 *
 * Every storage-originated event row is implemented; the `task.*` family is routed to
 * explicit no-ops until Stage 3 fills the task store (the union is the contract, not the
 * emitter). `applyWorkEvent` is a pure-ish function over (QueryClient, stores) so each row is
 * unit-testable without a connection.
 */

// ---------------------------------------------------------------------------
// Connection/banner state the shell renders (readonly banner, offline banner,
// situation dirty/conflict chip). Session-scoped, reset when the work view unmounts.
// ---------------------------------------------------------------------------

export interface SituationAcked {
  /** Last server-acknowledged text + hash — the base every save runs against. */
  text: string
  hash: string
}

export interface WorkStatusState {
  connected: boolean
  /** Non-null once a readonly.changed event arrived; drives the banner (04 §14). */
  readonlyBanner: { readonly: boolean; reason: string } | null
  /** Set by the situation pane while its textarea has unsaved edits. */
  situationDirty: boolean
  /** A foreign situation.changed arrived while dirty — "changed on disk" chip (04 §9.1). */
  situationChangedOnDisk: { text: string; updatedAt: string; hash: string } | null
  /**
   * The situation save controller's acked state. It lives HERE — next to where the SSE
   * reducer updates the cache — so self-echo detection and the dirty-guard read one
   * source of truth instead of render-scope query data (no stale closures, and a
   * hello/focus refetch can never rebase the hash under a dirty draft).
   */
  situationAcked: SituationAcked | null
  /** Text of the PUT currently in flight, if any — its echo must not raise the chip. */
  situationInFlightText: string | null
  /** Last-processed SSE cursor; `hello` compares against it to skip needless refetches. */
  eventCursor: { streamId: string; seq: number } | null
  setConnected(connected: boolean): void
  setReadonlyBanner(banner: { readonly: boolean; reason: string } | null): void
  setSituationDirty(dirty: boolean): void
  setSituationChangedOnDisk(change: { text: string; updatedAt: string; hash: string } | null): void
  setSituationAcked(acked: SituationAcked | null): void
  setSituationInFlightText(text: string | null): void
  setEventCursor(cursor: { streamId: string; seq: number } | null): void
  reset(): void
}

const initialStatus = {
  connected: false,
  readonlyBanner: null,
  situationDirty: false,
  situationChangedOnDisk: null,
  situationAcked: null,
  situationInFlightText: null,
  eventCursor: null,
}

export const useWorkStatusStore = create<WorkStatusState>()((set) => ({
  ...initialStatus,
  setConnected: (connected) => set({ connected }),
  setReadonlyBanner: (readonlyBanner) => set({ readonlyBanner }),
  setSituationDirty: (situationDirty) => set({ situationDirty }),
  setSituationChangedOnDisk: (situationChangedOnDisk) => set({ situationChangedOnDisk }),
  setSituationAcked: (situationAcked) => set({ situationAcked }),
  setSituationInFlightText: (situationInFlightText) => set({ situationInFlightText }),
  setEventCursor: (eventCursor) => set({ eventCursor }),
  reset: () => set(initialStatus),
}))

// ---------------------------------------------------------------------------
// The reducer — one row per WorkEvent variant (04 §4.3).
// ---------------------------------------------------------------------------

/** Work-scoped invalidation minus sectionText — leaf prose is immutable behind its
 *  contentHash and refetches only on a section.changed hash change. */
function invalidateWorkQueries(qc: QueryClient, workId: string): void {
  void qc.invalidateQueries({
    queryKey: qk.work(workId),
    predicate: (query) => query.queryKey[2] !== 'sectionText',
  })
}

/** New-stream invalidation, deferred past any in-flight mutations: invalidating while an
 *  optimistic delete's DELETE is still on the wire would resurrect the removed row. */
function invalidateOnNewStream(qc: QueryClient, workId: string): void {
  if (qc.isMutating() === 0) {
    invalidateWorkQueries(qc, workId)
    return
  }
  const unsubscribe = qc.getMutationCache().subscribe(() => {
    if (qc.isMutating() === 0) {
      unsubscribe()
      invalidateWorkQueries(qc, workId)
    }
  })
}

export function applyWorkEvent(qc: QueryClient, workId: string, event: WorkEvent): void {
  switch (event.type) {
    case 'snippet.created': {
      // insert by orderKey; skip if the id exists (SSE echo of our own POST)
      qc.setQueryData<SnippetDto[]>(qk.snippets(workId), (old) => {
        if (!old) return old
        if (old.some((s) => s.id === event.snippet.id)) return old
        return [...old, event.snippet].sort(byOrderKey)
      })
      break
    }

    case 'snippet.revised': {
      // patch the item; skip if (id, rev) already present (echo of our own PATCH)
      qc.setQueryData<SnippetDto[]>(qk.snippets(workId), (old) => {
        if (!old) return old
        const existing = old.find((s) => s.id === event.snippet.id)
        if (existing && existing.rev >= event.snippet.rev) return old
        if (!existing) return [...old, event.snippet].sort(byOrderKey)
        return old.map((s) => (s.id === event.snippet.id ? event.snippet : s))
      })
      void qc.invalidateQueries({ queryKey: qk.revisions(workId, event.snippet.id) })
      break
    }

    case 'snippet.deleted': {
      qc.setQueryData<SnippetDto[]>(qk.snippets(workId), (old) =>
        old?.filter((s) => s.id !== event.id),
      )
      // never leave dangling selection/edit/peek refs (04 §7.2)
      useDocUiStore.getState().clearRefsFor(event.id)
      break
    }

    case 'section.changed': {
      const previous = qc
        .getQueryData<SectionRow[]>(qk.sections(workId))
        ?.find((row) => row.id === event.section.id)
      qc.setQueryData<SectionRow[]>(qk.sections(workId), (old) => {
        if (!old) return old
        if (!old.some((row) => row.id === event.section.id)) {
          return [...old, event.section].sort(byOrderKey)
        }
        return old.map((row) => (row.id === event.section.id ? event.section : row))
      })
      if (!previous || previous.contentHash !== event.section.contentHash) {
        void qc.invalidateQueries({ queryKey: qk.sectionText(workId, event.section.id) })
      }
      break
    }

    case 'sections.restructured': {
      // split/merge/reorder ⇒ deliberate refetch. Stale-key GC of fold pins/drafts runs
      // after the refetch resolves (04 §4.1) — wired with the fold ladder in Stage 4.
      void qc.invalidateQueries({ queryKey: qk.sections(workId) })
      break
    }

    case 'consolidation.applied': {
      // Stage 4 adds the undo toast wired to the undo route; the cache effects apply now.
      void qc.invalidateQueries({ queryKey: qk.sections(workId) })
      void qc.invalidateQueries({ queryKey: qk.snippets(workId) })
      for (const id of event.sectionIds) useDocUiStore.getState().clearRefsFor(id)
      break
    }

    case 'consolidation.undone': {
      void qc.invalidateQueries({ queryKey: qk.sections(workId) })
      void qc.invalidateQueries({ queryKey: qk.snippets(workId) })
      break
    }

    case 'enrichment.updated': {
      // fresh row inline — patch it (illustration version bump busts the image URL)
      qc.setQueryData<SectionRow[]>(qk.sections(workId), (old) =>
        old?.map((row) => (row.id === event.sectionId ? event.section : row)),
      )
      break
    }

    case 'world.changed': {
      // full entries live in the one list query; refetch it (bumps worldVersion downstream)
      void qc.invalidateQueries({ queryKey: qk.world(workId) })
      break
    }

    case 'situation.changed': {
      const status = useWorkStatusStore.getState()
      const acked = status.situationAcked
      // self-echo: the event carries the hash we last acked (or the save in flight) —
      // our own PUT round-tripping back must neither chip nor rebase anything
      if (acked !== null && event.hash === acked.hash) break
      if (status.situationInFlightText !== null && event.text === status.situationInFlightText) {
        break
      }
      if (status.situationDirty) {
        // never clobber unsaved edits — surface the "changed on disk" chip (04 §9.1)
        status.setSituationChangedOnDisk({
          text: event.text,
          updatedAt: event.updatedAt,
          hash: event.hash,
        })
      } else {
        // clean: adopt silently — the event carries the fresh hash, no refetch needed
        qc.setQueryData(
          qk.situation(workId),
          (old: { text: string; updatedAt: string; hash: string } | undefined) =>
            old ? { ...old, text: event.text, updatedAt: event.updatedAt, hash: event.hash } : old,
        )
        status.setSituationAcked({ text: event.text, hash: event.hash })
      }
      break
    }

    case 'readonly.changed': {
      useWorkStatusStore
        .getState()
        .setReadonlyBanner({ readonly: event.readonly, reason: event.reason })
      qc.setQueryData(qk.work(workId), (old: { readonly: boolean } | undefined) =>
        old ? { ...old, readonly: event.readonly } : old,
      )
      break
    }

    case 'hello': {
      // `hello` opens EVERY connection. Only a genuinely new stream (server restart /
      // work re-open — the replay ring is gone) warrants invalidation; the same stream
      // continuing or a clean resume already replayed anything missed (03 §8.3).
      const status = useWorkStatusStore.getState()
      const last = status.eventCursor
      if (last !== null && last.streamId !== event.streamId) {
        invalidateOnNewStream(qc, workId)
      }
      status.setEventCursor({ streamId: event.streamId, seq: event.seq })
      break
    }

    case 'resync': {
      // the server could not replay the gap: the broad invalidate-everything sweep
      void qc.invalidateQueries({ queryKey: qk.work(workId) })
      break
    }

    // ---- task.* family: Stage 3 (agents) fills the task store; explicit no-ops now ----
    case 'task.queued':
    case 'task.started':
    case 'task.stage':
    case 'task.tool':
    case 'task.delta':
    case 'task.snapshot':
    case 'task.retrying':
    case 'task.progress':
    case 'task.artifact':
    case 'task.usage':
    case 'task.completed':
    case 'task.cancelled':
    case 'task.failed':
      break

    default: {
      // exhaustiveness guard — a new union member fails compile here
      const _exhaustive: never = event
      void _exhaustive
    }
  }
}

// ---------------------------------------------------------------------------
// The subscription hook.
// ---------------------------------------------------------------------------

const BACKOFF_MIN_MS = 500
const BACKOFF_MAX_MS = 8_000

export interface UseWorkEventsOptions {
  /** Injectable for tests — jsdom has no EventSource. */
  eventSourceFactory?: (url: string) => EventSource
}

/** `"<streamId>:<seq>"` → cursor parts, or null when unparseable. */
function parseCursor(id: string): { streamId: string; seq: number } | null {
  const sep = id.lastIndexOf(':')
  if (sep <= 0) return null
  const seq = Number.parseInt(id.slice(sep + 1), 10)
  if (!Number.isInteger(seq) || seq < 0) return null
  return { streamId: id.slice(0, sep), seq }
}

/**
 * One EventSource per open work (opened by WorkView). Native EventSource reconnects carry
 * `Last-Event-ID` automatically; when the browser gives up (readyState CLOSED) we recreate
 * the connection with exponential backoff 0.5 s → 8 s, passing the last-processed cursor
 * as `?lastEventId=` (a fresh EventSource cannot set the header) so the server can replay
 * instead of forcing a full resync (03 §8.3).
 */
export function useWorkEvents(workId: string, options: UseWorkEventsOptions = {}): void {
  const qc = useQueryClient()
  const factory = options.eventSourceFactory

  useEffect(() => {
    if (!workId) return
    let source: EventSource | null = null
    let disposed = false
    let attempt = 0
    let retryTimer: ReturnType<typeof setTimeout> | undefined

    const handleEvent = (type: string, raw: string, lastEventId: string | undefined) => {
      let payload: unknown
      try {
        payload = JSON.parse(raw)
      } catch {
        return
      }
      const parsed = WorkEvent.safeParse(
        typeof payload === 'object' && payload !== null ? { ...payload, type } : payload,
      )
      if (!parsed.success) {
        if (import.meta.env.DEV) {
          console.error(`SSE event '${type}' failed the shared contract`, parsed.error)
        }
        return
      }
      applyWorkEvent(qc, workId, parsed.data)
      // track the resume cursor AFTER applying, so a crash mid-apply replays the event
      if (lastEventId !== undefined && lastEventId !== '') {
        const cursor = parseCursor(lastEventId)
        if (cursor !== null) useWorkStatusStore.getState().setEventCursor(cursor)
      }
    }

    const connect = (isReconnect: boolean) => {
      if (disposed) return
      let url = api.events.path(workId)
      if (isReconnect) {
        const cursor = useWorkStatusStore.getState().eventCursor
        if (cursor !== null) {
          url += `?lastEventId=${encodeURIComponent(`${cursor.streamId}:${cursor.seq}`)}`
        }
      }
      source = factory ? factory(url) : new EventSource(url)
      source.onopen = () => {
        attempt = 0
        useWorkStatusStore.getState().setConnected(true)
        // Re-assert the editing signal on EVERY open (incl. reconnects): the server
        // clears it when the subscriber count hits zero, so a dropped connection would
        // otherwise leave an open editor unprotected against consolidation (04 §7.1).
        const editing = useDocUiStore.getState().editing
        if (editing !== null && editing.kind === 'snippet' && editing.workId === workId) {
          signalEditing(workId, editing.id)
        }
      }
      source.onerror = () => {
        useWorkStatusStore.getState().setConnected(false)
        // CONNECTING ⇒ the browser is retrying natively (with Last-Event-ID); leave it.
        if (source?.readyState === EventSource.CLOSED) {
          source.close()
          source = null
          const delay = Math.min(BACKOFF_MIN_MS * 2 ** attempt, BACKOFF_MAX_MS)
          attempt += 1
          retryTimer = setTimeout(() => connect(true), delay)
        }
      }
      for (const type of WORK_EVENT_TYPES) {
        source.addEventListener(type, (evt) => {
          const message = evt as MessageEvent<string>
          handleEvent(type, message.data, message.lastEventId)
        })
      }
    }

    connect(false)

    return () => {
      disposed = true
      if (retryTimer !== undefined) clearTimeout(retryTimer)
      source?.close()
      useWorkStatusStore.getState().reset()
    }
  }, [workId, qc, factory])
}
