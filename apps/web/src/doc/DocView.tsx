import type { SectionRow } from '@cowrite/shared'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useLayoutEffect, useRef } from 'react'
import { WorldHovercard } from '../render/Hovercard.js'
import { useWorldMatcher } from '../render/Markdown.js'
import { useDocUiStore } from '../state/docUiStore.js'
import { testids } from '../testids.js'
import { computeAnchor, isNearBottom, restoreScrollTop, type ScrollAnchor } from './anchoring.js'
import { FrontierBar } from './blocks/FrontierBar.js'
import { SectionBlock } from './blocks/SectionBlock.js'
import { SectionHeader } from './blocks/SectionHeader.js'
import { SnippetBlock } from './blocks/SnippetBlock.js'
import { type Block, estimateBlockSize, useDocBlocks } from './useDocBlocks.js'

/**
 * The document view (docs/04-frontend.md §5): one @tanstack/react-virtual surface over the
 * whole work with `overflow-anchor: none` — we own anchoring. Opening a work lands at the
 * frontier (followBottom); scrolling up breaks it; the "↓ frontier" pill or End restores it.
 * After any re-layout (lazy text arriving, image loads, fold changes) the topmost visible
 * block is restored to its exact viewport offset — unless followBottom wins.
 */

export interface DocViewProps {
  workId: string
  readonly?: boolean
}

/** Deterministic placeholder hue for name cards without an illustration (04 §10). */
function hueFromId(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360
  return h
}

function NameCard({ workId, section }: { workId: string; section: SectionRow }) {
  const firstSentence = section.shortSummary?.split(/(?<=[.!?])\s/)[0] ?? ''
  return (
    <div className="name-card" data-testid={testids.nameCard} data-section-id={section.id}>
      {section.illustration ? (
        <img
          src={`/api/works/${workId}/sections/${section.id}/illustration?v=${section.illustration.version}`}
          alt=""
          className="name-card__img"
          style={{ aspectRatio: `${section.illustration.width} / ${section.illustration.height}` }}
        />
      ) : (
        <div
          className="name-card__img name-card__img--placeholder"
          style={{ background: `oklch(0.85 0.05 ${hueFromId(section.id)})` }}
        >
          {(section.title ?? '?').slice(0, 2)}
        </div>
      )}
      <div>
        <div className="name-card__title">{section.title ?? 'Untitled'}</div>
        <div className="name-card__hook">{firstSentence}</div>
      </div>
    </div>
  )
}

export function DocView({ workId, readonly = false }: DocViewProps) {
  const parentRef = useRef<HTMLDivElement | null>(null)
  const { blocks, isLoading } = useDocBlocks(workId)
  const matcher = useWorldMatcher(workId)
  const followBottom = useDocUiStore((s) => s.followBottom)
  const setFollowBottom = useDocUiStore((s) => s.setFollowBottom)
  const anchorRef = useRef<ScrollAnchor | null>(null)
  const suppressScrollRef = useRef(false)
  const didInitialScrollRef = useRef(false)

  const virtualizer = useVirtualizer({
    count: blocks.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => {
      const block = blocks[i]
      return block ? estimateBlockSize(block) : 0
    },
    getItemKey: (i) => blocks[i]?.key ?? String(i),
    overscan: 6,
  })

  const totalSize = virtualizer.getTotalSize()
  const items = virtualizer.getVirtualItems()

  // afterMeasurementsChange (04 §5.5): frontier stickiness wins; otherwise restore the anchor
  // biome-ignore lint/correctness/useExhaustiveDependencies: totalSize is the re-layout signal — the effect must re-run whenever measured heights change even though it reads live values
  useLayoutEffect(() => {
    const el = parentRef.current
    if (!el || isLoading || blocks.length === 0) return
    if (followBottom) {
      suppressScrollRef.current = true
      el.scrollTop = el.scrollHeight
      didInitialScrollRef.current = true
      return
    }
    const anchor = anchorRef.current
    if (!anchor) return
    const index = blocks.findIndex((b) => b.key === anchor.blockKey)
    if (index === -1) {
      anchorRef.current = null // block removed (e.g. consolidation) — next scroll re-anchors
      return
    }
    const offset = virtualizer.getOffsetForIndex(index, 'start')
    const target = restoreScrollTop(anchor, offset?.[0])
    if (target !== null && Math.abs(el.scrollTop - target) > 1) {
      suppressScrollRef.current = true
      el.scrollTop = target
    }
  }, [totalSize, blocks, followBottom, isLoading, virtualizer])

  const onScroll = () => {
    const el = parentRef.current
    if (!el) return
    if (suppressScrollRef.current) {
      // our own programmatic restore — not a user gesture
      suppressScrollRef.current = false
      return
    }
    if (!didInitialScrollRef.current) return
    const near = isNearBottom(el.scrollTop, el.clientHeight, el.scrollHeight)
    if (near !== followBottom) setFollowBottom(near)
    anchorRef.current = computeAnchor(
      virtualizer
        .getVirtualItems()
        .map((vi) => ({ key: String(vi.key), start: vi.start, size: vi.size })),
      el.scrollTop,
    )
  }

  const renderBlock = (block: Block) => {
    switch (block.kind) {
      case 'sectionHeader':
        return (
          <SectionHeader
            workId={workId}
            section={block.section}
            ordinal={block.ordinal}
            depth={block.depth}
          />
        )
      case 'sectionBody':
        return (
          <SectionBlock
            workId={workId}
            section={block.section}
            fold={block.fold}
            matcher={matcher}
          />
        )
      case 'nameCard':
        return <NameCard workId={workId} section={block.section} />
      case 'snippet':
        return (
          <SnippetBlock
            workId={workId}
            snippet={block.snippet}
            matcher={matcher}
            readonly={readonly}
          />
        )
      case 'frontierBar':
        return <FrontierBar workId={workId} readonly={readonly} />
    }
  }

  return (
    <div className="doc-view-wrap">
      <div className="doc-view" data-testid={testids.docView} ref={parentRef} onScroll={onScroll}>
        {isLoading ? (
          <div
            className="doc-column"
            style={{ color: 'var(--fg-faint)', padding: 'var(--space-5)' }}
          >
            Loading…
          </div>
        ) : (
          <div style={{ height: totalSize, position: 'relative', width: '100%' }}>
            {items.map((vi) => {
              const block = blocks[vi.index]
              if (!block) return null
              return (
                <div
                  key={vi.key}
                  data-index={vi.index}
                  ref={virtualizer.measureElement}
                  style={{
                    left: 0,
                    position: 'absolute',
                    top: 0,
                    transform: `translateY(${vi.start}px)`,
                    width: '100%',
                  }}
                >
                  <div className="doc-column">{renderBlock(block)}</div>
                </div>
              )
            })}
          </div>
        )}
      </div>
      {!followBottom && !isLoading ? (
        <button
          type="button"
          className="jump-to-frontier"
          data-testid={testids.jumpToFrontier}
          onClick={() => setFollowBottom(true)}
        >
          ↓ frontier
        </button>
      ) : null}
      <WorldHovercard workId={workId} />
    </div>
  )
}
