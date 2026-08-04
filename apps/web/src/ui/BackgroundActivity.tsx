import type { SectionRow } from '@cowrite/shared'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { qk } from '../api/queries.js'
import { type BackgroundTask, useTaskStore } from '../state/taskStore.js'
import { testids } from '../testids.js'

/**
 * The minimal, unobtrusive background-lane indicator (docs/04-frontend.md §4.4, Stage 4):
 * a small pulse dot in the work header while any background task is queued/running, with
 * a click-open popover listing them. Background work never blocks or toasts (05 §11) —
 * this is the whole surface; failures stay quiet and staleness badges carry the rest.
 */

/** One human line per row: "enrich-section · Chapter 3 — running". */
export function backgroundTaskLabel(
  task: BackgroundTask,
  sectionTitle: (id: string) => string | null,
): string {
  const what =
    task.target.kind === 'section' && task.target.id !== undefined
      ? (sectionTitle(task.target.id) ?? 'a section')
      : task.target.kind
  const status =
    task.queuedPosition !== undefined
      ? `queued #${task.queuedPosition + 1}`
      : task.phase !== undefined
        ? `${task.phase}${task.pct !== null && task.pct !== undefined ? ` ${Math.round(task.pct)}%` : ''}`
        : 'running'
  return `${task.kind} · ${what} — ${status}`
}

export function BackgroundActivity({ workId }: { workId: string }) {
  const background = useTaskStore((s) => s.background)
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const qc = useQueryClient()

  // light-dismiss without a portal: any click outside the wrapper closes the popover
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  if (background.size === 0) return null

  const sectionTitle = (id: string): string | null =>
    qc.getQueryData<SectionRow[]>(qk.sections(workId))?.find((row) => row.id === id)?.title ?? null

  return (
    <div className="background-activity" ref={wrapRef}>
      <button
        type="button"
        className="background-activity__dot"
        data-testid={testids.backgroundDot}
        aria-expanded={open}
        aria-label={`${background.size} background task${background.size === 1 ? '' : 's'} running`}
        title="Background activity"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="background-activity__pulse" aria-hidden />
      </button>
      {open ? (
        <div
          className="background-activity__popover"
          data-testid={testids.backgroundPopover}
          role="dialog"
          aria-label="Background tasks"
        >
          {[...background.entries()].map(([taskId, task]) => (
            <div
              key={taskId}
              className="background-activity__row"
              data-testid={testids.backgroundTaskRow}
            >
              {backgroundTaskLabel(task, sectionTitle)}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
