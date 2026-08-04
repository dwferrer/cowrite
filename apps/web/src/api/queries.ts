import {
  api,
  type SituationDto,
  type SnippetDto,
  type TaskSpec,
  type WorkDetail,
  type WorldEntryDto,
  type WorldEntryPatch,
} from '@cowrite/shared'
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type ApiBody, apiCall, throwApiError } from './client.js'

/**
 * Query-key factory + every useQuery/useMutation hook (docs/04-frontend.md §4.2).
 * Defaults (staleTime 30 s, retry 1) come from the QueryClient in main.tsx; immutable-ish
 * resources (`sectionText`, `run`) override to Infinity — invalidation rides SSE.
 */

export const qk = {
  works: () => ['works'] as const,
  config: () => ['config'] as const,
  work: (w: string) => ['work', w] as const,
  sections: (w: string) => ['work', w, 'sections'] as const,
  sectionText: (w: string, s: string) => ['work', w, 'sectionText', s] as const,
  snippets: (w: string) => ['work', w, 'snippets'] as const,
  revisions: (w: string, s: string) => ['work', w, 'revisions', s] as const,
  situation: (w: string) => ['work', w, 'situation'] as const,
  world: (w: string) => ['work', w, 'world'] as const,
  tasks: (w: string) => ['work', w, 'tasks'] as const,
  run: (w: string, r: string) => ['work', w, 'run', r] as const,
  ctxCandidates: (w: string) => ['work', w, 'ctx', 'candidates'] as const, // M2
}

/** Sort helper — fractional order keys compare lexicographically (02 §4). */
export function byOrderKey<T extends { orderKey: string }>(a: T, b: T): number {
  if (a.orderKey === b.orderKey) return 0
  return a.orderKey < b.orderKey ? -1 : 1
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function useWorks() {
  return useQuery({
    queryKey: qk.works(),
    queryFn: ({ signal }) => apiCall('listWorks', [], { signal }),
  })
}

export function useConfig() {
  return useQuery({
    queryKey: qk.config(),
    queryFn: ({ signal }) => apiCall('getConfig', [], { signal }),
  })
}

export function useWork(workId: string) {
  return useQuery({
    queryKey: qk.work(workId),
    queryFn: ({ signal }) => apiCall('getWork', [workId], { signal }),
  })
}

export function useSections(workId: string) {
  return useQuery({
    queryKey: qk.sections(workId),
    queryFn: ({ signal }) => apiCall('listSections', [workId], { signal }),
  })
}

/** Lazy leaf prose (04 §5.6): immutable behind contentHash; SSE invalidates. */
export function useSectionContent(workId: string, sectionId: string, enabled = true) {
  return useQuery({
    queryKey: qk.sectionText(workId, sectionId),
    queryFn: ({ signal }) => apiCall('getSectionContent', [workId, sectionId], { signal }),
    staleTime: Number.POSITIVE_INFINITY,
    enabled,
  })
}

export function useSnippets(workId: string) {
  return useQuery({
    queryKey: qk.snippets(workId),
    queryFn: async ({ signal }) => {
      const snippets = await apiCall('listSnippets', [workId], { signal })
      return [...snippets].sort(byOrderKey)
    },
  })
}

export function useSnippetRevisions(workId: string, snippetId: string, enabled = true) {
  return useQuery({
    queryKey: qk.revisions(workId, snippetId),
    queryFn: ({ signal }) => apiCall('listSnippetRevisions', [workId, snippetId], { signal }),
    enabled,
  })
}

export function useSituation(workId: string) {
  return useQuery({
    queryKey: qk.situation(workId),
    queryFn: ({ signal }) => apiCall('getSituation', [workId], { signal }),
  })
}

export function useWorld(workId: string) {
  return useQuery({
    queryKey: qk.world(workId),
    queryFn: ({ signal }) => apiCall('listWorldEntries', [workId], { signal }),
  })
}

/** One parsed run JSONL (04 §7.4) — immutable once the run ended; staleTime Infinity. */
export function useRun(workId: string, runId: string, enabled = true) {
  return useQuery({
    queryKey: qk.run(workId, runId),
    queryFn: ({ signal }) => apiCall('getRun', [workId, runId], { signal }),
    staleTime: Number.POSITIVE_INFINITY,
    enabled,
  })
}

// ---------------------------------------------------------------------------
// Task mutations (03 §3.7). Submitting returns the queued Task envelope (202); all display
// state then rides SSE `task.*` events into the task store — nothing to patch here.
// ---------------------------------------------------------------------------

export function useCreateTask(workId: string) {
  return useMutation({
    mutationFn: (spec: TaskSpec) => apiCall('createTask', [workId], { body: spec }),
  })
}

export function useCancelTask(workId: string) {
  return useMutation({
    mutationFn: (taskId: string) => apiCall('cancelTask', [workId, taskId]),
  })
}

/** Keep-partial / apply-anyway (04 §8.4) — the commit echoes back as a domain event. */
export function useApplyProposal(workId: string) {
  return useMutation({
    mutationFn: (taskId: string) => apiCall('applyProposal', [workId, taskId]),
  })
}

export function useDiscardProposal(workId: string) {
  return useMutation({
    mutationFn: (taskId: string) => apiCall('discardProposal', [workId, taskId]),
  })
}

// ---------------------------------------------------------------------------
// Mutations. Optimism policy (04 §8.1, §13): edits/deletes/restores are optimistic with
// rollback (the id already exists); creations are not (one localhost round-trip removes the
// temp-id vs SSE-echo reconciliation problem entirely).
// ---------------------------------------------------------------------------

export function useCreateWork() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { title: string }) => apiCall('createWork', [], { body: input }),
    onSuccess: (work: WorkDetail) => {
      void qc.invalidateQueries({ queryKey: qk.works() })
      qc.setQueryData(qk.work(work.id), work)
    },
  })
}

export function useCreateSnippet(workId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { text: string; afterSnippetId?: string }) =>
      apiCall('createSnippet', [workId], { body: input }),
    onSuccess: (snippet) => {
      // insert by orderKey; the SSE echo dedupes on the real id (04 §4.3)
      qc.setQueryData<SnippetDto[]>(qk.snippets(workId), (old) => {
        if (!old) return old
        if (old.some((s) => s.id === snippet.id)) return old
        return [...old, snippet].sort(byOrderKey)
      })
    },
  })
}

interface SaveSnippetInput {
  snippetId: string
  text: string
  baseRev: number
}

export function useSaveSnippet(workId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ snippetId, text, baseRev }: SaveSnippetInput) =>
      apiCall('patchSnippet', [workId, snippetId], { body: { text, baseRev } }),
    onMutate: async ({ snippetId, text, baseRev }) => {
      await qc.cancelQueries({ queryKey: qk.snippets(workId) })
      const previous = qc.getQueryData<SnippetDto[]>(qk.snippets(workId))
      qc.setQueryData<SnippetDto[]>(qk.snippets(workId), (old) =>
        old?.map((s) => (s.id === snippetId ? { ...s, text, rev: baseRev + 1 } : s)),
      )
      return { previous }
    },
    onError: (_err, _input, context) => {
      // 409 conflict path (04 §7.1): rollback; the editor keeps the draft
      if (context?.previous) qc.setQueryData(qk.snippets(workId), context.previous)
      void qc.invalidateQueries({ queryKey: qk.snippets(workId) })
    },
    onSuccess: (snippet) => {
      qc.setQueryData<SnippetDto[]>(qk.snippets(workId), (old) =>
        old?.map((s) => (s.id === snippet.id ? snippet : s)),
      )
      void qc.invalidateQueries({ queryKey: qk.revisions(workId, snippet.id) })
    },
  })
}

export function useDeleteSnippet(workId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (snippetId: string) => apiCall('deleteSnippet', [workId, snippetId]),
    onMutate: async (snippetId) => {
      await qc.cancelQueries({ queryKey: qk.snippets(workId) })
      const previous = qc.getQueryData<SnippetDto[]>(qk.snippets(workId))
      qc.setQueryData<SnippetDto[]>(qk.snippets(workId), (old) =>
        old?.filter((s) => s.id !== snippetId),
      )
      return { previous }
    },
    onError: (_err, _snippetId, context) => {
      if (context?.previous) qc.setQueryData(qk.snippets(workId), context.previous)
    },
  })
}

interface RestoreSnippetInput {
  snippetId: string
  rev: number
  /** Text of the peeked revision, if the caller has it — enables the optimistic swap. */
  optimisticText?: string
}

export function useRestoreSnippet(workId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ snippetId, rev }: RestoreSnippetInput) =>
      apiCall('restoreSnippet', [workId, snippetId], { body: { rev } }),
    onMutate: async ({ snippetId, optimisticText }) => {
      await qc.cancelQueries({ queryKey: qk.snippets(workId) })
      const previous = qc.getQueryData<SnippetDto[]>(qk.snippets(workId))
      if (optimisticText !== undefined) {
        qc.setQueryData<SnippetDto[]>(qk.snippets(workId), (old) =>
          old?.map((s) =>
            s.id === snippetId
              ? { ...s, text: optimisticText, rev: s.rev + 1, revisionCount: s.revisionCount + 1 }
              : s,
          ),
        )
      }
      return { previous }
    },
    onError: (_err, _input, context) => {
      if (context?.previous) qc.setQueryData(qk.snippets(workId), context.previous)
    },
    onSuccess: (snippet) => {
      qc.setQueryData<SnippetDto[]>(qk.snippets(workId), (old) =>
        old?.map((s) => (s.id === snippet.id ? snippet : s)),
      )
      void qc.invalidateQueries({ queryKey: qk.revisions(workId, snippet.id) })
    },
  })
}

interface SaveSituationInput {
  text: string
  baseHash: string | null
}

export function useSaveSituation(workId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ text, baseHash }: SaveSituationInput) =>
      apiCall('putSituation', [workId], { body: { text, baseHash } }),
    onSuccess: (res, { text }) => {
      qc.setQueryData<SituationDto>(qk.situation(workId), {
        text,
        updatedAt: res.updatedAt,
        hash: res.hash,
      })
    },
  })
}

export function useCreateWorldEntry(workId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { name: string; keys?: string[]; body?: string; shortSummary?: string }) =>
      apiCall('createWorldEntry', [workId], { body: input }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.world(workId) })
    },
  })
}

export function usePatchWorldEntry(workId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ entryId, patch }: { entryId: string; patch: WorldEntryPatch }) =>
      apiCall('patchWorldEntry', [workId, entryId], { body: patch }),
    onMutate: async ({ entryId, patch }) => {
      await qc.cancelQueries({ queryKey: qk.world(workId) })
      const previous = qc.getQueryData<WorldEntryDto[]>(qk.world(workId))
      qc.setQueryData<WorldEntryDto[]>(qk.world(workId), (old) =>
        old?.map((e) =>
          e.id === entryId
            ? {
                ...e,
                ...(patch.name !== undefined ? { name: patch.name } : {}),
                ...(patch.keys !== undefined ? { keys: patch.keys } : {}),
                ...(patch.body !== undefined ? { body: patch.body } : {}),
                ...(patch.shortSummary !== undefined ? { shortSummary: patch.shortSummary } : {}),
              }
            : e,
        ),
      )
      return { previous }
    },
    onError: (_err, _input, context) => {
      if (context?.previous) qc.setQueryData(qk.world(workId), context.previous)
      void qc.invalidateQueries({ queryKey: qk.world(workId) })
    },
    onSuccess: (entry) => {
      qc.setQueryData<WorldEntryDto[]>(qk.world(workId), (old) =>
        old?.map((e) => (e.id === entry.id ? entry : e)),
      )
    },
  })
}

export function useDeleteWorldEntry(workId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (entryId: string) => apiCall('deleteWorldEntry', [workId, entryId]),
    onMutate: async (entryId) => {
      await qc.cancelQueries({ queryKey: qk.world(workId) })
      const previous = qc.getQueryData<WorldEntryDto[]>(qk.world(workId))
      qc.setQueryData<WorldEntryDto[]>(qk.world(workId), (old) =>
        old?.filter((e) => e.id !== entryId),
      )
      return { previous }
    },
    onError: (_err, _entryId, context) => {
      if (context?.previous) qc.setQueryData(qk.world(workId), context.previous)
    },
  })
}

/** Raw PNG upload (03 §3.5) — outside apiCall, which only speaks JSON bodies. */
export function useUploadWorldImage(workId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ entryId, png }: { entryId: string; png: Blob | ArrayBuffer }) => {
      const response = await fetch(api.uploadWorldImage.path(workId, entryId), {
        method: 'POST',
        headers: { 'content-type': 'image/png' },
        body: png,
      })
      if (!response.ok) await throwApiError(response, 'uploadWorldImage')
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.world(workId) })
    },
  })
}

export function useDeleteWorldImage(workId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (entryId: string) => apiCall('deleteWorldImage', [workId, entryId]),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.world(workId) })
    },
  })
}

export function useUpdateConfig() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (update: ApiBody<'putConfig'>) => apiCall('putConfig', [], { body: update }),
    onSuccess: (res) => {
      qc.setQueryData(qk.config(), res.config)
    },
  })
}

export function useTestConfig() {
  return useMutation({
    mutationFn: (input: ApiBody<'testConfig'>) => apiCall('testConfig', [], { body: input }),
  })
}

export function useReloadConfig() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => apiCall('reloadConfig', []),
    onSuccess: (res) => {
      qc.setQueryData(qk.config(), res.config)
    },
  })
}

/** Prefetch used by the router loader (first-run redirect, 04 §11). */
export function fetchConfig(qc: QueryClient) {
  return qc.fetchQuery({
    queryKey: qk.config(),
    queryFn: ({ signal }) => apiCall('getConfig', [], { signal }),
    staleTime: 30_000,
  })
}
