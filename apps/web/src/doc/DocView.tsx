import { useVirtualizer } from '@tanstack/react-virtual'
import { useLayoutEffect, useRef } from 'react'
import { WorldHovercard } from '../render/Hovercard.js'
import { useWorldMatcher } from '../render/Markdown.js'
import { useDocUiStore } from '../state/docUiStore.js'
import { testids } from '../testids.js'
import {
  computeAnchor,
  fallbackAnchorKey,
  isNearBottom,
  restoreScrollTop,
  type ScrollAnchor,
} from './anchoring.js'
import { FrontierBar } from './blocks/FrontierBar.js'
import { NameCard } from './blocks/NameCard.js'
import { SectionBlock } from './blocks/SectionBlock.js'
import { SectionHeader } from './blocks/SectionHeader.js'
import { SnippetBlock } from './blocks/SnippetBlock.js'
import { type Block, estimateBlockSize, useDocBlocks } from './useDocBlocks.js'

/**
 * The document view (docs/04-frontend.md §5): one @tanstack/react-virtual surface over the
 * whole work with `overflow-anchor: none` — we own anchoring. Opening a work lands at the
 * frontier (followBottom); scrolling up breaks it; the "↓ frontier" pill or End restores it.
 * After any re-layout (lazy text arriving, image loads, fold changes) the topmost visible
 * block is restored to its exact viewport offset — unless followBottom wins. When the
 * anchored block itself disappears (consolidation consumed it), the anchor falls back to
 * the nearest surviving neighbor so a restructure never teleports the viewport (§5.5).
 */

export interface DocViewProps {
  workId: string
  readonly?: boolean
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
  /** Block-key order of the last committed layout — feeds the removed-anchor fallback. */
  const prevKeysRef = useRef<string[]>([])

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
    const prevKeys = prevKeysRef.current
    prevKeysRef.current = blocks.map((b) => b.key)
    if (followBottom) {
      suppressScrollRef.current = true
      el.scrollTop = el.scrollHeight
      didInitialScrollRef.current = true
      return
    }
    const captured = anchorRef.current
    if (!captured) return
    let anchor: ScrollAnchor = captured
    let index = blocks.findIndex((b) => b.key === captured.blockKey)
    if (index === -1) {
      // The anchored block was removed (consolidation consumed it): fall back to the
      // nearest surviving neighbor from the previous layout, offset 0 (§5.5) — the
      // viewport stays in the neighborhood instead of teleporting.
      const fallback = fallbackAnchorKey(prevKeys, new Set(prevKeysRef.current), captured.blockKey)
      if (fallback === null) {
        anchorRef.current = null // nothing survived — next scroll re-anchors
        return
      }
      anchor = { blockKey: fallback, offsetPx: 0 }
      anchorRef.current = anchor
      index = blocks.findIndex((b) => b.key === fallback)
    }
    const offset = virtualizer.getOffsetForIndex(index, 'start')
    const target = restoreScrollTop(anchor, offset?.[0])
    if (target !== null && Math.abs(el.scrollTop - target) > 1) {
      suppressScrollRef.current = true
      el.scrollTop = target
    }
  }, [totalSize, blocks, followBottom, isLoading, virtualizer])

  /**
   * §5.5 "expanding a section you clicked": the fold widget re-anchors to ITS header (at
   * the header's current viewport offset) before the pin mutates layout, so the section
   * being (un)folded stays put while everything below grows. Reading a fold change is an
   * explicit act of looking away from the frontier, so stickiness yields.
   */
  const anchorToSection = (sectionId: string) => {
    const el = parentRef.current
    if (!el) return
    const key = `h:${sectionId}`
    const index = blocks.findIndex((b) => b.key === key)
    if (index === -1) return
    const offset = virtualizer.getOffsetForIndex(index, 'start')
    if (offset === undefined) return
    anchorRef.current = { blockKey: key, offsetPx: offset[0] - el.scrollTop }
    if (followBottom) setFollowBottom(false)
  }

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
            fold={block.fold}
            onBeforeFoldChange={anchorToSection}
            readonly={readonly}
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
        return <NameCard workId={workId} section={block.section} ordinal={block.ordinal} />
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
