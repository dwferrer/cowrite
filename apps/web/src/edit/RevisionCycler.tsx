import type { SnippetDto } from '@cowrite/shared'
import { useEffect } from 'react'
import { useRestoreSnippet, useSnippetRevisions } from '../api/queries.js'
import { useDocUiStore } from '../state/docUiStore.js'
import { testids } from '../testids.js'
import { Button } from '../ui/Button.js'

/**
 * ◀ rev k/n ▶ + restore (docs/04-frontend.md §7.3). Mounting (with the selection toolbar)
 * prefetches the revision list; stepping back sets a peek (purely visual); Restore appends a
 * NEW revision with the old text — history is never rewritten. Alt-←/→ arrive as
 * `cowrite:revision` CustomEvents from the global keymap.
 */

export const REVISION_CYCLE_EVENT = 'cowrite:revision'

export function dispatchRevisionCycle(dir: -1 | 1): void {
  window.dispatchEvent(new CustomEvent(REVISION_CYCLE_EVENT, { detail: { dir } }))
}

export interface RevisionCyclerProps {
  workId: string
  snippet: SnippetDto
  readonly?: boolean
}

export function RevisionCycler({ workId, snippet, readonly = false }: RevisionCyclerProps) {
  const revisions = useSnippetRevisions(workId, snippet.id)
  const peek = useDocUiStore((s) =>
    s.peekRevision?.snippetId === snippet.id ? s.peekRevision : null,
  )
  const setPeekRevision = useDocUiStore((s) => s.setPeekRevision)
  const restore = useRestoreSnippet(workId)

  const revs = (revisions.data ?? []).map((r) => r.rev).sort((a, b) => a - b)
  const latest = revs.length > 0 ? (revs[revs.length - 1] as number) : snippet.rev
  const current = peek?.rev ?? latest
  const total = revs.length > 0 ? revs.length : snippet.revisionCount

  const step = (dir: -1 | 1) => {
    if (revs.length === 0) return
    const idx = revs.indexOf(current)
    const nextIdx = Math.min(
      revs.length - 1,
      Math.max(0, (idx === -1 ? revs.length - 1 : idx) + dir),
    )
    const next = revs[nextIdx]
    if (next === undefined) return
    setPeekRevision(next === latest ? null : { snippetId: snippet.id, rev: next })
  }

  useEffect(() => {
    const onCycle = (e: Event) => {
      const dir = (e as CustomEvent<{ dir: -1 | 1 }>).detail?.dir
      if (dir === -1 || dir === 1) step(dir)
    }
    window.addEventListener(REVISION_CYCLE_EVENT, onCycle)
    return () => window.removeEventListener(REVISION_CYCLE_EVENT, onCycle)
  })

  const doRestore = () => {
    if (!peek) return
    const text = revisions.data?.find((r) => r.rev === peek.rev)?.text
    restore.mutate(
      {
        snippetId: snippet.id,
        rev: peek.rev,
        ...(text !== undefined ? { optimisticText: text } : {}),
      },
      { onSuccess: () => setPeekRevision(null) },
    )
  }

  const position = revs.indexOf(current)
  const label = `rev ${position === -1 ? current : position + 1}/${total}`

  return (
    <span
      data-testid={testids.revisionCycler}
      style={{ alignItems: 'center', display: 'inline-flex', gap: 2, whiteSpace: 'nowrap' }}
    >
      <Button
        variant="ghost"
        aria-label="Previous revision"
        data-testid={testids.revisionPrev}
        disabled={revs.length < 2 || current === revs[0]}
        onClick={() => step(-1)}
        style={{ padding: '0 4px' }}
      >
        ◀
      </Button>
      <span style={{ color: 'var(--fg-muted)', fontSize: 12 }}>{label}</span>
      <Button
        variant="ghost"
        aria-label="Next revision"
        data-testid={testids.revisionNext}
        disabled={peek === null}
        onClick={() => step(1)}
        style={{ padding: '0 4px' }}
      >
        ▶
      </Button>
      {peek !== null && !readonly ? (
        <Button
          variant="ghost"
          data-testid={testids.revisionRestore}
          onClick={doRestore}
          disabled={restore.isPending}
          style={{ padding: '0 4px' }}
        >
          Restore ↩
        </Button>
      ) : null}
    </span>
  )
}
