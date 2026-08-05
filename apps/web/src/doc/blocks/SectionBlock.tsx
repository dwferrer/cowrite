import type { SectionRow } from '@cowrite/shared'
import { useSectionContent } from '../../api/queries.js'
import { Markdown } from '../../render/Markdown.js'
import type { WorldMatcher } from '../../render/worldMatcher.js'
import type { FoldLevel } from '../../state/docUiStore.js'
import { useIllustrationFailure, useIllustrationTask } from '../../state/taskStore.js'
import { testids } from '../../testids.js'
import { IllustrationOverlay } from './IllustrationOverlay.js'
import { useSectionIllustration } from './useSectionIllustration.js'

/**
 * One section body at its fold level (docs/04-frontend.md §5.2, §5.6). At `full` the leaf
 * prose is fetched lazily (staleTime Infinity — SSE invalidates on contentHash change) and a
 * word-count-sized skeleton holds the space so anchoring math already holds. Summaries render
 * at long/short once they exist (Stage 4). Illustrations sit in aspect-ratio reserved boxes so
 * image loads never shift layout (§5.5, §10): `full` floats a 320px box right of the prose,
 * `long`/`short` show a 96px thumbnail top-right. Both carry the shimmer overlay while
 * `illustrate-section` runs and open the lightbox on click.
 */

const WORDS_PER_LINE = 11
const LINE_PX = 28

export interface SectionBlockProps {
  workId: string
  section: SectionRow
  fold: Exclude<FoldLevel, 'name'>
  matcher: WorldMatcher | null
}

function IllustrationBox({
  workId,
  section,
  thumb,
}: {
  workId: string
  section: SectionRow
  thumb: boolean
}) {
  const { illustration, illustrate, src, openLightbox, lightbox } = useSectionIllustration(
    workId,
    section,
  )
  // A live task or a recorded failure still reserves the box even with no committed image yet
  // (§8: "generation in progress → shimmer overlay on the reserved box").
  const task = useIllustrationTask('section', section.id)
  const failure = useIllustrationFailure('section', section.id)
  if (!illustration && task === null && failure === null) return null

  const title = section.title ?? 'Section illustration'

  return (
    <>
      <figure
        className={
          thumb ? 'section-illustration section-illustration--thumb' : 'section-illustration'
        }
        // No committed image yet (mid-generation or a failed first attempt): reserve a
        // placeholder aspect ratio so the shimmer/badge has somewhere to render (§10).
        style={{
          aspectRatio: illustration ? `${illustration.width} / ${illustration.height}` : '4 / 3',
        }}
      >
        {src ? (
          // biome-ignore lint/a11y/useKeyWithClickEvents: opens the read-only lightbox; the section menu offers the same action to keyboard users
          <img
            data-testid={testids.illustrationImage}
            src={src}
            alt={title}
            width={illustration?.width}
            height={illustration?.height}
            onClick={openLightbox}
          />
        ) : null}
        <IllustrationOverlay
          targetKind="section"
          targetId={section.id}
          onRetry={() => illustrate.run(section.id)}
          retryDisabled={illustrate.pending}
        />
      </figure>
      {lightbox(title)}
    </>
  )
}

export function SectionBlock({ workId, section, fold, matcher }: SectionBlockProps) {
  const content = useSectionContent(workId, section.id, fold === 'full' && section.isLeaf)

  if (fold !== 'full') {
    const summary = fold === 'long' ? section.longSummary : section.shortSummary
    return (
      <div className="section-block prose" data-testid={testids.sectionBlock} data-fold={fold}>
        <IllustrationBox workId={workId} section={section} thumb />
        <Markdown markdown={summary ?? ''} matcher={matcher} />
        {/* subtle fidelity affordance (04 §5.1): this is a summary, not the prose */}
        <span
          className="section-block__fold-hint"
          data-testid={testids.sectionFoldHint}
          title={`Collapsed to the ${fold} summary — expand with the fold dots in the heading`}
        >
          {fold} summary
        </span>
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
      <IllustrationBox workId={workId} section={section} thumb={false} />
      <Markdown markdown={content.data.markdown} matcher={matcher} />
    </div>
  )
}
