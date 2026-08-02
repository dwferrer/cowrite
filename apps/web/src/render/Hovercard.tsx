import type { WorldEntryDto } from '@cowrite/shared'
import { api } from '@cowrite/shared'
import { autoUpdate, FloatingPortal, flip, offset, shift, useFloating } from '@floating-ui/react'
import { useNavigate } from 'react-router'
import { create } from 'zustand'
import { useWorld } from '../api/queries.js'
import { testids } from '../testids.js'
import { Button } from '../ui/Button.js'

/**
 * The one global world-entry hovercard (docs/04-frontend.md §6.3): opens after a 350 ms hover
 * on a `span.wi`, shows entry name, shortSummary (or the first ~3 lines of the body as a
 * fallback), a thumbnail when the entry has an image, and "open ↗". Content comes from the
 * already-loaded world list cache — zero fetch on hover.
 */

export const HOVER_OPEN_DELAY_MS = 350
const HOVER_CLOSE_DELAY_MS = 150

interface HovercardState {
  entryId: string | null
  anchor: HTMLElement | null
  show(entryId: string, anchor: HTMLElement): void
  hide(): void
}

let closeTimer: ReturnType<typeof setTimeout> | undefined

export const useHovercardStore = create<HovercardState>()((set) => ({
  entryId: null,
  anchor: null,
  show: (entryId, anchor) => {
    if (closeTimer !== undefined) clearTimeout(closeTimer)
    set({ entryId, anchor })
  },
  hide: () => {
    if (closeTimer !== undefined) clearTimeout(closeTimer)
    closeTimer = setTimeout(() => set({ entryId: null, anchor: null }), HOVER_CLOSE_DELAY_MS)
  },
}))

/** Keep the card open while the pointer is inside it. */
function holdOpen(): void {
  if (closeTimer !== undefined) clearTimeout(closeTimer)
}

/** shortSummary, or the first ~3 non-empty lines of the entry body (per the brief). */
export function hovercardExcerpt(entry: Pick<WorldEntryDto, 'shortSummary' | 'body'>): string {
  if (entry.shortSummary) return entry.shortSummary
  const lines = entry.body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  return lines.slice(0, 3).join(' ')
}

export interface HovercardCardProps {
  workId: string
  entry: WorldEntryDto
  onOpen(): void
}

/** The card content, extracted for direct testing (positioning is floating-ui's problem). */
export function HovercardCard({ workId, entry, onOpen }: HovercardCardProps) {
  return (
    <div
      data-testid={testids.worldHovercard}
      style={{
        alignItems: 'flex-start',
        background: 'var(--bg-raised)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-1)',
        boxShadow: 'var(--shadow-1)',
        display: 'flex',
        fontFamily: 'var(--font-ui)',
        fontSize: 13,
        gap: 'var(--space-3)',
        lineHeight: 1.45,
        maxWidth: 340,
        padding: 'var(--space-3)',
      }}
    >
      {entry.hasImage ? (
        <img
          src={`${api.getWorldImage.path(workId, entry.id)}?v=${entry.imageVersion ?? ''}`}
          alt=""
          width={48}
          height={48}
          style={{ borderRadius: 'var(--radius-1)', flexShrink: 0, objectFit: 'cover' }}
        />
      ) : null}
      <div style={{ minWidth: 0 }}>
        <div style={{ alignItems: 'baseline', display: 'flex', gap: 'var(--space-2)' }}>
          <strong>{entry.name}</strong>
          <Button
            variant="ghost"
            aria-label={`Open ${entry.name}`}
            onClick={onOpen}
            style={{ padding: '0 4px' }}
          >
            open ↗
          </Button>
        </div>
        <div style={{ color: 'var(--fg-muted)', marginTop: 2 }}>{hovercardExcerpt(entry)}</div>
      </div>
    </div>
  )
}

/** Mounted once by DocView; renders wherever the store points it. */
export function WorldHovercard({ workId }: { workId: string }) {
  const entryId = useHovercardStore((s) => s.entryId)
  const anchor = useHovercardStore((s) => s.anchor)
  const hide = useHovercardStore((s) => s.hide)
  const world = useWorld(workId)
  const navigate = useNavigate()

  const { refs, floatingStyles } = useFloating({
    elements: { reference: anchor },
    middleware: [offset(8), flip(), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
    open: entryId !== null,
  })

  const entry = entryId ? world.data?.find((e) => e.id === entryId) : undefined
  if (!entry || !anchor) return null

  return (
    <FloatingPortal>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: hover-hold is pointer affordance only — the card's button and the underlined span are the accessible paths */}
      <div
        ref={refs.setFloating}
        style={{ ...floatingStyles, zIndex: 50 }}
        onMouseEnter={holdOpen}
        onMouseLeave={hide}
      >
        <HovercardCard
          workId={workId}
          entry={entry}
          onOpen={() => {
            hide()
            navigate(`/w/${workId}/world/${entry.id}`)
          }}
        />
      </div>
    </FloatingPortal>
  )
}
