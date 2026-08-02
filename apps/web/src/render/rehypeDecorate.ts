import { detectDialogue } from './dialogue.js'
import { type KeyMatch, pickNonOverlapping, type WorldMatcher } from './worldMatcher.js'

/**
 * The one decoration pass (docs/04-frontend.md §6.2): a rehype plugin that walks the hast
 * tree once per block and splits text nodes into spans — dialogue ranges (`span.dlg`) and
 * world-key matches (`span.wi`, carrying the entry id) in a single traversal. The custom
 * `components` map in Markdown.tsx renders the spans with handlers.
 *
 * Minimal structural hast types are declared locally — the tree shape is stable and pulling
 * in @types/hast for four fields buys nothing.
 */

export interface HastText {
  type: 'text'
  value: string
}

export interface HastElement {
  type: 'element'
  tagName: string
  properties?: Record<string, unknown>
  children: HastNode[]
}

export type HastNode = HastText | HastElement | { type: string; children?: HastNode[] }

export interface HastRoot {
  type: 'root'
  children: HastNode[]
}

export interface DecorateOptions {
  matcher?: WorldMatcher | null
}

/** Paragraph-scoped containers: dialogue state is computed per one of these. */
const PARAGRAPH_TAGS = new Set(['p', 'li', 'h1', 'h2', 'h3', 'h4'])
/** Subtrees whose text is never decorated. */
const SKIP_TAGS = new Set(['code', 'pre'])

function isElement(node: HastNode): node is HastElement {
  return node.type === 'element'
}

function isText(node: HastNode): node is HastText {
  return node.type === 'text'
}

interface TextSlot {
  parent: HastElement
  node: HastText
  /** Offset of this node's text within the joined paragraph text. */
  start: number
}

function collectText(el: HastElement, slots: TextSlot[], offset: { value: number }): void {
  for (const child of el.children) {
    if (isText(child)) {
      slots.push({ parent: el, node: child, start: offset.value })
      offset.value += child.value.length
    } else if (isElement(child) && !SKIP_TAGS.has(child.tagName)) {
      collectText(child, slots, offset)
    }
  }
}

function containsParagraph(el: HastElement): boolean {
  return el.children.some(
    (c) => isElement(c) && (PARAGRAPH_TAGS.has(c.tagName) || containsParagraph(c)),
  )
}

function makeSpan(text: string, dlg: boolean, wi: KeyMatch | null): HastElement {
  const className: string[] = []
  if (dlg) className.push('dlg')
  if (wi) className.push('wi')
  const properties: Record<string, unknown> = { className }
  if (wi) properties.dataEntryId = wi.entryId
  return { type: 'element', tagName: 'span', properties, children: [{ type: 'text', value: text }] }
}

function decorateParagraph(el: HastElement, matcher: WorldMatcher | null | undefined): void {
  const slots: TextSlot[] = []
  collectText(el, slots, { value: 0 })
  if (slots.length === 0) return
  const fullText = slots.map((s) => s.node.value).join('')

  const dlgRanges = detectDialogue(fullText)
  const wiMatches = matcher ? pickNonOverlapping(matcher.match(fullText)) : []
  if (dlgRanges.length === 0 && wiMatches.length === 0) return

  // split each text node at every range boundary that falls inside it
  const replacements = new Map<HastText, HastNode[]>()
  for (const slot of slots) {
    const nodeStart = slot.start
    const nodeEnd = slot.start + slot.node.value.length
    const cuts = new Set<number>([nodeStart, nodeEnd])
    for (const [s, e] of dlgRanges) {
      if (s > nodeStart && s < nodeEnd) cuts.add(s)
      if (e > nodeStart && e < nodeEnd) cuts.add(e)
    }
    for (const m of wiMatches) {
      if (m.start > nodeStart && m.start < nodeEnd) cuts.add(m.start)
      if (m.end > nodeStart && m.end < nodeEnd) cuts.add(m.end)
    }
    const points = [...cuts].sort((a, b) => a - b)
    const parts: HastNode[] = []
    let plainOnly = true
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i] as number
      const b = points[i + 1] as number
      const text = fullText.slice(a, b)
      const dlg = dlgRanges.some(([s, e]) => s <= a && b <= e)
      const wi = wiMatches.find((m) => m.start <= a && b <= m.end) ?? null
      if (dlg || wi) {
        parts.push(makeSpan(text, dlg, wi))
        plainOnly = false
      } else {
        parts.push({ type: 'text', value: text })
      }
    }
    if (!plainOnly) replacements.set(slot.node, parts)
  }
  if (replacements.size === 0) return

  const parents = new Set(slots.map((s) => s.parent))
  for (const parent of parents) {
    const next: HastNode[] = []
    for (const child of parent.children) {
      const replacement = isText(child) ? replacements.get(child) : undefined
      if (replacement) next.push(...replacement)
      else next.push(child)
    }
    parent.children = next
  }
}

/**
 * Plugin factory: `rehypePlugins={[[rehypeDecorate, { matcher }]]}`. Processes the deepest
 * paragraph-scope containers (a `li` containing a `p` defers to the `p`).
 */
export function rehypeDecorate(options: DecorateOptions = {}) {
  const transform = (node: HastNode | HastRoot): void => {
    const children = 'children' in node ? node.children : undefined
    if (!children) return
    for (const child of children) {
      if (!isElement(child)) continue
      if (SKIP_TAGS.has(child.tagName)) continue
      if (PARAGRAPH_TAGS.has(child.tagName) && !containsParagraph(child)) {
        decorateParagraph(child, options.matcher)
      } else {
        transform(child)
      }
    }
  }
  return (tree: HastRoot) => {
    transform(tree)
  }
}
