import type { WorldEntryDto } from '@cowrite/shared'
import { api } from '@cowrite/shared'
import { useRef } from 'react'
import { useDeleteWorldImage, useUploadWorldImage } from '../../api/queries.js'
import { testids } from '../../testids.js'
import { Button } from '../../ui/Button.js'
import { pushToast } from '../../ui/Toast.js'

/**
 * World-entry image (docs/04-frontend.md §9.3): display at 320 px, manual upload (raw PNG
 * body, 03 §3.5) and remove. Generate/Regenerate launch a `world-image` task — disabled
 * until the agent loop and illustration pipeline land (Stages 3/5, 10-roadmap).
 */

export interface EntryImageProps {
  workId: string
  entry: WorldEntryDto
  readonly?: boolean
}

export function EntryImage({ workId, entry, readonly = false }: EntryImageProps) {
  const upload = useUploadWorldImage(workId)
  const remove = useDeleteWorldImage(workId)
  const fileRef = useRef<HTMLInputElement>(null)

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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
      {entry.hasImage ? (
        <img
          data-testid={testids.worldImage}
          src={`${api.getWorldImage.path(workId, entry.id)}?v=${entry.imageVersion ?? ''}`}
          alt={entry.name}
          style={{
            borderRadius: 'var(--radius-1)',
            border: '1px solid var(--border)',
            width: 320,
            maxWidth: '100%',
          }}
        />
      ) : null}
      {readonly ? null : (
        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          <input
            ref={fileRef}
            data-testid={testids.worldImageUpload}
            type="file"
            accept="image/png"
            style={{ display: 'none' }}
            onChange={(e) => void onFile(e.target.files?.[0])}
          />
          <Button disabled title="Image generation arrives in Stage 5">
            {entry.hasImage ? 'Regenerate' : 'Generate'}
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
      )}
    </div>
  )
}
