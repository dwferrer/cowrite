import type { SectionRow, SnippetDto } from '@cowrite/shared'
import { useMemo } from 'react'
import { byOrderKey, useSections, useSnippets } from '../api/queries.js'
import type { FoldLevel } from '../state/docUiStore.js'
import { usePanelStore } from '../state/panelStore.js'
import { effectiveFold } from './foldPolicy.js'

/**
 * Flattens server state into the render list the virtualizer consumes
 * (docs/04-frontend.md §5.2): sections in document order (parent before children, orderKey
 * sort), header and body as separate blocks, then all frontier snippets by orderKey, then the
 * frontier bar. A pure memo over (sections, snippets, foldOverrides).
 *
 * Stage 2 note: with no summaries yet, every leaf resolves to fold `full` (foldPolicy
 * degradation) — the ladder rendering proper is Stage 4; the model is already shaped for it.
 * The streaming display (Stage 3) renders inside the frontierBar block (FrontierBar mounts
 * StreamingBlock above its controls), so it needs no block kind of its own — the
 * virtualizer's measureElement absorbs its growth.
 */

export type Block =
  | {
      kind: 'sectionHeader'
      key: string
      section: SectionRow
      fold: FoldLevel
      depth: number
      ordinal: number
    }
  | { kind: 'sectionBody'; key: string; section: SectionRow; fold: Exclude<FoldLevel, 'name'> }
  | { kind: 'nameCard'; key: string; section: SectionRow; ordinal: number }
  | { kind: 'snippet'; key: string; snippet: SnippetDto }
  | { kind: 'frontierBar'; key: string }

export function buildBlocks(
  sections: readonly SectionRow[],
  snippets: readonly SnippetDto[],
  foldOverrides: Record<string, FoldLevel | 'auto'>,
): Block[] {
  const childrenOf = new Map<string | null, SectionRow[]>()
  for (const row of sections) {
    const list = childrenOf.get(row.parentId) ?? []
    list.push(row)
    childrenOf.set(row.parentId, list)
  }
  for (const list of childrenOf.values()) list.sort(byOrderKey)

  // document order (parent before children), remembering depth and per-kind ordinals
  const ordered: Array<{ row: SectionRow; depth: number; ordinal: number }> = []
  const kindCounts = new Map<string, number>()
  const walk = (parentId: string | null, depth: number) => {
    for (const row of childrenOf.get(parentId) ?? []) {
      const ordinal = (kindCounts.get(row.kind) ?? 0) + 1
      kindCounts.set(row.kind, ordinal)
      ordered.push({ row, depth, ordinal })
      walk(row.id, depth + 1)
    }
  }
  walk(null, 0)

  // distance metric: number of leaf sections between a leaf and the frontier (04 §5.3)
  const leaves = ordered.filter((e) => e.row.isLeaf)
  const leafDistance = new Map<string, number>()
  for (const [i, e] of leaves.entries()) leafDistance.set(e.row.id, leaves.length - 1 - i)

  const foldOf = new Map<string, FoldLevel>()
  for (const e of leaves) {
    foldOf.set(e.row.id, effectiveFold(e.row, leafDistance.get(e.row.id) ?? 0, foldOverrides))
  }
  // interior sections collapse to one card when ALL descendant leaves are name (04 §5.3);
  // computed bottom-up over the ordered list (children appear after their parent).
  const interiorAllName = new Map<string, boolean>()
  for (let i = ordered.length - 1; i >= 0; i--) {
    const e = ordered[i]
    if (!e || e.row.isLeaf) continue
    const kids = childrenOf.get(e.row.id) ?? []
    const allName =
      kids.length > 0 &&
      kids.every((k) =>
        k.isLeaf ? foldOf.get(k.id) === 'name' : (interiorAllName.get(k.id) ?? false),
      )
    interiorAllName.set(e.row.id, allName)
  }

  const blocks: Block[] = []
  const collapsedRoots = new Set<string>()
  const isInsideCollapsed = (row: SectionRow) =>
    row.parentId !== null && collapsedRoots.has(row.parentId)
  const collapsedSubtree = new Set<string>()
  for (const e of ordered) {
    if (e.row.parentId !== null && collapsedSubtree.has(e.row.parentId)) {
      collapsedSubtree.add(e.row.id)
      continue
    }
    if (!e.row.isLeaf) {
      if (interiorAllName.get(e.row.id)) {
        // the whole part collapses to one card; skip the subtree
        blocks.push({ kind: 'nameCard', key: `n:${e.row.id}`, section: e.row, ordinal: e.ordinal })
        collapsedRoots.add(e.row.id)
        collapsedSubtree.add(e.row.id)
        continue
      }
      blocks.push({
        kind: 'sectionHeader',
        key: `h:${e.row.id}`,
        section: e.row,
        fold: 'full',
        depth: e.depth,
        ordinal: e.ordinal,
      })
      continue
    }
    if (isInsideCollapsed(e.row)) continue
    const fold = foldOf.get(e.row.id) ?? 'full'
    blocks.push({
      kind: 'sectionHeader',
      key: `h:${e.row.id}`,
      section: e.row,
      fold,
      depth: e.depth,
      ordinal: e.ordinal,
    })
    if (fold === 'name') {
      blocks.push({ kind: 'nameCard', key: `n:${e.row.id}`, section: e.row, ordinal: e.ordinal })
    } else {
      blocks.push({ kind: 'sectionBody', key: `b:${e.row.id}`, section: e.row, fold })
    }
  }

  for (const snippet of [...snippets].sort(byOrderKey)) {
    blocks.push({ kind: 'snippet', key: `s:${snippet.id}`, snippet })
  }
  blocks.push({ kind: 'frontierBar', key: 'frontier' })
  return blocks
}

// ---------------------------------------------------------------------------
// Height estimates (04 §5.4) — px, from block kind before first measurement;
// measureElement corrects them as blocks mount.
// ---------------------------------------------------------------------------

const WORDS_PER_LINE = 11 // at 65ch / 17px — measured, not folklore
const LINE_PX = 28

export function countWords(text: string): number {
  const matches = text.match(/\S+/g)
  return matches ? matches.length : 0
}

export function estimateBlockSize(block: Block): number {
  switch (block.kind) {
    case 'sectionHeader':
      return 44
    case 'nameCard':
      return 96
    case 'frontierBar':
      return 88
    case 'snippet':
      return 72 + Math.ceil(countWords(block.snippet.text) / WORDS_PER_LINE) * LINE_PX
    case 'sectionBody': {
      if (block.fold === 'full') {
        return 72 + Math.ceil(block.section.wordCount / WORDS_PER_LINE) * LINE_PX
      }
      if (block.fold === 'long') {
        const words = countWords(block.section.longSummary ?? '')
        return 72 + Math.ceil(words / WORDS_PER_LINE) * LINE_PX
      }
      return 140 // short: ~3 lines
    }
  }
}

export interface DocBlocksResult {
  blocks: Block[]
  isLoading: boolean
}

export function useDocBlocks(workId: string): DocBlocksResult {
  const sections = useSections(workId)
  const snippets = useSnippets(workId)
  const foldOverrides = usePanelStore((s) => s.byWork[workId]?.foldOverrides)

  const blocks = useMemo(
    () => buildBlocks(sections.data ?? [], snippets.data ?? [], foldOverrides ?? {}),
    [sections.data, snippets.data, foldOverrides],
  )

  return { blocks, isLoading: sections.isLoading || snippets.isLoading }
}
