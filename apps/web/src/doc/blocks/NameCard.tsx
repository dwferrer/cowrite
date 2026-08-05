import type { SectionRow } from '@cowrite/shared'
import { testids } from '../../testids.js'
import { IllustrationOverlay } from './IllustrationOverlay.js'
import { sectionDisplayTitle } from './SectionHeader.js'
import { useSectionIllustration } from './useSectionIllustration.js'

/**
 * The deep-past collapsed card (docs/04-frontend.md §5.1, §10): illustration (or the
 * deterministic placeholder) left, title + first summary sentence right. No illustration yet
 * (or user-suppressed — the slot renders identically for both, §5.1) → the placeholder
 * (initials on a hue derived from the section id) so cards stay scannable; the reserved box
 * means pixels arriving later never shift layout. While `illustrate-section` runs against
 * this section the placeholder/image carries the shimmer overlay (08 §8); clicking a
 * committed image opens the full-resolution lightbox.
 */

/** Deterministic placeholder hue for name cards without an illustration (04 §10). */
export function hueFromId(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360
  return h
}

export interface NameCardProps {
  workId: string
  section: SectionRow
  /** Per-kind document ordinal — untitled sections render "Chapter N" (04 §5.3). */
  ordinal: number
}

export function NameCard({ workId, section, ordinal }: NameCardProps) {
  const { illustration, illustrate, src, openLightbox, lightbox } = useSectionIllustration(
    workId,
    section,
  )
  const firstSentence = section.shortSummary?.split(/(?<=[.!?])\s/)[0] ?? ''
  const displayTitle = sectionDisplayTitle(section, ordinal)

  return (
    <div className="name-card" data-testid={testids.nameCard} data-section-id={section.id}>
      <div className="name-card__img-wrap">
        {src ? (
          // biome-ignore lint/a11y/noStaticElementInteractions: opens the read-only lightbox; Enter/Space on the image would be redundant with click, keyboard users reach the same action via the section menu
          // biome-ignore lint/a11y/useKeyWithClickEvents: see above
          <img
            data-testid={testids.illustrationImage}
            src={src}
            alt=""
            className="name-card__img"
            style={{ aspectRatio: `${illustration?.width} / ${illustration?.height}` }}
            onClick={openLightbox}
          />
        ) : (
          <div
            data-testid={testids.illustrationPlaceholder}
            className="name-card__img name-card__img--placeholder"
            style={{ background: `oklch(0.85 0.05 ${hueFromId(section.id)})` }}
          >
            {displayTitle.slice(0, 2)}
          </div>
        )}
        <IllustrationOverlay
          targetKind="section"
          targetId={section.id}
          onRetry={() => illustrate.run(section.id)}
          retryDisabled={illustrate.pending}
        />
      </div>
      <div>
        <div className="name-card__title">{displayTitle}</div>
        <div className="name-card__hook">{firstSentence}</div>
      </div>
      {lightbox(displayTitle)}
    </div>
  )
}
