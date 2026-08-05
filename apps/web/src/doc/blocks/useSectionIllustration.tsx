import type { SectionRow } from '@cowrite/shared'
import { api } from '@cowrite/shared'
import { type ReactNode, useState } from 'react'
import { useIllustrateSection } from '../illustrationTasks.js'
import { IllustrationLightbox } from './IllustrationLightbox.js'

/**
 * The shared section-illustration surface behind both the name card (§5.1) and the full/summary
 * section block (§5.2): the one copy of the committed-image `?v=` cache-buster src, the
 * click-to-open lightbox state, and the lightbox's "Regenerate" handler (re-run + close). Each
 * caller renders its own image/placeholder markup — only the src, the open control, and the
 * lightbox node are shared — so the two layouts stay independent while the illustration wiring
 * lives in one place (docs/04-frontend.md §5.1, §5.2, §10; 08 §5).
 */
export function useSectionIllustration(workId: string, section: SectionRow) {
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const illustrate = useIllustrateSection(workId)
  const illustration = section.illustration
  const src = illustration
    ? `${api.getSectionIllustration.path(workId, section.id)}?v=${illustration.version}`
    : null

  /** The lightbox node (or null): mounted only while open AND a committed image exists. */
  const lightbox = (title: string): ReactNode =>
    lightboxOpen && src ? (
      <IllustrationLightbox
        workId={workId}
        sectionId={section.id}
        title={title}
        src={src}
        onClose={() => setLightboxOpen(false)}
        onRegenerate={() => {
          illustrate.run(section.id)
          setLightboxOpen(false)
        }}
        regenerateDisabled={illustrate.pending}
      />
    ) : null

  return {
    illustration,
    illustrate,
    src,
    openLightbox: () => setLightboxOpen(true),
    lightbox,
  }
}
