import type { SectionRow } from '@cowrite/shared'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { apiCall } from '../../api/client.js'
import { qk, useDeleteSectionIllustration } from '../../api/queries.js'
import type { FoldLevel } from '../../state/docUiStore.js'
import { usePanelStore } from '../../state/panelStore.js'
import { testids } from '../../testids.js'
import { useIllustrateSection } from '../illustrationTasks.js'
import { RegenerateGuidanceBox } from './RegenerateGuidanceBox.js'

/**
 * Section heading block (docs/04-frontend.md §5.2, §5.3, §6): title (or "Chapter N"), slim
 * rule, the fold widget (four dots + auto reset, pin glyph when non-auto), the staleness
 * badge whose tooltip names exactly what is out of date, and — for leaf sections — the "⋯"
 * menu that gains "Illustrate"/"Regenerate…" and "Remove illustration" (08 §5, §8; 04 §10).
 * Hovering for 150 ms prefetches the leaf's content so expanding feels instant (§5.6).
 */

const PREFETCH_HOVER_MS = 150

/** Widget order mirrors the ladder top-to-bottom: most prose → least (04 §5.3). */
const FOLD_LEVELS: readonly FoldLevel[] = ['full', 'long', 'short', 'name']

const FOLD_LABEL: Record<FoldLevel, string> = {
  full: 'full prose',
  long: 'long summary',
  short: 'short summary',
  name: 'name card',
}

export interface SectionHeaderProps {
  workId: string
  section: SectionRow
  ordinal: number
  depth: number
  /** The effective fold this header currently renders at (block model, §5.2). */
  fold: FoldLevel
  /**
   * Called BEFORE a pin mutates the fold, so DocView can anchor the viewport to THIS
   * header — the section you asked to (un)fold stays put while everything below grows
   * (§5.5 "expanding a section you clicked").
   */
  onBeforeFoldChange?: (sectionId: string) => void
  readonly?: boolean
}

/** The "⋯" illustration menu (08 §5, §8; 04 §10): Illustrate / Regenerate… (+ guidance) /
 *  Remove illustration. Leaf sections only — illustration is a leaf-level artifact (02 §6.5). */
function IllustrationMenu({ workId, section }: { workId: string; section: SectionRow }) {
  const [open, setOpen] = useState(false)
  const [guidanceOpen, setGuidanceOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const illustrate = useIllustrateSection(workId)
  const removeIllustration = useDeleteSectionIllustration(workId)
  const hasImage = section.illustration !== null

  useEffect(() => {
    if (!open && !guidanceOpen) return
    const onPointerDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false)
        setGuidanceOpen(false)
      }
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [open, guidanceOpen])

  const submitGuidance = (guidance: string) => {
    illustrate.run(section.id, guidance || undefined)
    setGuidanceOpen(false)
    setOpen(false)
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: click containment only — the button/input carry the semantics
    <div
      className="section-menu-wrap"
      ref={wrapRef}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className="section-menu-button"
        data-testid={testids.sectionMenuButton}
        aria-label="Section actions"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        ⋯
      </button>
      {open ? (
        <div className="section-menu" data-testid={testids.sectionMenu} role="menu">
          {!hasImage ? (
            <button
              type="button"
              role="menuitem"
              data-testid={testids.illustrateAction}
              disabled={illustrate.pending}
              onClick={() => {
                illustrate.run(section.id)
                setOpen(false)
              }}
            >
              Illustrate
            </button>
          ) : (
            <>
              <button
                type="button"
                role="menuitem"
                data-testid={testids.regenerateAction}
                disabled={illustrate.pending}
                onClick={() => setGuidanceOpen(true)}
              >
                Regenerate…
              </button>
              <button
                type="button"
                role="menuitem"
                data-testid={testids.removeIllustrationAction}
                disabled={removeIllustration.isPending}
                onClick={() => {
                  removeIllustration.mutate(section.id)
                  setOpen(false)
                }}
              >
                Remove illustration
              </button>
            </>
          )}
        </div>
      ) : null}
      {guidanceOpen ? (
        <RegenerateGuidanceBox
          boxTestId={testids.regenerateGuidanceBox}
          inputTestId={testids.regenerateGuidanceInput}
          submitTestId={testids.regenerateGuidanceSubmit}
          cancelTestId={testids.regenerateGuidanceCancel}
          placeholder="show the storm from the cliff, dusk light…"
          submitLabel="Regenerate"
          pending={illustrate.pending}
          onSubmit={submitGuidance}
          onCancel={() => setGuidanceOpen(false)}
        />
      ) : null}
    </div>
  )
}

export function sectionDisplayTitle(section: SectionRow, ordinal: number): string {
  if (section.title) return section.title
  const kind =
    section.kind.length > 0 ? section.kind[0]?.toUpperCase() + section.kind.slice(1) : 'Section'
  return `${kind} ${ordinal}`
}

/** Tooltip naming what is stale (04 §6). Illustration staleness is Stage 5 — deliberately
 *  excluded here until the illustrate-section pipeline exists to refresh it. */
export function staleTooltip(stale: SectionRow['stale']): string | null {
  const parts: string[] = []
  if (stale.short) parts.push('short summary')
  if (stale.long) parts.push('long summary')
  if (parts.length === 0) return null
  return `Out of date: ${parts.join(', ')} — will refresh with enrichment`
}

export function SectionHeader({
  workId,
  section,
  ordinal,
  depth,
  fold,
  onBeforeFoldChange,
  readonly = false,
}: SectionHeaderProps) {
  const qc = useQueryClient()
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const override = usePanelStore((s) => s.byWork[workId]?.foldOverrides[section.id] ?? 'auto')
  const setFold = usePanelStore((s) => s.setFold)

  const prefetch = () => {
    if (!section.isLeaf || section.contentHash === null) return
    void qc.prefetchQuery({
      queryKey: qk.sectionText(workId, section.id),
      queryFn: ({ signal }) => apiCall('getSectionContent', [workId, section.id], { signal }),
      staleTime: Number.POSITIVE_INFINITY,
    })
  }

  const pin = (level: FoldLevel | 'auto') => {
    if (level === override) return
    onBeforeFoldChange?.(section.id)
    setFold(workId, section.id, level)
  }

  const tooltip = staleTooltip(section.stale)
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover/focus here only warm the prefetch cache (§5.6) — no behavior is gated on them
    <div
      className="section-heading"
      data-testid={testids.sectionHeader}
      data-section-id={section.id}
      data-fold={fold}
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
      {tooltip !== null ? (
        <span className="stale-badge" data-testid={testids.staleBadge} title={tooltip}>
          ⟳
        </span>
      ) : null}
      {fold !== 'full' ? <span className="section-heading__fold-hint">({fold})</span> : null}
      {section.isLeaf ? (
        <span className="fold-widget" data-testid={testids.foldWidget}>
          {override !== 'auto' ? (
            <span className="fold-widget__pin" title="Pinned — reset with auto" aria-hidden>
              📌
            </span>
          ) : null}
          {FOLD_LEVELS.map((level) => (
            <button
              key={level}
              type="button"
              className="fold-widget__dot"
              data-testid={testids.foldDot}
              data-level={level}
              aria-pressed={fold === level}
              title={`Pin to ${FOLD_LABEL[level]}`}
              onClick={() => pin(level)}
              onFocus={level === 'full' ? prefetch : undefined}
            >
              ●
            </button>
          ))}
          <button
            type="button"
            className="fold-widget__auto"
            data-testid={testids.foldAuto}
            aria-pressed={override === 'auto'}
            title="Follow the distance default"
            onClick={() => pin('auto')}
          >
            auto
          </button>
        </span>
      ) : null}
      {section.isLeaf && !readonly ? <IllustrationMenu workId={workId} section={section} /> : null}
    </div>
  )
}
