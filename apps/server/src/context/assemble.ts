import type {
  BudgetKnobs,
  ContextSnapshot,
  ContextState,
  ElevatedItem,
  TaskSpec,
} from '@cowrite/shared'
import {
  type EntryFidelity,
  renderEntryItem,
  renderExcerptItem,
  renderSectionItem,
  renderSnippetItem,
  type SectionItem,
} from '../prompt/regions.js'
import { excerptText } from './anchors.js'
import { type DefaultMap, sectionFidelityTokens, worldFidelityTokens } from './defaults.js'
import type { TokenEstimator } from './estimate.js'
import type { RegionContent, TaskRegionContent } from './renderTypes.js'
import type { SnapshotSection, WorkSnapshot } from './snapshot.js'

/**
 * Prompt-region assembly (docs/06-context-engine.md §5): stability-ordered regions,
 * rendered byte-deterministically from (snapshot, ledger, map, spec). Elevated content
 * lives in its own append-ordered `<expanded-context>` region — never folded into the
 * skeleton — so elevations are pure appends and the cached prefix survives. Item markup
 * comes from prompt/regions.ts + prompt/tags.ts — the ONE grammar (07 §2.2), shared with
 * the template slots — so items read byte-identically everywhere. Note: adopting the
 * shared grammar dropped the redundant `fidelity="name"` attribute from name-fidelity
 * items (07 §2.2's spelling); that was a one-time cache-prefix reset for existing works.
 * Also produces the `ContextSnapshot` for the run's meta event.
 */

/** `<section>` markup for a snapshot row at a fidelity (07 §2.2 via the shared grammar). */
export function renderSectionSnapshotItem(
  section: SnapshotSection,
  fidelity: SectionItem['fidelity'],
  opts: { path?: boolean } = {},
): string {
  const item: SectionItem = {
    id: section.id,
    level: section.kind,
    name: section.name,
    ...(opts.path === true && section.path !== '' ? { path: section.path } : {}),
    fidelity,
  }
  if (fidelity !== 'name') {
    item.content =
      fidelity === 'full'
        ? (section.content ?? '')
        : fidelity === 'long'
          ? (section.longSummary ?? section.shortSummary ?? '')
          : (section.shortSummary ?? '')
  }
  return renderSectionItem(item)
}

/** `<entry>` markup for a world entry at a fidelity (shared grammar). */
export function renderWorldSnapshotItem(
  entry: { id: string; name: string; shortSummary: string | null; body: string },
  fidelity: EntryFidelity,
): string {
  return renderEntryItem({
    id: entry.id,
    name: entry.name,
    fidelity,
    ...(fidelity === 'name'
      ? {}
      : { content: fidelity === 'full' ? entry.body : (entry.shortSummary ?? '') }),
  })
}

/** The source text an elevation renders (also what `sourceHash` pins — 06 §10). */
export function elevatedSourceText(
  item: Pick<ElevatedItem, 'kind' | 'id' | 'fidelity'>,
  snapshot: WorkSnapshot,
): string | null {
  if (item.kind === 'section') {
    const s = snapshot.sectionById.get(item.id)
    if (s === undefined) return null
    if (item.fidelity === 'full') return s.content ?? s.longSummary ?? s.shortSummary ?? ''
    if (item.fidelity === 'long') return s.longSummary ?? s.shortSummary ?? ''
    if (item.fidelity === 'short') return s.shortSummary ?? ''
    return s.name
  }
  const e = snapshot.worldById.get(item.id)
  if (e === undefined) return null
  if (item.fidelity === 'full') return e.body
  return e.shortSummary ?? ''
}

function renderElevatedItem(item: ElevatedItem, snapshot: WorkSnapshot): string | null {
  if (item.kind === 'section') {
    const s = snapshot.sectionById.get(item.id)
    if (s === undefined) return null
    return renderSectionSnapshotItem(s, item.fidelity, { path: true })
  }
  const e = snapshot.worldById.get(item.id)
  if (e === undefined) return null
  const fidelity: EntryFidelity = item.fidelity === 'full' ? 'full' : 'short'
  return renderWorldSnapshotItem(e, fidelity)
}

export interface AssemblyInput {
  snapshot: WorkSnapshot
  state: ContextState
  map: DefaultMap
  knobs: BudgetKnobs
  spec: TaskSpec
  /** The `<instructions>` region body — renderer-owned wording (renderTypes.ts seam). */
  instructionsBody: string
  /** The `<task>` region — renderer-owned wording (templates are the ONE source). */
  task: TaskRegionContent
  est: TokenEstimator
  /** The work id (situation items use it as their id in the ContextSnapshot). */
  workId: string
}

export interface Assembly {
  /** Ordered, non-empty regions only (07 §2.1: empty regions are omitted entirely). */
  regions: RegionContent[]
  /** The typed provenance feed (shared runs.ts shape, values produced here). */
  contextSnapshot: ContextSnapshot
  totalTokens: number
  /** The `<local-context>` region body — the refresh turn's tail source (06 §5.3). */
  localContextBody: string
}

/** Token count of a region once wrapped in its tag lines. */
function regionTokens(name: string, body: string, est: TokenEstimator): number {
  return est.count(`<${name}>\n${body}\n</${name}>`)
}

export function assemble(input: AssemblyInput): Assembly {
  const { snapshot, state, map, spec, est } = input
  const regions: RegionContent[] = []
  const items: ContextSnapshot['items'] = []

  const push = (
    name: RegionContent['name'],
    body: string,
    regionAttrs?: Record<string, string>,
  ): void => {
    if (body === '') return
    regions.push({
      name,
      ...(regionAttrs === undefined ? {} : { attrs: regionAttrs }),
      body,
      tokens: regionTokens(name, body, est),
    })
  }

  // 1. <instructions> — static per task kind (renderer-owned wording).
  push('instructions', input.instructionsBody)

  // 2. <world-info> — all entries at map fidelity, entry-creation order.
  const worldBlocks: string[] = []
  for (const entry of snapshot.worldEntries) {
    const fidelity = map.world.get(entry.id) ?? 'name'
    worldBlocks.push(renderWorldSnapshotItem(entry, fidelity))
    items.push({
      id: entry.id,
      kind: 'world',
      fidelity,
      tokens: worldFidelityTokens(entry, fidelity, est),
      source: 'default',
    })
  }
  push('world-info', worldBlocks.join('\n'))

  // 3. <global-context> — section skeleton, document order, default fidelities only.
  const skeletonBlocks: string[] = []
  for (const section of snapshot.sections) {
    const fidelity = map.sections.get(section.id) ?? 'name'
    skeletonBlocks.push(renderSectionSnapshotItem(section, fidelity, { path: section.depth > 1 }))
    items.push({
      id: section.id,
      kind: 'section',
      fidelity,
      tokens: sectionFidelityTokens(section, fidelity, est),
      source: 'default',
    })
  }
  push('global-context', skeletonBlocks.join('\n'))

  // 4. <voice-anchors> — pinned excerpts.
  const anchorBlocks: string[] = []
  for (const excerpt of state.anchors.excerpts) {
    const section = snapshot.sectionById.get(excerpt.sectionId)
    if (section === undefined) continue
    const text = excerptText(excerpt, snapshot)
    if (text === '') continue
    anchorBlocks.push(renderExcerptItem({ from: section.name, tokens: excerpt.tokens, text }))
    items.push({
      id: excerpt.sectionId,
      kind: 'anchor',
      fidelity: 'full',
      tokens: excerpt.tokens,
      source: 'default',
    })
  }
  push('voice-anchors', anchorBlocks.join('\n'))

  // 5. <expanded-context> — ledger elevations, append order (06 §2.2).
  const expandedBlocks: string[] = []
  for (const item of state.elevated) {
    const rendered = renderElevatedItem(item, snapshot)
    if (rendered === null) continue
    expandedBlocks.push(rendered)
    items.push({
      id: item.id,
      kind: item.kind,
      fidelity: item.fidelity,
      tokens: item.tokens,
      source: item.source,
    })
  }
  push('expanded-context', expandedBlocks.join('\n'))

  // 6. <situation> — full, when non-empty.
  const situation = snapshot.situation.trim()
  if (situation !== '') {
    push('situation', snapshot.situation.trimEnd())
    items.push({
      id: input.workId,
      kind: 'situation',
      fidelity: 'full',
      tokens: est.count(snapshot.situation.trimEnd()),
      source: 'default',
    })
  }

  // 7. <task> — this task's directive (renderer/template wording, 07 §6.2–§6.3).
  const targetSnippetId =
    spec.kind === 'quick-edit' && spec.target.type === 'snippet' ? spec.target.snippetId : null
  push('task', input.task.body, input.task.attrs)

  // 8. <local-context> — all un-consolidated snippets, full prose, boundaries marked.
  const snippetBlocks: string[] = []
  for (const snippet of snapshot.snippets) {
    const isTarget = snippet.id === targetSnippetId
    const selection =
      isTarget && spec.kind === 'quick-edit'
        ? clampSelection(snippet.text, spec.selection.start, spec.selection.end)
        : undefined
    snippetBlocks.push(
      renderSnippetItem({
        id: snippet.id,
        text: snippet.text,
        ...(isTarget ? { editTarget: true } : {}),
        ...(selection === undefined ? {} : { selection }),
      }),
    )
    items.push({
      id: snippet.id,
      kind: 'snippet',
      fidelity: 'full',
      tokens: est.count(snippet.text),
      source: isTarget ? 'target' : 'default',
    })
  }
  const localContextBody = snippetBlocks.join('\n')
  push('local-context', localContextBody)

  const totalTokens = regions.reduce((sum, r) => sum + r.tokens, 0)
  return {
    regions,
    contextSnapshot: {
      regions: regions.map((r) => ({ name: r.name, tokens: r.tokens })),
      items,
    },
    totalTokens,
    localContextBody,
  }
}

/** Clamp a possibly-stale selection span into the target's current bounds (07 §2.4). */
export function clampSelection(
  text: string,
  start: number,
  end: number,
): { start: number; end: number } {
  const lo = Math.max(0, Math.min(start, text.length))
  const hi = Math.max(lo, Math.min(end, text.length))
  return { start: lo, end: hi }
}
