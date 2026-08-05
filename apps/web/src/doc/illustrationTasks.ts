import { useNavigate } from 'react-router'
import { useCreateTask } from '../api/queries.js'
import { toastTaskCreateError } from '../api/taskErrors.js'

/**
 * `illustrate-section` / `world-image` task submission (docs/08-illustration.md §5, §8) — the
 * "Illustrate" / "Regenerate…" menu, the failure badge's retry, and the world editor's
 * "Generate"/"Regenerate" all launch through one of these two hooks so the `config_missing`
 * → /settings toast (`taskErrors.ts`) is wired exactly once per kind.
 */

export interface IllustrationLauncher {
  /** Submit; `guidance` is trimmed and dropped when blank (regenerate-with-guidance, §5). */
  run(id: string, guidance?: string): void
  pending: boolean
}

export function useIllustrateSection(workId: string): IllustrationLauncher {
  const createTask = useCreateTask(workId)
  const navigate = useNavigate()
  return {
    run: (sectionId, guidance) => {
      const trimmed = guidance?.trim()
      createTask.mutate(
        { kind: 'illustrate-section', sectionId, ...(trimmed ? { guidance: trimmed } : {}) },
        { onError: (err) => toastTaskCreateError(err, () => navigate('/settings')) },
      )
    },
    pending: createTask.isPending,
  }
}

export function useIllustrateWorldEntry(workId: string): IllustrationLauncher {
  const createTask = useCreateTask(workId)
  const navigate = useNavigate()
  return {
    run: (entryId, guidance) => {
      const trimmed = guidance?.trim()
      createTask.mutate(
        { kind: 'world-image', entryId, ...(trimmed ? { guidance: trimmed } : {}) },
        { onError: (err) => toastTaskCreateError(err, () => navigate('/settings')) },
      )
    },
    pending: createTask.isPending,
  }
}
