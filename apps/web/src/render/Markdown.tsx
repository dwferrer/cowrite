import { memo, useMemo, useRef } from 'react'
import ReactMarkdown, { type Components, type Options } from 'react-markdown'
import { useNavigate, useParams } from 'react-router'
import remarkGfm from 'remark-gfm'
import { useWorld } from '../api/queries.js'
import { HOVER_OPEN_DELAY_MS, useHovercardStore } from './Hovercard.js'
import { rehypeDecorate } from './rehypeDecorate.js'
import { buildWorldMatcher, type WorldMatcher } from './worldMatcher.js'

/**
 * The per-work key matcher, rebuilt only when the world list cache changes (the list is
 * refetched on `world.changed` — its array identity is the effective worldVersion, 04 §6.3).
 */
export function useWorldMatcher(workId: string): WorldMatcher | null {
  const world = useWorld(workId)
  return useMemo(() => (world.data ? buildWorldMatcher(world.data) : null), [world.data])
}

/**
 * The markdown renderer (docs/04-frontend.md §6.1): react-markdown + remark-gfm, one
 * memoized instance per block. Raw HTML is skipped, links render as plain text with the URL
 * in a tooltip, and the allowed-element list is the prose set. The rehypeDecorate pass adds
 * dialogue tint and world-key spans; the `components` map below gives those spans handlers.
 */

const ALLOWED_ELEMENTS = [
  'p',
  'em',
  'strong',
  'del',
  'h1',
  'h2',
  'h3',
  'h4',
  'blockquote',
  'ul',
  'ol',
  'li',
  'hr',
  'code',
  'pre',
  'br',
  'a',
  'span',
]

/** Links render as plain text with the URL in a tooltip — this is a novel, not a wiki. */
function PlainLink(props: { href?: string; children?: React.ReactNode }) {
  return <span title={props.href}>{props.children}</span>
}

type SpanProps = React.HTMLAttributes<HTMLSpanElement> & { 'data-entry-id'?: string }

/** Renders `span.wi` (hovercard + navigate) and `span.dlg` (tint only) from rehypeDecorate. */
function DecoratedSpan({ className, children, ...rest }: SpanProps) {
  const entryId = rest['data-entry-id']
  const params = useParams<{ workId: string }>()
  const navigate = useNavigate()
  const show = useHovercardStore((s) => s.show)
  const hide = useHovercardStore((s) => s.hide)
  const openTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  if (!entryId || !className?.includes('wi')) {
    return <span className={className}>{children}</span>
  }

  const workId = params.workId ?? ''
  const openEntry = () => navigate(`/w/${workId}/world/${entryId}`)
  return (
    // biome-ignore lint/a11y/useSemanticElements: an <a> inside rendered prose would collide with the markdown link renderer (links render as plain text, §6.1); this span navigates programmatically
    <span
      className={className}
      role="link"
      tabIndex={0}
      data-entry-id={entryId}
      style={{ cursor: 'pointer' }}
      onMouseEnter={(e) => {
        const target = e.currentTarget
        openTimer.current = setTimeout(() => show(entryId, target), HOVER_OPEN_DELAY_MS)
      }}
      onMouseLeave={() => {
        if (openTimer.current !== undefined) clearTimeout(openTimer.current)
        hide()
      }}
      onClick={openEntry}
      onKeyDown={(e) => {
        if (e.key === 'Enter') openEntry()
      }}
    >
      {children}
    </span>
  )
}

const components: Components = {
  a: PlainLink,
  span: DecoratedSpan,
}

export interface MarkdownProps {
  markdown: string
  /** The shared per-work Aho–Corasick matcher; null disables world-key decoration. */
  matcher?: WorldMatcher | null
}

/**
 * Memoized per block: re-renders only when the text or the matcher instance changes (the
 * matcher is rebuilt when the world list changes — that reference is the `worldVersion`).
 */
export const Markdown = memo(function Markdown({ markdown, matcher }: MarkdownProps) {
  const rehypePlugins = useMemo(
    () => [[rehypeDecorate, { matcher: matcher ?? null }]] as unknown as Options['rehypePlugins'],
    [matcher],
  )
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={rehypePlugins}
      allowedElements={ALLOWED_ELEMENTS}
      unwrapDisallowed
      skipHtml
      components={components}
    >
      {markdown}
    </ReactMarkdown>
  )
})
