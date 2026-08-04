import type { SectionRow, SnippetDto, Task, TaskSpec } from '@cowrite/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useDocUiStore } from '../state/docUiStore.js'
import { usePanelStore } from '../state/panelStore.js'
import { useTaskStore } from '../state/taskStore.js'
import { useToastStore } from '../ui/Toast.js'
import {
  applyWorkEvent,
  dropPendingDeltas,
  flushTaskDeltas,
  useWorkEvents,
  useWorkStatusStore,
} from './events.js'
import { qk } from './queries.js'

vi.mock('./editingSignal.js', () => ({ signalEditing: vi.fn() }))

import { signalEditing } from './editingSignal.js'

const W = '01ARZ3NDEKTSV4RRFFQ69G5FA0'
const S1 = '01ARZ3NDEKTSV4RRFFQ69G5FA1'
const S2 = '01ARZ3NDEKTSV4RRFFQ69G5FA2'
const S3 = '01ARZ3NDEKTSV4RRFFQ69G5FA3'
const NOW = '2026-08-02T00:00:00.000Z'
const HASH_A = 'xxh64:0123456789abcdef'
const HASH_B = 'xxh64:fedcba9876543210'

function snippet(id: string, orderKey: string, rev = 1, text = 'text'): SnippetDto {
  return {
    id,
    orderKey,
    text,
    rev,
    authorship: 'user',
    originRunId: null,
    updatedAt: NOW,
    revisionCount: rev,
  }
}

function section(id: string, over: Partial<SectionRow> = {}): SectionRow {
  return {
    id,
    parentId: null,
    kind: 'chapter',
    orderKey: 'a0',
    title: 'Chapter',
    titleSource: 'agent',
    isLeaf: true,
    wordCount: 100,
    contentHash: HASH_A,
    shortSummary: null,
    longSummary: null,
    illustration: null,
    stale: { short: false, long: false, illustration: false },
    ...over,
  }
}

function makeClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

/** A live undo grace deadline (5 min out) for consolidation.applied rows. */
function futureDeadline(): string {
  return new Date(Date.now() + 300_000).toISOString()
}

beforeEach(() => {
  useWorkStatusStore.getState().reset()
  useDocUiStore.setState({ selection: null, editing: null, peekRevision: null, followBottom: true })
  useTaskStore.getState().reset()
  usePanelStore.setState({ byWork: {} })
  useToastStore.setState({ toasts: [] })
  localStorage.clear()
  dropPendingDeltas()
  vi.mocked(signalEditing).mockClear()
})

describe('applyWorkEvent — storage-originated rows (04 §4.3)', () => {
  it('snippet.created inserts by orderKey and dedupes the SSE echo', () => {
    const qc = makeClient()
    qc.setQueryData(qk.snippets(W), [snippet(S1, 'a0'), snippet(S3, 'c0')])

    applyWorkEvent(qc, W, { type: 'snippet.created', snippet: snippet(S2, 'b0') })
    expect(qc.getQueryData<SnippetDto[]>(qk.snippets(W))?.map((s) => s.id)).toEqual([S1, S2, S3])

    // echo of our own POST: same id again — unchanged
    applyWorkEvent(qc, W, { type: 'snippet.created', snippet: snippet(S2, 'b0') })
    expect(qc.getQueryData<SnippetDto[]>(qk.snippets(W))).toHaveLength(3)
  })

  it('snippet.revised patches the item, skips stale echoes, drops the revisions query', () => {
    const qc = makeClient()
    const invalidate = vi.spyOn(qc, 'invalidateQueries')
    qc.setQueryData(qk.snippets(W), [snippet(S1, 'a0', 2, 'old')])

    applyWorkEvent(qc, W, { type: 'snippet.revised', snippet: snippet(S1, 'a0', 3, 'new') })
    expect(qc.getQueryData<SnippetDto[]>(qk.snippets(W))?.[0]?.text).toBe('new')
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.revisions(W, S1) })

    // echo with the same rev — no downgrade
    applyWorkEvent(qc, W, { type: 'snippet.revised', snippet: snippet(S1, 'a0', 3, 'other') })
    expect(qc.getQueryData<SnippetDto[]>(qk.snippets(W))?.[0]?.text).toBe('new')
  })

  it('snippet.deleted removes the item and clears dangling docUi refs', () => {
    const qc = makeClient()
    qc.setQueryData(qk.snippets(W), [snippet(S1, 'a0'), snippet(S2, 'b0')])
    useDocUiStore.setState({
      selection: { kind: 'snippet', id: S1 },
      peekRevision: { snippetId: S1, rev: 1 },
    })

    applyWorkEvent(qc, W, { type: 'snippet.deleted', id: S1 })

    expect(qc.getQueryData<SnippetDto[]>(qk.snippets(W))?.map((s) => s.id)).toEqual([S2])
    expect(useDocUiStore.getState().selection).toBeNull()
    expect(useDocUiStore.getState().peekRevision).toBeNull()
  })

  it('section.changed patches the row and invalidates sectionText only on hash change', () => {
    const qc = makeClient()
    const invalidate = vi.spyOn(qc, 'invalidateQueries')
    qc.setQueryData(qk.sections(W), [section(S1)])

    // same hash — no content invalidation
    applyWorkEvent(qc, W, {
      type: 'section.changed',
      section: section(S1, { title: 'Renamed' }),
    })
    expect(qc.getQueryData<SectionRow[]>(qk.sections(W))?.[0]?.title).toBe('Renamed')
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: qk.sectionText(W, S1) })

    // hash change — content invalidated
    applyWorkEvent(qc, W, {
      type: 'section.changed',
      section: section(S1, { contentHash: HASH_B }),
    })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.sectionText(W, S1) })
  })

  it('sections.restructured invalidates the tree AND the snippet list (03 §3.2)', () => {
    const qc = makeClient()
    const invalidate = vi.spyOn(qc, 'invalidateQueries')
    applyWorkEvent(qc, W, { type: 'sections.restructured' })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.sections(W) })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.snippets(W) })
  })

  it('sections.restructured GCs stale fold pins and docUi refs after the refetch (§4.1)', async () => {
    const qc = makeClient()
    // post-refetch cache: S1 lives on; S2 (section) and S3 (snippet) are gone
    qc.setQueryData(qk.sections(W), [section(S1)])
    qc.setQueryData(qk.snippets(W), [])
    usePanelStore.setState({ byWork: {} })
    usePanelStore.getState().setFold(W, S1, 'full')
    usePanelStore.getState().setFold(W, S2, 'name')
    useDocUiStore.setState({
      selection: { kind: 'snippet', id: S3 },
      peekRevision: { snippetId: S3, rev: 1 },
    })

    applyWorkEvent(qc, W, { type: 'sections.restructured' })

    await waitFor(() => {
      expect(usePanelStore.getState().byWork[W]?.foldOverrides).toEqual({ [S1]: 'full' })
      expect(useDocUiStore.getState().selection).toBeNull()
      expect(useDocUiStore.getState().peekRevision).toBeNull()
    })
  })

  it('sections.restructured never GCs against an unloaded cache', async () => {
    const qc = makeClient() // neither sections nor snippets ever loaded
    usePanelStore.setState({ byWork: {} })
    usePanelStore.getState().setFold(W, S1, 'full')

    applyWorkEvent(qc, W, { type: 'sections.restructured' })
    await Promise.resolve() // let the refetch promise settle

    expect(usePanelStore.getState().byWork[W]?.foldOverrides).toEqual({ [S1]: 'full' })
  })

  it('consolidation.applied toasts the undo offer; the paired restructured row refetches + GCs', async () => {
    const qc = makeClient()
    const invalidate = vi.spyOn(qc, 'invalidateQueries')
    // pre-consolidation cache: two frozen chapters + the snippet being consumed
    qc.setQueryData(qk.sections(W), [
      section(S1, { orderKey: 'a0' }),
      section(S2, { orderKey: 'a1' }),
    ])
    qc.setQueryData(qk.snippets(W), [snippet(S3, 'b0')])
    useDocUiStore.setState({ selection: { kind: 'snippet', id: S3 } })

    // The wire pair (02 §6.4): sections.restructured first, consolidation.applied second.
    applyWorkEvent(qc, W, { type: 'sections.restructured' })
    applyWorkEvent(qc, W, {
      type: 'consolidation.applied',
      sectionIds: ['01ARZ3NDEKTSV4RRFFQ69G5FB1'],
      title: 'The Ferry',
      undoToken: 'tok',
      undoDeadline: futureDeadline(),
    })

    // ONE refetch for the pair — the restructured row owns it; applied adds none.
    expect(invalidate).toHaveBeenCalledTimes(2)
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.sections(W) })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.snippets(W) })

    // toast: ordinal = leaves in cache (2) + 1, boundary title quoted, Undo action wired
    const toast = useToastStore.getState().toasts[0]
    expect(toast?.message).toBe('Chapter 3 "The Ferry" frozen')
    expect(toast?.action?.label).toBe('Undo')

    // post-refetch GC (§4.1 sequencing rides the restructured row): the cache still
    // holds the consumed snippet in this seeded test, so simulate the refetch result
    // before the microtask GC runs
    qc.setQueryData(qk.snippets(W), [])
    await waitFor(() => {
      expect(useDocUiStore.getState().selection).toBeNull()
    })
  })

  it('consolidation.applied names a multi-chapter freeze as a range', () => {
    const qc = makeClient()
    qc.setQueryData(qk.sections(W), [])
    qc.setQueryData(qk.snippets(W), [])

    applyWorkEvent(qc, W, {
      type: 'consolidation.applied',
      sectionIds: [S1, S2, S3],
      title: 'One',
      undoToken: 'tok',
      undoDeadline: futureDeadline(),
    })

    expect(useToastStore.getState().toasts[0]?.message).toBe('Chapters 1–3 "One" frozen')
  })

  it('the undo toast TTL derives from undoDeadline; an expired deadline offers nothing', () => {
    const qc = makeClient()
    qc.setQueryData(qk.sections(W), [])
    qc.setQueryData(qk.snippets(W), [])

    // already expired (a stale attach frame): no toast at all
    applyWorkEvent(qc, W, {
      type: 'consolidation.applied',
      sectionIds: [S1],
      title: 'Too Late',
      undoToken: 'tok-old',
      undoDeadline: new Date(Date.now() - 1_000).toISOString(),
    })
    expect(useToastStore.getState().toasts).toHaveLength(0)

    // mid-grace: the toast appears, keyed by its undo token so a re-attach replaces
    // rather than stacks (the synthetic attach frame re-emits this row on reload)
    const deadline = futureDeadline()
    applyWorkEvent(qc, W, {
      type: 'consolidation.applied',
      sectionIds: [S1],
      title: 'On Time',
      undoToken: 'tok-live',
      undoDeadline: deadline,
    })
    applyWorkEvent(qc, W, {
      type: 'consolidation.applied',
      sectionIds: [S1],
      title: 'On Time',
      undoToken: 'tok-live',
      undoDeadline: deadline,
    })
    const undoToasts = useToastStore.getState().toasts.filter((t) => t.key === 'undo:tok-live')
    expect(undoToasts).toHaveLength(1)
  })

  it('consolidation.finalized dismisses the matching undo toast', () => {
    const qc = makeClient()
    qc.setQueryData(qk.sections(W), [])
    qc.setQueryData(qk.snippets(W), [])
    applyWorkEvent(qc, W, {
      type: 'consolidation.applied',
      sectionIds: [S1],
      title: 'Superseded',
      undoToken: 'tok-a',
      undoDeadline: futureDeadline(),
    })
    applyWorkEvent(qc, W, {
      type: 'consolidation.applied',
      sectionIds: [S2],
      title: 'Fresh',
      undoToken: 'tok-b',
      undoDeadline: futureDeadline(),
    })
    expect(useToastStore.getState().toasts).toHaveLength(2)

    // grace expiry / early-finalize / close all emit finalized for the dead op
    applyWorkEvent(qc, W, { type: 'consolidation.finalized', opId: 'tok-a' })
    const remaining = useToastStore.getState().toasts
    expect(remaining).toHaveLength(1)
    expect(remaining[0]?.key).toBe('undo:tok-b')
  })

  it('the undo toast action POSTs the undo route and reports an expired grace', async () => {
    const qc = makeClient()
    qc.setQueryData(qk.sections(W), [])
    qc.setQueryData(qk.snippets(W), [])
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(
          JSON.stringify({ error: { code: 'conflict', message: 'undo window has passed' } }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        ),
      )
    try {
      applyWorkEvent(qc, W, {
        type: 'consolidation.applied',
        sectionIds: [S1],
        title: '',
        undoToken: 'tok-x',
        undoDeadline: futureDeadline(),
      })
      useToastStore.getState().toasts[0]?.action?.onClick()

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          `/api/works/${W}/consolidations/tok-x/undo`,
          expect.objectContaining({ method: 'POST' }),
        )
        expect(
          useToastStore.getState().toasts.some((t) => t.message === 'Undo window has passed'),
        ).toBe(true)
      })
    } finally {
      fetchMock.mockRestore()
    }
  })

  it('consolidation.undone leaves the one refetch to its paired sections.restructured', () => {
    const qc = makeClient()
    const invalidate = vi.spyOn(qc, 'invalidateQueries')
    // The wire pair (02 §6.4): consolidation.undone first, sections.restructured second.
    applyWorkEvent(qc, W, { type: 'consolidation.undone', sectionIds: [S2] })
    expect(invalidate).not.toHaveBeenCalled() // the undone row itself refetches nothing
    applyWorkEvent(qc, W, { type: 'sections.restructured' })
    expect(invalidate).toHaveBeenCalledTimes(2) // one sections + one snippets refetch
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.sections(W) })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.snippets(W) })
  })

  it('enrichment.updated patches the inlined section row', () => {
    const qc = makeClient()
    qc.setQueryData(qk.sections(W), [section(S1)])

    applyWorkEvent(qc, W, {
      type: 'enrichment.updated',
      sectionId: S1,
      kind: 'short',
      section: section(S1, { shortSummary: 'A crossing at night.' }),
    })

    expect(qc.getQueryData<SectionRow[]>(qk.sections(W))?.[0]?.shortSummary).toBe(
      'A crossing at night.',
    )
  })

  it('world.changed invalidates the world list', () => {
    const qc = makeClient()
    const invalidate = vi.spyOn(qc, 'invalidateQueries')
    applyWorkEvent(qc, W, { type: 'world.changed', entryId: S1 })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.world(W) })
  })

  it('situation.changed patches the cache (incl. hash) when the pane is clean', () => {
    const qc = makeClient()
    qc.setQueryData(qk.situation(W), { text: 'old', updatedAt: NOW, hash: HASH_A })
    useWorkStatusStore.getState().setSituationAcked({ text: 'old', hash: HASH_A })

    applyWorkEvent(qc, W, { type: 'situation.changed', text: 'new', updatedAt: NOW, hash: HASH_B })

    expect(qc.getQueryData<{ text: string; hash: string }>(qk.situation(W))).toMatchObject({
      text: 'new',
      hash: HASH_B,
    })
    expect(useWorkStatusStore.getState().situationAcked).toEqual({ text: 'new', hash: HASH_B })
    expect(useWorkStatusStore.getState().situationChangedOnDisk).toBeNull()
  })

  it('situation.changed shows the changed-on-disk chip when the pane is dirty', () => {
    const qc = makeClient()
    qc.setQueryData(qk.situation(W), { text: 'old', updatedAt: NOW, hash: HASH_A })
    useWorkStatusStore.getState().setSituationAcked({ text: 'old', hash: HASH_A })
    useWorkStatusStore.getState().setSituationDirty(true)

    applyWorkEvent(qc, W, { type: 'situation.changed', text: 'disk', updatedAt: NOW, hash: HASH_B })

    // cache untouched — never clobber unsaved edits
    expect(qc.getQueryData<{ text: string }>(qk.situation(W))?.text).toBe('old')
    expect(useWorkStatusStore.getState().situationChangedOnDisk).toEqual({
      text: 'disk',
      updatedAt: NOW,
      hash: HASH_B,
    })
  })

  it('situation.changed matching the acked hash is a self-echo: no chip, no patch', () => {
    const qc = makeClient()
    qc.setQueryData(qk.situation(W), { text: 'mine', updatedAt: NOW, hash: HASH_A })
    useWorkStatusStore.getState().setSituationAcked({ text: 'mine', hash: HASH_A })
    useWorkStatusStore.getState().setSituationDirty(true) // even while dirty

    applyWorkEvent(qc, W, { type: 'situation.changed', text: 'mine', updatedAt: NOW, hash: HASH_A })

    expect(useWorkStatusStore.getState().situationChangedOnDisk).toBeNull()
  })

  it('situation.changed matching the in-flight save text is suppressed too', () => {
    const qc = makeClient()
    useWorkStatusStore.getState().setSituationAcked({ text: 'old', hash: HASH_A })
    useWorkStatusStore.getState().setSituationDirty(true)
    useWorkStatusStore.getState().setSituationInFlightText('being saved')

    // the echo of the in-flight PUT can outrun its HTTP response
    applyWorkEvent(qc, W, {
      type: 'situation.changed',
      text: 'being saved',
      updatedAt: NOW,
      hash: HASH_B,
    })

    expect(useWorkStatusStore.getState().situationChangedOnDisk).toBeNull()
  })

  it('readonly.changed sets the banner and patches the work detail', () => {
    const qc = makeClient()
    qc.setQueryData(qk.work(W), { id: W, readonly: false })

    applyWorkEvent(qc, W, { type: 'readonly.changed', readonly: true, reason: 'second instance' })

    expect(useWorkStatusStore.getState().readonlyBanner).toEqual({
      readonly: true,
      reason: 'second instance',
    })
    expect(qc.getQueryData<{ readonly: boolean }>(qk.work(W))?.readonly).toBe(true)
  })

  it('resync triggers the broad invalidation sweep', () => {
    const qc = makeClient()
    const invalidate = vi.spyOn(qc, 'invalidateQueries')
    applyWorkEvent(qc, W, { type: 'resync' })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.work(W) })
  })

  it('the first hello and a same-stream hello (reconnect, no gap) do NOT refetch', () => {
    // Regression: `hello` used to invalidate everything on every connection, turning
    // every clean reconnect into a full refetch storm.
    const qc = makeClient()
    const invalidate = vi.spyOn(qc, 'invalidateQueries')

    applyWorkEvent(qc, W, { type: 'hello', streamId: 'stream-1', seq: 0 })
    expect(invalidate).not.toHaveBeenCalled()
    expect(useWorkStatusStore.getState().eventCursor).toEqual({ streamId: 'stream-1', seq: 0 })

    // the same stream continuing after a reconnect — replay covered any gap
    applyWorkEvent(qc, W, { type: 'hello', streamId: 'stream-1', seq: 7 })
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('a genuinely new stream invalidates work queries EXCEPT sectionText', async () => {
    const qc = makeClient()
    applyWorkEvent(qc, W, { type: 'hello', streamId: 'stream-1', seq: 3 })
    const invalidate = vi.spyOn(qc, 'invalidateQueries')

    applyWorkEvent(qc, W, { type: 'hello', streamId: 'stream-2', seq: 0 })

    expect(invalidate).toHaveBeenCalledTimes(1)
    const filters = invalidate.mock.calls[0]?.[0] as {
      queryKey: unknown
      predicate: (q: { queryKey: readonly unknown[] }) => boolean
    }
    expect(filters.queryKey).toEqual(qk.work(W))
    expect(filters.predicate({ queryKey: qk.sections(W) })).toBe(true)
    expect(filters.predicate({ queryKey: qk.sectionText(W, S1) })).toBe(false)
  })

  it('new-stream invalidation waits for in-flight mutations (optimistic delete survives)', async () => {
    const qc = makeClient()
    applyWorkEvent(qc, W, { type: 'hello', streamId: 'stream-1', seq: 3 })
    const invalidate = vi.spyOn(qc, 'invalidateQueries')

    // an optimistic delete's DELETE is still on the wire
    let resolveMutation: (() => void) | undefined
    const mutation = qc.getMutationCache().build(qc, {
      mutationFn: () =>
        new Promise<void>((resolve) => {
          resolveMutation = resolve
        }),
    })
    const done = mutation.execute(undefined)
    await waitFor(() => expect(qc.isMutating()).toBe(1))

    applyWorkEvent(qc, W, { type: 'hello', streamId: 'stream-2', seq: 0 })
    expect(invalidate).not.toHaveBeenCalled() // deferred — nothing resurrected

    resolveMutation?.()
    await done
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1))
  })
})

// ---------------------------------------------------------------------------
// task.* rows (04 §4.3, §4.4): started routes by lane; the rest by taskId; deltas
// batch behind the 33 ms flush.
// ---------------------------------------------------------------------------

const T1 = '01ARZ3NDEKTSV4RRFFQ69G5FB1'
const T2 = '01ARZ3NDEKTSV4RRFFQ69G5FB2'

function mkTask(id: string, spec: TaskSpec, lane: Task['lane'] = 'interactive'): Task {
  return {
    id,
    workId: W,
    spec,
    lane,
    status: 'running',
    queuedAt: NOW,
    startedAt: NOW,
    endedAt: null,
    error: null,
    partialText: null,
    unresolvedProposal: null,
  }
}

function startContinue(qc: QueryClient, taskId = T1): void {
  applyWorkEvent(qc, W, {
    type: 'task.started',
    task: mkTask(taskId, { kind: 'continue' }),
    lane: 'interactive',
    target: { kind: 'frontier' },
  })
}

describe('applyWorkEvent — attach-frame hydration + spend warning', () => {
  it('task.state (running) seeds the interactive slot with no pre-fetch', () => {
    const qc = makeClient()
    applyWorkEvent(qc, W, {
      type: 'task.state',
      task: mkTask(T1, { kind: 'continue' }),
      lane: 'interactive',
      target: { kind: 'frontier' },
    })
    expect(useTaskStore.getState().interactive?.taskId).toBe(T1)
    // the snapshot that follows the frame lands in the freshly seeded slot
    applyWorkEvent(qc, W, { type: 'task.snapshot', taskId: T1, target: 'frontier', text: 'hi' })
    expect(useTaskStore.getState().interactive?.buffers.get('frontier')).toBe('hi')
  })

  it('task.state (terminal, unresolved keep-partial) surfaces the proposal on hydrate', () => {
    const qc = makeClient()
    applyWorkEvent(qc, W, {
      type: 'task.state',
      task: {
        ...mkTask(T1, { kind: 'continue' }),
        status: 'error',
        endedAt: NOW,
        error: { code: 'timeout', message: 'gone' },
        partialText: 'kept prose',
        unresolvedProposal: { kind: 'keep-partial' },
      },
      lane: 'interactive',
      target: { kind: 'frontier' },
    })
    expect(useTaskStore.getState().interactive).toBeNull()
    expect(useTaskStore.getState().proposal).toMatchObject({ taskId: T1, text: 'kept prose' })
  })

  it('spend.warning parses and reduces without touching task state', () => {
    const qc = makeClient()
    applyWorkEvent(qc, W, { type: 'spend.warning', spentUsd: 6.2, thresholdUsd: 5 })
    expect(useTaskStore.getState().interactive).toBeNull()
  })
})

describe('applyWorkEvent — task rows (04 §4.3, §4.4)', () => {
  it('task.started routes by lane: interactive fills the slot, background fills the map', () => {
    const qc = makeClient()
    startContinue(qc)
    expect(useTaskStore.getState().interactive?.taskId).toBe(T1)

    applyWorkEvent(qc, W, {
      type: 'task.started',
      task: mkTask(T2, { kind: 'enrich-section', sectionId: S1 }, 'background'),
      lane: 'background',
      target: { kind: 'section', id: S1 },
    })

    // the flagship stream is isolated by construction — slot untouched
    const s = useTaskStore.getState()
    expect(s.interactive?.taskId).toBe(T1)
    expect(s.background.get(T2)?.kind).toBe('enrich-section')
  })

  it('task.queued puts a background task in the map with its queue position', () => {
    const qc = makeClient()
    applyWorkEvent(qc, W, {
      type: 'task.queued',
      task: mkTask(T2, { kind: 'enrich-section', sectionId: S1 }, 'background'),
      position: 2,
    })
    expect(useTaskStore.getState().background.get(T2)).toMatchObject({ queuedPosition: 2 })
  })

  it('task.stage flips planning ↔ writing; task.tool pushes a planning note', () => {
    const qc = makeClient()
    startContinue(qc)
    applyWorkEvent(qc, W, {
      type: 'task.tool',
      taskId: T1,
      name: 'context_expand',
      label: 'opened Chapter 7',
    })
    applyWorkEvent(qc, W, { type: 'task.stage', taskId: T1, stage: 'writing' })
    const s = useTaskStore.getState()
    expect(s.interactive?.stage).toBe('writing')
    expect(s.interactive?.toolNotes).toEqual(['opened Chapter 7'])
  })

  it('task.delta batches invisibly until the ~30 fps flush commits one append', () => {
    const qc = makeClient()
    startContinue(qc)
    applyWorkEvent(qc, W, { type: 'task.delta', taskId: T1, target: 'frontier', text: 'The ' })
    applyWorkEvent(qc, W, { type: 'task.delta', taskId: T1, target: 'frontier', text: 'ferry' })

    // nothing visible yet — React stays off the token firehose
    expect(useTaskStore.getState().interactive?.buffers.size).toBe(0)

    flushTaskDeltas()
    expect(useTaskStore.getState().interactive?.buffers.get('frontier')).toBe('The ferry')
  })

  it('targeted (quick-edit) deltas buffer invisibly under the target id', () => {
    const qc = makeClient()
    applyWorkEvent(qc, W, {
      type: 'task.started',
      task: mkTask(T1, {
        kind: 'quick-edit',
        instruction: 'tighten',
        target: { type: 'snippet', snippetId: S1, baseRev: 1 },
        selection: { text: 'x', start: 0, end: 1 },
      }),
      lane: 'interactive',
      target: { kind: 'snippet', id: S1 },
    })
    applyWorkEvent(qc, W, { type: 'task.delta', taskId: T1, target: S1, text: 'rewritten' })
    flushTaskDeltas()
    // buffered under the ULID target — the shimmer UI renders no live tokens (04 §8.3)
    expect(useTaskStore.getState().interactive?.buffers.get(S1)).toBe('rewritten')
  })

  it('task.snapshot replaces the buffer and drops stale pending deltas (reconnect)', () => {
    const qc = makeClient()
    startContinue(qc)
    applyWorkEvent(qc, W, {
      type: 'task.delta',
      taskId: T1,
      target: 'frontier',
      text: 'stale tail',
    })
    applyWorkEvent(qc, W, {
      type: 'task.snapshot',
      taskId: T1,
      target: 'frontier',
      text: 'the whole accumulated text',
    })
    flushTaskDeltas() // stale pending must not re-append after the snapshot
    expect(useTaskStore.getState().interactive?.buffers.get('frontier')).toBe(
      'the whole accumulated text',
    )
  })

  it('task.retrying resets the buffer and shows the attempt on the status line', () => {
    const qc = makeClient()
    startContinue(qc)
    applyWorkEvent(qc, W, { type: 'task.delta', taskId: T1, target: 'frontier', text: 'half' })
    flushTaskDeltas()
    applyWorkEvent(qc, W, {
      type: 'task.retrying',
      taskId: T1,
      attempt: 2,
      reason: 'output_invalid',
    })
    const s = useTaskStore.getState()
    expect(s.interactive?.buffers.size).toBe(0)
    expect(s.interactive?.retrying).toEqual({ attempt: 2, reason: 'output_invalid' })
  })

  it('task.usage lands on the interactive status line', () => {
    const qc = makeClient()
    startContinue(qc)
    applyWorkEvent(qc, W, {
      type: 'task.usage',
      taskId: T1,
      promptTokens: 6412,
      completionTokens: 388,
      estimated: false,
      costUsd: null,
    })
    expect(useTaskStore.getState().interactive?.usage).toEqual({
      promptTokens: 6412,
      completionTokens: 388,
      estimated: false,
      costUsd: null,
    })
  })

  it('task.progress patches the background illustration caption', () => {
    const qc = makeClient()
    applyWorkEvent(qc, W, {
      type: 'task.started',
      task: mkTask(T2, { kind: 'illustrate-section', sectionId: S1 }, 'illustration'),
      lane: 'illustration',
      target: { kind: 'section', id: S1 },
    })
    applyWorkEvent(qc, W, {
      type: 'task.progress',
      taskId: T2,
      phase: 'generating',
      attempt: 2,
      maxAttempts: 3,
      pct: 64,
    })
    expect(useTaskStore.getState().background.get(T2)).toMatchObject({
      phase: 'generating',
      attempt: 2,
      pct: 64,
    })
  })

  it('task.completed flushes pending deltas, then clears the slot (keyed swap)', () => {
    const qc = makeClient()
    startContinue(qc)
    applyWorkEvent(qc, W, { type: 'task.delta', taskId: T1, target: 'frontier', text: 'tail' })
    applyWorkEvent(qc, W, { type: 'task.completed', taskId: T1 })
    const s = useTaskStore.getState()
    expect(s.interactive).toBeNull()
    expect(s.proposal).toBeNull() // committed cleanly — nothing to resolve
  })

  it('a conflict artifact + completed offers apply-anyway with the full buffered rewrite', () => {
    const qc = makeClient()
    applyWorkEvent(qc, W, {
      type: 'task.started',
      task: mkTask(T1, {
        kind: 'quick-edit',
        instruction: 'tighten',
        target: { type: 'snippet', snippetId: S1, baseRev: 1 },
        selection: { text: 'x', start: 0, end: 1 },
      }),
      lane: 'interactive',
      target: { kind: 'snippet', id: S1 },
    })
    applyWorkEvent(qc, W, { type: 'task.delta', taskId: T1, target: S1, text: 'new pass' })
    applyWorkEvent(qc, W, {
      type: 'task.artifact',
      taskId: T1,
      artifact: { kind: 'snippet-revision', snippetId: S1, rev: 2, state: 'conflict' },
    })
    // completion flushes the still-pending delta before building the proposal text
    applyWorkEvent(qc, W, { type: 'task.completed', taskId: T1 })
    const proposal = useTaskStore.getState().proposal
    expect(proposal?.reason).toBe('conflict')
    expect(proposal?.text).toBe('new pass')
    expect(proposal?.target).toEqual({ kind: 'snippet', id: S1 })
  })

  it('task.failed on the interactive task toasts and offers keep-partial', () => {
    const qc = makeClient()
    startContinue(qc)
    applyWorkEvent(qc, W, {
      type: 'task.failed',
      taskId: T1,
      code: 'timeout',
      message: 'upstream timeout',
      partialText: 'The storm arrived',
      retryable: true,
    })
    const s = useTaskStore.getState()
    expect(s.interactive).toBeNull()
    expect(s.proposal?.reason).toBe('failed')
    expect(s.proposal?.text).toBe('The storm arrived')
    expect(useToastStore.getState().toasts.some((t) => t.tone === 'error')).toBe(true)
  })

  it('task.cancelled keeps the partial for review with an info toast', () => {
    const qc = makeClient()
    startContinue(qc)
    applyWorkEvent(qc, W, { type: 'task.cancelled', taskId: T1, partialText: 'partial prose' })
    expect(useTaskStore.getState().proposal?.reason).toBe('cancelled')
    expect(useToastStore.getState().toasts).toHaveLength(1)
  })

  it('background task.failed stays quiet — no toast, no proposal', () => {
    const qc = makeClient()
    applyWorkEvent(qc, W, {
      type: 'task.started',
      task: mkTask(T2, { kind: 'enrich-section', sectionId: S1 }, 'background'),
      lane: 'background',
      target: { kind: 'section', id: S1 },
    })
    applyWorkEvent(qc, W, {
      type: 'task.failed',
      taskId: T2,
      code: 'timeout',
      message: 'slow',
      partialText: 'x',
      retryable: true,
    })
    const s = useTaskStore.getState()
    expect(s.background.has(T2)).toBe(false)
    expect(s.proposal).toBeNull()
    expect(useToastStore.getState().toasts).toHaveLength(0)
  })

  it('task rows never touch the query cache — domain events own cache patching', () => {
    const qc = makeClient()
    const invalidate = vi.spyOn(qc, 'invalidateQueries')
    const setData = vi.spyOn(qc, 'setQueryData')
    startContinue(qc)
    applyWorkEvent(qc, W, { type: 'task.delta', taskId: T1, target: 'frontier', text: 'x' })
    flushTaskDeltas()
    applyWorkEvent(qc, W, { type: 'task.completed', taskId: T1 })
    expect(invalidate).not.toHaveBeenCalled()
    expect(setData).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Hook wiring with a fake EventSource
// ---------------------------------------------------------------------------

class FakeEventSource {
  static CONNECTING = 0 as const
  static OPEN = 1 as const
  static CLOSED = 2 as const
  static instances: FakeEventSource[] = []

  url: string
  readyState = 0
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  listeners = new Map<string, ((evt: MessageEvent<string>) => void)[]>()
  closed = false

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: (evt: MessageEvent<string>) => void): void {
    const existing = this.listeners.get(type) ?? []
    this.listeners.set(type, [...existing, listener])
  }

  close(): void {
    this.closed = true
    this.readyState = 2
  }

  emit(type: string, data: unknown, lastEventId = ''): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(data), lastEventId } as MessageEvent<string>)
    }
  }
}

describe('useWorkEvents', () => {
  it('opens one EventSource, applies parsed events, and cleans up on unmount', async () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    FakeEventSource.instances = []
    const qc = makeClient()
    qc.setQueryData(qk.snippets(W), [snippet(S1, 'a0')])

    const wrapper = ({ children }: { children: React.ReactNode }) =>
      createElement(QueryClientProvider, { client: qc }, children)

    const factory = (url: string) => new FakeEventSource(url) as unknown as EventSource
    const { unmount } = renderHook(() => useWorkEvents(W, { eventSourceFactory: factory }), {
      wrapper,
    })

    // StrictMode-free render: exactly one connection to the events route (connect is
    // deferred one tick behind the best-effort task hydration fetch)
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))
    const source = FakeEventSource.instances[0] as FakeEventSource
    expect(source.url).toBe(`/api/works/${W}/events`)

    source.onopen?.()
    expect(useWorkStatusStore.getState().connected).toBe(true)

    source.emit('snippet.created', { type: 'snippet.created', snippet: snippet(S2, 'b0') })
    expect(qc.getQueryData<SnippetDto[]>(qk.snippets(W))?.map((s) => s.id)).toEqual([S1, S2])

    // a malformed payload is dropped (logged in dev), not thrown
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    source.emit('snippet.created', { type: 'snippet.created', snippet: { id: 'nope' } })
    expect(qc.getQueryData<SnippetDto[]>(qk.snippets(W))).toHaveLength(2)
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()

    unmount()
    expect(source.closed).toBe(true)
    expect(useWorkStatusStore.getState().connected).toBe(false)
    vi.unstubAllGlobals()
  })

  it('schedules a backoff reconnect and resumes via the ?lastEventId query param', async () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    FakeEventSource.instances = []
    const qc = makeClient()
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      createElement(QueryClientProvider, { client: qc }, children)
    const factory = (url: string) => new FakeEventSource(url) as unknown as EventSource

    const { unmount } = renderHook(() => useWorkEvents(W, { eventSourceFactory: factory }), {
      wrapper,
    })

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))
    vi.useFakeTimers()

    const first = FakeEventSource.instances[0] as FakeEventSource
    // deliver one event carrying an SSE id — that becomes the resume cursor
    first.emit(
      'snippet.created',
      { type: 'snippet.created', snippet: snippet(S2, 'b0') },
      'stream-1:5',
    )
    expect(useWorkStatusStore.getState().eventCursor).toEqual({ streamId: 'stream-1', seq: 5 })

    first.readyState = 2 // CLOSED — the browser gave up
    first.onerror?.()

    expect(FakeEventSource.instances).toHaveLength(1)
    vi.advanceTimersByTime(500) // first backoff step
    expect(FakeEventSource.instances).toHaveLength(2)
    // a manual reconnect cannot set Last-Event-ID — the query param carries the cursor
    const second = FakeEventSource.instances[1] as FakeEventSource
    expect(second.url).toBe(
      `/api/works/${W}/events?lastEventId=${encodeURIComponent('stream-1:5')}`,
    )

    unmount()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('re-asserts the editing signal on every open while a snippet editor is open', async () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    FakeEventSource.instances = []
    const qc = makeClient()
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      createElement(QueryClientProvider, { client: qc }, children)
    const factory = (url: string) => new FakeEventSource(url) as unknown as EventSource

    const { unmount } = renderHook(() => useWorkEvents(W, { eventSourceFactory: factory }), {
      wrapper,
    })
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))
    useDocUiStore.setState({
      editing: { kind: 'snippet', id: S1, workId: W, draft: 'mid-edit' },
    })
    vi.mocked(signalEditing).mockClear()

    // Regression: the server clears the signal at zero SSE subscribers, so a reconnect
    // must re-POST the open editor or consolidation could eat the passage being edited.
    const source = FakeEventSource.instances[0] as FakeEventSource
    source.onopen?.()
    expect(signalEditing).toHaveBeenCalledWith(W, S1)

    unmount()
    vi.unstubAllGlobals()
  })

  it('hydrates a reload mid-generation purely from the stream (attach frame, no pre-fetch)', async () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    FakeEventSource.instances = []
    const fetchMock = vi.fn(async () => {
      throw new Error('the stream is the ONLY hydration source — no fetch allowed')
    })
    vi.stubGlobal('fetch', fetchMock)
    const qc = makeClient()
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      createElement(QueryClientProvider, { client: qc }, children)
    const factory = (url: string) => new FakeEventSource(url) as unknown as EventSource

    const { unmount } = renderHook(() => useWorkEvents(W, { eventSourceFactory: factory }), {
      wrapper,
    })

    // The connection opens immediately — there is no fetch-to-subscribe gap (03 §8.3).
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))
    expect(fetchMock).not.toHaveBeenCalled()

    // The bus's attach-time task.state frame seeds the slot…
    const source = FakeEventSource.instances[0] as FakeEventSource
    source.emit('task.state', {
      type: 'task.state',
      task: mkTask(T1, { kind: 'continue' }),
      lane: 'interactive',
      target: { kind: 'frontier' },
    })
    expect(useTaskStore.getState().interactive?.taskId).toBe(T1)

    // …and the synthetic snapshot that follows lands in it.
    source.emit('task.snapshot', {
      type: 'task.snapshot',
      taskId: T1,
      target: 'frontier',
      text: 'replayed prose',
    })
    const s = useTaskStore.getState()
    expect(s.interactive?.buffers.get('frontier')).toBe('replayed prose')
    // the snapshot's non-empty text implies the composition already started
    expect(s.interactive?.stage).toBe('writing')

    unmount()
    vi.unstubAllGlobals()
  })
})
