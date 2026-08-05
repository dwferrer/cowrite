import type { WorldEntryDto } from '@cowrite/shared'
import { api } from '@cowrite/shared'
import { useRef, useState } from 'react'
import { useDeleteWorldImage, useUploadWorldImage } from '../../api/queries.js'
import { IllustrationOverlay } from '../../doc/blocks/IllustrationOverlay.js'
import { RegenerateGuidanceBox } from '../../doc/blocks/RegenerateGuidanceBox.js'
import { useIllustrateWorldEntry } from '../../doc/illustrationTasks.js'
import { testids } from '../../testids.js'
import { Button } from '../../ui/Button.js'
import { pushToast } from '../../ui/Toast.js'

/**
 * World-entry image (docs/04-frontend.md §9.3): display at 320 px, manual upload (raw PNG
 * body, 03 §3.5) and remove. Generate/Regenerate (+ optional one-line guidance) launch a
 * `world-image` task; progress rides `task.progress` on the shimmer overlay, a failed run
 * shows the friendly badge + retry (08 §8, §10).
 */

export interface EntryImageProps {
  workId: string
  entry: WorldEntryDto
  readonly?: boolean
}

export function EntryImage({ workId, entry, readonly = false }: EntryImageProps) {
  const upload = useUploadWorldImage(workId)
  const remove = useDeleteWorldImage(workId)
  const illustrate = useIllustrateWorldEntry(workId)
  const fileRef = useRef<HTMLInputElement>(null)
  const [guidanceOpen, setGuidanceOpen] = useState(false)

  const onFile = async (file: File | undefined) => {
    if (!file) return
    if (file.type !== 'image/png') {
      pushToast('Only PNG images are supported', { tone: 'error' })
      return
    }
    const bytes = await file.arrayBuffer()
    upload.mutate(
      { entryId: entry.id, png: bytes },
      {
        onError: (err) =>
          pushToast(err instanceof Error ? err.message : 'Upload failed', { tone: 'error' }),
      },
    )
  }

  const submitGuidance = (guidance: string) => {
    illustrate.run(entry.id, guidance || undefined)
    setGuidanceOpen(false)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
      <div style={{ position: 'relative', width: 320, maxWidth: '100%' }}>
        {entry.hasImage ? (
          <img
            data-testid={testids.worldImage}
            src={`${api.getWorldImage.path(workId, entry.id)}?v=${entry.imageVersion ?? ''}`}
            alt={entry.name}
            style={{
              borderRadius: 'var(--radius-1)',
              border: '1px solid var(--border)',
              width: '100%',
              display: 'block',
            }}
          />
        ) : null}
        <IllustrationOverlay
          targetKind="entry"
          targetId={entry.id}
          onRetry={() => illustrate.run(entry.id)}
          retryDisabled={illustrate.pending}
        />
      </div>
      {readonly ? null : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
            <input
              ref={fileRef}
              data-testid={testids.worldImageUpload}
              type="file"
              accept="image/png"
              style={{ display: 'none' }}
              onChange={(e) => void onFile(e.target.files?.[0])}
            />
            <Button
              data-testid={testids.worldImageGenerate}
              disabled={illustrate.pending}
              onClick={() => setGuidanceOpen((v) => !v)}
            >
              {entry.hasImage ? 'Regenerate…' : 'Generate'}
            </Button>
            <Button disabled={upload.isPending} onClick={() => fileRef.current?.click()}>
              {upload.isPending ? 'Uploading…' : 'Upload PNG…'}
            </Button>
            {entry.hasImage ? (
              <Button
                variant="danger"
                data-testid={testids.worldImageDelete}
                disabled={remove.isPending}
                onClick={() => remove.mutate(entry.id)}
              >
                Remove
              </Button>
            ) : null}
          </div>
          {guidanceOpen ? (
            <RegenerateGuidanceBox
              buttons="ui"
              inputTestId={testids.worldImageGuidanceInput}
              submitTestId={testids.worldImageGuidanceSubmit}
              cancelTestId={testids.worldImageGuidanceCancel}
              placeholder="a weathered woman in her forties, storm-lantern in hand…"
              submitLabel={entry.hasImage ? 'Regenerate' : 'Generate'}
              pending={illustrate.pending}
              onSubmit={submitGuidance}
              onCancel={() => setGuidanceOpen(false)}
            />
          ) : null}
        </div>
      )}
    </div>
  )
}
