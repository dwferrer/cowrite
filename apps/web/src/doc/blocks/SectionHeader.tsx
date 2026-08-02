import type { SectionRow } from '@cowrite/shared'
import { useQueryClient } from '@tanstack/react-query'
import { useRef } from 'react'
import { apiCall } from '../../api/client.js'
import { qk } from '../../api/queries.js'
import { testids } from '../../testids.js'

/**
 * Section heading block (docs/04-frontend.md §5.2): title (or "Chapter N"), slim rule, a
 * staleness-badge slot. Hovering for 150 ms prefetches the leaf's content so expanding feels
 * instant (§5.6). The fold widget lands with the ladder rendering (Stage 4).
 */

const PREFETCH_HOVER_MS = 150

export interface SectionHeaderProps {
  workId: string
  section: SectionRow
  ordinal: number
  depth: number
}

export function sectionDisplayTitle(section: SectionRow, ordinal: number): string {
  if (section.title) return section.title
  const kind =
    section.kind.length > 0 ? section.kind[0]?.toUpperCase() + section.kind.slice(1) : 'Section'
  return `${kind} ${ordinal}`
}

export function SectionHeader({ workId, section, ordinal, depth }: SectionHeaderProps) {
  const qc = useQueryClient()
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const prefetch = () => {
    if (!section.isLeaf || section.contentHash === null) return
    void qc.prefetchQuery({
      queryKey: qk.sectionText(workId, section.id),
      queryFn: ({ signal }) => apiCall('getSectionContent', [workId, section.id], { signal }),
      staleTime: Number.POSITIVE_INFINITY,
    })
  }

  const stale = section.stale.short || section.stale.long
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover/focus here only warm the prefetch cache (§5.6) — no behavior is gated on them
    <div
      className="section-heading"
      data-testid={testids.sectionHeader}
      data-section-id={section.id}
      style={{ paddingLeft: depth * 16 }}
      onMouseEnter={() => {
        hoverTimer.current = setTimeout(prefetch, PREFETCH_HOVER_MS)
      }}
      onMouseLeave={() => {
        if (hoverTimer.current !== undefined) clearTimeout(hoverTimer.current)
      }}
      onFocus={prefetch}
    >
      <span className="section-heading__title">{sectionDisplayTitle(section, ordinal)}</span>
      {stale ? (
        <span
          className="stale-badge"
          data-testid={testids.staleBadge}
          title="Summary outdated — will refresh with enrichment"
        >
          ⟳
        </span>
      ) : null}
    </div>
  )
}
