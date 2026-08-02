import type { SectionRow } from '@cowrite/shared'
import { api } from '@cowrite/shared'
import { useSectionContent } from '../../api/queries.js'
import { Markdown } from '../../render/Markdown.js'
import type { WorldMatcher } from '../../render/worldMatcher.js'
import type { FoldLevel } from '../../state/docUiStore.js'
import { testids } from '../../testids.js'

/**
 * One section body at its fold level (docs/04-frontend.md §5.2, §5.6). At `full` the leaf
 * prose is fetched lazily (staleTime Infinity — SSE invalidates on contentHash change) and a
 * word-count-sized skeleton holds the space so anchoring math already holds. Summaries render
 * at long/short once they exist (Stage 4). Illustrations sit in aspect-ratio reserved boxes
 * so image loads never shift layout (§5.5, §10 — pixels arrive Stage 5).
 */

const WORDS_PER_LINE = 11
const LINE_PX = 28

export interface SectionBlockProps {
  workId: string
  section: SectionRow
  fold: Exclude<FoldLevel, 'name'>
  matcher: WorldMatcher | null
}

function IllustrationBox({ workId, section }: { workId: string; section: SectionRow }) {
  const illustration = section.illustration
  if (!illustration) return null
  return (
    <figure
      className="section-illustration"
      style={{ aspectRatio: `${illustration.width} / ${illustration.height}` }}
    >
      <img
        src={`${api.getSectionIllustration.path(workId, section.id)}?v=${illustration.version}`}
        alt={section.title ?? 'Section illustration'}
        width={illustration.width}
        height={illustration.height}
      />
    </figure>
  )
}

export function SectionBlock({ workId, section, fold, matcher }: SectionBlockProps) {
  const content = useSectionContent(workId, section.id, fold === 'full' && section.isLeaf)

  if (fold !== 'full') {
    const summary = fold === 'long' ? section.longSummary : section.shortSummary
    return (
      <div className="section-block prose" data-testid={testids.sectionBlock} data-fold={fold}>
        <IllustrationBox workId={workId} section={section} />
        <Markdown markdown={summary ?? ''} matcher={matcher} />
      </div>
    )
  }

  if (content.data === undefined) {
    // skeleton sized by the word-count estimate — anchoring math already holds (§5.6)
    const height = Math.max(LINE_PX * 2, Math.ceil(section.wordCount / WORDS_PER_LINE) * LINE_PX)
    return (
      <div
        className="section-skeleton"
        data-testid={testids.sectionSkeleton}
        style={{ height }}
        aria-hidden
      />
    )
  }

  return (
    <div className="section-block prose" data-testid={testids.sectionBlock} data-fold="full">
      <IllustrationBox workId={workId} section={section} />
      <Markdown markdown={content.data.markdown} matcher={matcher} />
    </div>
  )
}
