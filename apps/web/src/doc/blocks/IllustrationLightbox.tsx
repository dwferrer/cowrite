import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router'
import { useIllustrationRuns } from '../../api/queries.js'
import { testids } from '../../testids.js'
import { Button } from '../../ui/Button.js'

/**
 * The section-illustration lightbox (docs/04-frontend.md §10): full resolution, the section
 * title, [Regenerate] [Close], and a provenance footer linking the illustrate runs that
 * produced/refreshed this image (`GET /runs?artifact=illustration:<id>`, 08 §6, §8).
 */

export interface IllustrationLightboxProps {
  workId: string
  sectionId: string
  title: string
  src: string
  onClose: () => void
  onRegenerate: () => void
  regenerateDisabled?: boolean
}

export function IllustrationLightbox({
  workId,
  sectionId,
  title,
  src,
  onClose,
  onRegenerate,
  regenerateDisabled = false,
}: IllustrationLightboxProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const runs = useIllustrationRuns(workId, `illustration:${sectionId}`)

  useEffect(() => {
    panelRef.current?.focus()
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  // The lightbox is rendered from inside a SectionBlock/NameCard, which lives inside the
  // virtualized doc's `transform: translateY(...)` row (DocView). A `position: fixed` backdrop
  // inside a transformed ancestor is confined to that ancestor's box, not the viewport, so a
  // sibling virtual row can paint over the footer and steal its clicks. Portal to <body> so the
  // modal is a true top-layer overlay (same effective placement as the route-level RunViewer).
  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-close is supplementary; Esc is the accessible path
    // biome-ignore lint/a11y/useKeyWithClickEvents: the document-level Escape listener is the keyboard equivalent
    <div
      className="run-viewer-backdrop"
      data-testid={testids.illustrationLightbox}
      onClick={onClose}
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: click containment only; keys BUBBLE to the document Escape listener */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title || 'Illustration'}
        tabIndex={-1}
        className="illustration-lightbox"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="illustration-lightbox__header">
          <span style={{ flex: 1 }}>{title}</span>
          <Button
            variant="ghost"
            data-testid={testids.illustrationLightboxRegenerate}
            disabled={regenerateDisabled}
            onClick={onRegenerate}
          >
            Regenerate
          </Button>
          <Button
            variant="ghost"
            data-testid={testids.illustrationLightboxClose}
            aria-label="Close"
            onClick={onClose}
          >
            Close
          </Button>
        </header>
        <img className="illustration-lightbox__img" src={src} alt={title} />
        {runs.data && runs.data.length > 0 ? (
          <footer className="illustration-lightbox__footer">
            {runs.data.slice(0, 3).map((run) => (
              <Link
                key={run.runId}
                to={`/w/${workId}/runs/${run.runId}`}
                data-testid={testids.illustrationRunLink}
                // Opening the run's provenance viewer (a route-level modal) means leaving the
                // image view — close the lightbox so it does not sit on top of the RunViewer.
                onClick={onClose}
              >
                run {run.runId.slice(0, 8)}… · {new Date(run.startedAt).toLocaleString()}
              </Link>
            ))}
          </footer>
        ) : null}
      </div>
    </div>,
    document.body,
  )
}
