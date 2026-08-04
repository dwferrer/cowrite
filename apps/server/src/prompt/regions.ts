import type { Fidelity } from '@cowrite/shared'
import {
  closeTagLine,
  openTagLine,
  type RegionTagName,
  selfClosingTagLine,
  type TagAttrs,
  tagBlock,
} from './tags.js'

/**
 * Region assembly (docs/07-prompting.md §2, §5; ordering owned by docs/06-context-engine.md
 * §5.1). Typed inputs — the shapes a context engine hands over — become exact markup strings.
 *
 * Everything here is a pure string computation: identical inputs render byte-identical output
 * (golden-tested), because region bytes feed the prefix cache and `cache_break` accounting.
 * Prose content passes through verbatim; only attribute values are sanitized (tags.ts).
 *
 * Empty regions are omitted entirely — renderers return `null`, never `<tag></tag>` husks
 * (§2.1: "an empty region is a byte-churn liability and reads as noise").
 */

// ---------------------------------------------------------------------------
// Item inputs (§2.2)
// ---------------------------------------------------------------------------

/** World entries have no `long` fidelity (§2.2). */
export type EntryFidelity = 'name' | 'short' | 'full'

export interface WorldEntryItem {
  id: string
  name: string
  fidelity: EntryFidelity
  /** one-line summary (`short`) or full Markdown body (`full`); absent at `name` fidelity */
  content?: string
}

export interface SectionItem {
  id: string
  /** e.g. `chapter` */
  level?: string
  name?: string
  /** ancestor names joined by ` › ` — present in `<expanded-context>` and deep skeleton entries */
  path?: string
  fidelity: Fidelity
  /** summary at `short`/`long`, the section's content.md verbatim at `full`; absent at `name` */
  content?: string
}

/** Voice anchor (06 §anchors). Token count is stable between anchor refreshes. */
export interface ExcerptItem {
  from: string
  tokens: number
  text: string
}

/** Character span within a snippet's text; `end` exclusive. */
export interface SelectionSpan {
  start: number
  end: number
}

export interface SnippetItem {
  id: string
  text: string
  /** marks the quick-edit target in place: `role="edit-target"` (§2.4) */
  editTarget?: boolean
  /** brackets the user's selected characters with inline `<selection>…</selection>` (§2.4) */
  selection?: SelectionSpan
}

export type ExpandedItem =
  | ({ kind: 'section' } & SectionItem)
  | ({ kind: 'entry' } & WorldEntryItem)

export interface ImageryItem {
  /** source section or entry name */
  from: string
  /** one prior winning image prompt */
  text: string
}

// ---------------------------------------------------------------------------
// Item renderers (exported: template slots like {{matchedEntries}} are filled
// with exactly these strings, so items read identically everywhere — §1.1)
// ---------------------------------------------------------------------------

function requireContent(content: string | undefined, what: string): string {
  if (content === undefined) {
    throw new Error(`prompt render: ${what} requires content at fidelity above "name"`)
  }
  return content
}

/** `<entry id name fidelity>` block; self-closing one-liner at `name` fidelity (§2.2). */
export function renderEntryItem(entry: WorldEntryItem): string {
  const attrs: TagAttrs = [
    ['id', entry.id],
    ['name', entry.name],
  ]
  if (entry.fidelity === 'name') return selfClosingTagLine('entry', attrs)
  return tagBlock(
    'entry',
    [...attrs, ['fidelity', entry.fidelity]],
    requireContent(entry.content, `entry ${entry.id}`),
  )
}

/**
 * `<section id level? name? path? fidelity>` block; at `fidelity="name"` a self-closing
 * one-liner without the fidelity attribute, per §2.2's example.
 */
export function renderSectionItem(section: SectionItem): string {
  const attrs: [string, string][] = [['id', section.id]]
  if (section.level !== undefined) attrs.push(['level', section.level])
  if (section.name !== undefined) attrs.push(['name', section.name])
  if (section.path !== undefined) attrs.push(['path', section.path])
  if (section.fidelity === 'name') return selfClosingTagLine('section', attrs)
  attrs.push(['fidelity', section.fidelity])
  return tagBlock('section', attrs, requireContent(section.content, `section ${section.id}`))
}

export function renderExcerptItem(excerpt: ExcerptItem): string {
  return tagBlock(
    'excerpt',
    [
      ['from', excerpt.from],
      ['tokens', String(excerpt.tokens)],
    ],
    excerpt.text,
  )
}

/** Inserts the inline `<selection>…</selection>` pair — the only inline tag pair (§2.4). */
export function insertSelectionMarkers(text: string, selection: SelectionSpan): string {
  const { start, end } = selection
  if (start < 0 || end < start || end > text.length) {
    throw new Error(`prompt render: selection span ${start}..${end} out of range 0..${text.length}`)
  }
  return `${text.slice(0, start)}<selection>${text.slice(start, end)}</selection>${text.slice(end)}`
}

export function renderSnippetItem(snippet: SnippetItem): string {
  const attrs: [string, string][] = [['id', snippet.id]]
  if (snippet.editTarget) attrs.push(['role', 'edit-target'])
  const text = snippet.selection
    ? insertSelectionMarkers(snippet.text, snippet.selection)
    : snippet.text
  return tagBlock('snippet', attrs, text)
}

export function renderImageryItem(item: ImageryItem): string {
  return tagBlock('imagery', [['from', item.from]], item.text)
}

export function renderExpandedItem(item: ExpandedItem): string {
  return item.kind === 'section' ? renderSectionItem(item) : renderEntryItem(item)
}

// ---------------------------------------------------------------------------
// Region renderers — items back-to-back (no blank line between items, per the
// §4 worked example); `null` when the region is empty.
// ---------------------------------------------------------------------------

/** Region wrapper: open tag line, items/content lines, close tag line. */
export function renderRegion(tag: RegionTagName, parts: readonly string[]): string | null {
  if (parts.length === 0) return null
  return `${openTagLine(tag)}\n${parts.join('\n')}\n${closeTagLine(tag)}`
}

export function renderWorldInfo(entries: readonly WorldEntryItem[]): string | null {
  return renderRegion('world-info', entries.map(renderEntryItem))
}

export function renderGlobalContext(sections: readonly SectionItem[]): string | null {
  return renderRegion('global-context', sections.map(renderSectionItem))
}

export function renderVoiceAnchors(excerpts: readonly ExcerptItem[]): string | null {
  return renderRegion('voice-anchors', excerpts.map(renderExcerptItem))
}

export function renderExpandedContext(items: readonly ExpandedItem[]): string | null {
  return renderRegion('expanded-context', items.map(renderExpandedItem))
}

/** The situation pane, verbatim Markdown; omitted when blank (§2.1). */
export function renderSituation(markdown: string): string | null {
  if (markdown.trim() === '') return null
  return tagBlock('situation', [], markdown)
}

export function renderLocalContext(snippets: readonly SnippetItem[]): string | null {
  return renderRegion('local-context', snippets.map(renderSnippetItem))
}

/** The refresh turn's region — verbatim tail of `<local-context>` (06 §refresh, 07 §6.7). */
export function renderLocalContextRefresh(tail: string): string {
  return tagBlock('local-context-refresh', [], tail)
}

// ---------------------------------------------------------------------------
// Assembly (06 §5.1 canonical order; one blank line between regions — §1.1)
// ---------------------------------------------------------------------------

/**
 * Everything the first user message of an interactive task contains. `instructionsMarkup` and
 * `taskMarkup` arrive pre-rendered from the template set (templates own the wording, including
 * their region tags); engine-fed regions arrive as typed items. `targetMarkup` is the seam for
 * M2 frozen-section windows and background kinds.
 */
export interface PromptRegions {
  instructionsMarkup: string
  worldInfo?: readonly WorldEntryItem[]
  globalContext?: readonly SectionItem[]
  voiceAnchors?: readonly ExcerptItem[]
  expandedContext?: readonly ExpandedItem[]
  situation?: string
  taskMarkup: string
  localContext?: readonly SnippetItem[]
  targetMarkup?: string
}

/** Strips framing newlines from pre-rendered markup (template files end with `\n`). */
function frame(markup: string | null | undefined): string | null {
  if (markup === undefined || markup === null) return null
  const stripped = markup.replace(/^\n+/, '').replace(/\n+$/, '')
  return stripped === '' ? null : stripped
}

/**
 * Concatenates the non-empty regions in 06 §5.1's canonical order with one blank line between
 * regions. Byte-deterministic: identical inputs yield identical bytes, no trailing newline.
 */
export function assembleUserMessage(regions: PromptRegions): string {
  const parts: Array<string | null> = [
    frame(regions.instructionsMarkup),
    renderWorldInfo(regions.worldInfo ?? []),
    renderGlobalContext(regions.globalContext ?? []),
    renderVoiceAnchors(regions.voiceAnchors ?? []),
    renderExpandedContext(regions.expandedContext ?? []),
    regions.situation === undefined ? null : renderSituation(regions.situation),
    frame(regions.taskMarkup),
    renderLocalContext(regions.localContext ?? []),
    frame(regions.targetMarkup),
  ]
  return parts.filter((part): part is string => part !== null).join('\n\n')
}
