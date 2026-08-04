import type { SectionRow } from '@cowrite/shared'
import { api } from '@cowrite/shared'
import { testids } from '../../testids.js'
import { sectionDisplayTitle } from './SectionHeader.js'

/**
 * The deep-past collapsed card (docs/04-frontend.md §5.1, §10): illustration (or the
 * deterministic placeholder) left, title + first summary sentence right. The image slot is
 * the Stage-5 illustration surface — until that pipeline lands, `SectionRow.illustration`
 * is null and the placeholder (initials on a hue derived from the section id) renders, so
 * cards stay scannable and the reserved box means pixels arriving later never shift layout.
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
  const firstSentence = section.shortSummary?.split(/(?<=[.!?])\s/)[0] ?? ''
  const displayTitle = sectionDisplayTitle(section, ordinal)
  return (
    <div className="name-card" data-testid={testids.nameCard} data-section-id={section.id}>
      {section.illustration ? (
        <img
          src={`${api.getSectionIllustration.path(workId, section.id)}?v=${section.illustration.version}`}
          alt=""
          className="name-card__img"
          style={{ aspectRatio: `${section.illustration.width} / ${section.illustration.height}` }}
        />
      ) : (
        <div
          className="name-card__img name-card__img--placeholder"
          style={{ background: `oklch(0.85 0.05 ${hueFromId(section.id)})` }}
        >
          {displayTitle.slice(0, 2)}
        </div>
      )}
      <div>
        <div className="name-card__title">{displayTitle}</div>
        <div className="name-card__hook">{firstSentence}</div>
      </div>
    </div>
  )
}
