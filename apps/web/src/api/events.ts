import { api, type SectionRow, type SnippetDto, WORK_EVENT_TYPES, WorkEvent } from '@cowrite/shared'
import { type QueryClient, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { create } from 'zustand'
import { gcCrashCopies, useDocUiStore } from '../state/docUiStore.js'
import { usePanelStore } from '../state/panelStore.js'
import { useTaskStore } from '../state/taskStore.js'
import { dismissToastByKey, pushToast } from '../ui/Toast.js'
import { ApiError, apiCall } from './client.js'
import { signalEditing } from './editingSignal.js'
import { byOrderKey, qk } from './queries.js'

/**
 * SSE subscription + the WorkEvent → cache reducer (docs/04-frontend.md §4.3).
 *
 * Every storage-originated event row patches the query cache; the `task.*` family routes
 * into the task store (04 §4.4) — `task.started` by lane, everything later by taskId.
 * `applyWorkEvent` is a pure-ish function over (QueryClient, stores) so each row is
 * unit-testable without a connection.
 */

// ---------------------------------------------------------------------------
// Delta batching (04 §8.3): `task.delta` events accumulate here; a 33 ms rAF-aligned
// flush writes them to the store in one commit (~30 fps), keeping React off the token
// firehose. Terminal events flush synchronously so no tail text is lost.
// ---------------------------------------------------------------------------

const DELTA_FLUSH_MS = 33

let pendingDeltas = new Map<string /*taskId*/, Array<{ target: string; text: string }>>()
let flushTimer: ReturnType<typeof setTimeout> | null = null

/** Flush all pending task deltas to the store immediately. Exported for tests. */
export function flushTaskDeltas(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  if (pendingDeltas.size === 0) return
  const batch = pendingDeltas
  pendingDeltas = new Map()
  for (const [taskId, entries] of batch) {
    useTaskStore.getState().appendDeltas(taskId, entries)
  }
}

function scheduleDeltaFlush(): void {
  if (flushTimer !== null) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    // align the store commit with a paint frame when the environment has one
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => flushTaskDeltas())
    else flushTaskDeltas()
  }, DELTA_FLUSH_MS)
}

/** Drop buffered deltas for one task (retry/snapshot reset) or all (work switch). */
export function dropPendingDeltas(taskId?: string): void {
  if (taskId === undefined) {
    pendingDeltas = new Map()
    if (flushTimer !== null) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    return
  }
  pendingDeltas.delete(taskId)
}

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

/**
 * §4.1 stale-key GC, run after the refetch a restructure triggers: any fold pin, docUi
 * ref, or crash-copy draft whose entity id no longer resolves is dropped. Drafts with
 * content surface once as a "recovered text" toast with a copy action before being lost.
 */
function gcStaleKeys(qc: QueryClient, workId: string): void {
  const sectionRows = qc.getQueryData<SectionRow[]>(qk.sections(workId))
  const snippetRows = qc.getQueryData<SnippetDto[]>(qk.snippets(workId))
  // Never GC against an unloaded cache — an empty "live" set would drop every valid
  // pin/ref/draft on a work whose queries have not resolved yet.
  if (sectionRows === undefined || snippetRows === undefined) return
  const liveSectionIds = new Set(sectionRows.map((row) => row.id))
  const liveIds = new Set([...liveSectionIds, ...snippetRows.map((row) => row.id)])

  usePanelStore.getState().pruneFoldOverrides(workId, liveSectionIds)

  const { selection, editing, peekRevision } = useDocUiStore.getState()
  for (const id of [selection?.id, editing?.id, peekRevision?.snippetId]) {
    if (id !== undefined && !liveIds.has(id)) useDocUiStore.getState().clearRefsFor(id)
  }

  for (const { text } of gcCrashCopies(workId, liveIds)) {
    if (text.trim().length === 0) continue
    pushToast('Recovered unsaved edit from a passage that was consolidated away', {
      ttlMs: 30_000,
      action: {
        label: 'Copy',
        onClick: () => void navigator.clipboard?.writeText(text),
      },
    })
  }
}

/**
 * The restructure refetch (04 §4.3): consolidation emits NO snippet.* events by contract —
 * the frontier list is refetched wholesale here (03 §3.2), which is what makes the
 * frontier visibly shrink live. GC runs after both refetches resolve.
 */
function refetchRestructured(qc: QueryClient, workId: string): void {
  void Promise.all([
    qc.invalidateQueries({ queryKey: qk.sections(workId) }),
    qc.invalidateQueries({ queryKey: qk.snippets(workId) }),
  ]).then(() => gcStaleKeys(qc, workId))
}

/** The undo-toast action (04 §4.3): POST the undo route; cache repair rides the
 *  `consolidation.undone` event. An expired grace surfaces the §14 conflict message. */
async function undoConsolidation(workId: string, undoToken: string): Promise<void> {
  try {
    await apiCall('undoConsolidation', [workId, undoToken])
  } catch (err) {
    if (err instanceof ApiError && err.code === 'conflict') {
      pushToast('Undo window has passed', { tone: 'error' })
    } else {
      pushToast(`Undo failed — ${err instanceof Error ? err.message : String(err)}`, {
        tone: 'error',
      })
    }
  }
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
      // split/merge/reorder ⇒ deliberate refetch of BOTH lists: consolidation emits no
      // snippet.* events, so the shrunken frontier arrives via this refetch (03 §3.2).
      // This row OWNS the restructure refetch — the consolidation.applied/undone rows
      // it always pairs with (02 §6.4 emits both) never refetch again. Stale-key GC of
      // fold pins/refs/drafts runs after the refetch resolves (04 §4.1 sequencing).
      refetchRestructured(qc, workId)
      break
    }

    case 'consolidation.applied': {
      // Toast + GC only: the paired sections.restructured row (which precedes this one
      // on the wire) owns the refetch, and its §4.1-sequenced GC runs after that
      // refetch resolves. The direct GC here covers the synthetic mid-grace attach
      // frame (03 §8.3), which arrives alone against an already-fresh cache. Chapter
      // ordinal for the toast: new sections append after the leaves already in cache
      // (this row only names the toast).
      const cached = qc.getQueryData<SectionRow[]>(qk.sections(workId))
      const firstOrdinal = (cached?.filter((row) => row.isLeaf).length ?? 0) + 1
      gcStaleKeys(qc, workId)

      const count = event.sectionIds.length
      const label =
        count === 1
          ? `Chapter ${firstOrdinal}`
          : `Chapters ${firstOrdinal}–${firstOrdinal + count - 1}`
      const title = event.title !== '' ? ` "${event.title}"` : ''
      // The toast lives exactly as long as the undo grace: the TTL derives from the
      // event's undoDeadline, so a mid-grace reload (the synthetic attach frame
      // re-emits this row) shows the TRUE remaining window, never a fresh one.
      const remainingMs = Date.parse(event.undoDeadline) - Date.now()
      if (remainingMs <= 0) break // already expired: nothing to offer
      pushToast(`${label}${title} frozen`, {
        ttlMs: remainingMs,
        key: `undo:${event.undoToken}`, // re-attach replaces, finalized dismisses
        action: {
          label: 'Undo',
          onClick: () => void undoConsolidation(workId, event.undoToken),
        },
      })
      break
    }

    case 'consolidation.undone': {
      // GC only: the paired sections.restructured row (which follows this one on the
      // wire, 02 §6.4) owns the one refetch + the §4.1 post-refetch GC for the pair.
      gcStaleKeys(qc, workId)
      break
    }

    case 'consolidation.finalized': {
      // The grace window is over (expiry, superseded by a new apply, or work close):
      // the matching undo toast must not keep offering a dead token.
      dismissToastByKey(`undo:${event.opId}`)
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

    // ---- task.* family (04 §4.3, §4.4): started routes by lane, the rest by taskId ----
    case 'task.queued': {
      useTaskStore.getState().queued(event.task, event.position)
      break
    }

    case 'task.started': {
      useTaskStore.getState().started(event.task, event.lane, event.target)
      break
    }

    case 'task.stage': {
      useTaskStore.getState().setStage(event.taskId, event.stage)
      break
    }

    case 'task.tool': {
      useTaskStore.getState().addToolNote(event.taskId, event.label)
      break
    }

    case 'task.delta': {
      // accumulate; the 33 ms flush commits to the store (~30 fps, 04 §8.3). Targeted
      // (quick-edit) deltas buffer invisibly — only the frontier target renders live.
      const entries = pendingDeltas.get(event.taskId) ?? []
      entries.push({ target: event.target, text: event.text })
      pendingDeltas.set(event.taskId, entries)
      scheduleDeltaFlush()
      break
    }

    case 'task.snapshot': {
      // reconnect catch-up: the snapshot replaces the buffer wholesale, so anything
      // still pending for this task predates it and must not re-append
      dropPendingDeltas(event.taskId)
      useTaskStore.getState().snapshotBuffer(event.taskId, event.target, event.text)
      break
    }

    case 'task.retrying': {
      dropPendingDeltas(event.taskId)
      useTaskStore.getState().retrying(event.taskId, event.attempt, event.reason)
      break
    }

    case 'task.progress': {
      useTaskStore.getState().progress(event.taskId, {
        phase: event.phase,
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        pct: event.pct,
      })
      break
    }

    case 'task.artifact': {
      // conflict-state artifacts arm the apply/discard offer surfaced at completion
      // (04 §8.4); committed artifacts ride their own domain events — nothing to patch
      useTaskStore.getState().artifact(event.taskId, event.artifact)
      break
    }

    case 'task.usage': {
      useTaskStore.getState().setUsage(event.taskId, {
        promptTokens: event.promptTokens,
        completionTokens: event.completionTokens,
        estimated: event.estimated,
        costUsd: event.costUsd,
      })
      break
    }

    case 'task.state': {
      // Attach-frame hydration (03 §8.3): the synthetic state of the current interactive
      // task — or a terminal one still offering an unresolved proposal — on EVERY
      // attach. The web hydrates purely from the stream: no fetch-then-subscribe gap.
      if (event.task.status === 'running' || event.task.status === 'queued') {
        useTaskStore.getState().stateFrame(event.task, event.lane, event.target)
      } else {
        dropPendingDeltas(event.task.id)
        useTaskStore.getState().stateFrame(event.task, event.lane, event.target)
      }
      break
    }

    case 'spend.warning': {
      pushToast(
        `Model spend this session crossed $${event.thresholdUsd.toFixed(2)} ` +
          `(now $${event.spentUsd.toFixed(2)})`,
        { tone: 'error' },
      )
      break
    }

    case 'task.completed': {
      flushTaskDeltas() // a conflict proposal reads the buffered rewrite — no tail loss
      useTaskStore.getState().completed(event.taskId)
      break
    }

    case 'task.cancelled': {
      flushTaskDeltas()
      const wasInteractive = useTaskStore.getState().interactive?.taskId === event.taskId
      useTaskStore.getState().cancelled(event.taskId, event.partialText)
      if (wasInteractive && event.partialText !== null) {
        pushToast('Generation cancelled — partial text kept for review')
      }
      break
    }

    case 'task.failed': {
      flushTaskDeltas()
      const wasInteractive = useTaskStore.getState().interactive?.taskId === event.taskId
      useTaskStore.getState().failed(event.taskId, {
        code: event.code,
        message: event.message,
        partialText: event.partialText,
        retryable: event.retryable,
      })
      // interactive failures toast loudly; background ones stay quiet (04 §14)
      if (wasInteractive) {
        pushToast(`Generation failed — ${event.message}${event.retryable ? ' (retryable)' : ''}`, {
          tone: 'error',
        })
      }
      break
    }

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

    // No pre-fetch: the bus's attach-time `task.state` frame seeds the interactive slot
    // (or a pending keep-partial offer) before any snapshot/delta arrives (03 §8.3), so
    // the stream alone hydrates and the fetch-to-subscribe gap does not exist.
    connect(false)

    return () => {
      disposed = true
      if (retryTimer !== undefined) clearTimeout(retryTimer)
      source?.close()
      useWorkStatusStore.getState().reset()
      // task display state is per work — never leak a stream across a work switch (04 §4.4)
      dropPendingDeltas()
      useTaskStore.getState().reset()
    }
  }, [workId, qc, factory])
}
