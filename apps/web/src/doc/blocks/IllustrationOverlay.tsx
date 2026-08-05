import type { PipelinePhase } from '@cowrite/shared'
import {
  illustrationFailureKey,
  useIllustrationFailure,
  useIllustrationTask,
  useTaskStore,
} from '../../state/taskStore.js'
import { testids } from '../../testids.js'
import { illustrationCaption, illustrationFailureText } from '../illustrationCaption.js'

/**
 * The shimmer-overlay / failure-badge presented ON TOP of a section or world-entry image slot
 * (docs/08-illustration.md §8, docs/04-frontend.md §10): while `illustrate-section` /
 * `world-image` runs against this target, a caption cycles the `task.progress` phases
 * ("Composing prompt" → "Generating (attempt 2/3, 64%)" → "Critiquing…" → "Committing…");
 * on `task.failed` a small badge names the pipeline detail in friendly words with a retry
 * button. Renders nothing when neither applies — callers decide whether an empty reserved
 * box still makes sense at their fold level.
 */

export interface IllustrationOverlayProps {
  targetKind: 'section' | 'entry'
  targetId: string
  onRetry: (guidance?: string) => void
  retryDisabled?: boolean
}

export function IllustrationOverlay({
  targetKind,
  targetId,
  onRetry,
  retryDisabled = false,
}: IllustrationOverlayProps) {
  const task = useIllustrationTask(targetKind, targetId)
  const failure = useIllustrationFailure(targetKind, targetId)
  const clearFailure = useTaskStore((s) => s.clearIllustrationFailure)

  if (task !== null) {
    const caption =
      task.phase !== undefined
        ? illustrationCaption(
            task.phase as PipelinePhase,
            task.attempt ?? 1,
            task.maxAttempts ?? 1,
            task.pct ?? null,
          )
        : 'Starting…'
    return (
      <div className="illustration-shimmer" data-testid={testids.illustrationShimmer}>
        <span className="illustration-shimmer__pulse" aria-hidden="true" />
        <span className="illustration-shimmer__caption" data-testid={testids.illustrationCaption}>
          {caption}
        </span>
      </div>
    )
  }

  if (failure !== null) {
    // A non-retryable failure (config_missing / not_found, §8) can't be fixed by retrying —
    // disable Retry and point the user at Settings (§20). The store captures `retryable`.
    const canRetry = failure.retryable && !retryDisabled
    return (
      <div className="illustration-badge" data-testid={testids.illustrationBadge}>
        <span className="illustration-badge__text">
          {illustrationFailureText(failure.code, failure.message)}
        </span>
        <button
          type="button"
          className="illustration-badge__retry"
          data-testid={testids.illustrationRetry}
          disabled={!canRetry}
          onClick={(e) => {
            e.stopPropagation()
            clearFailure(illustrationFailureKey(targetKind, targetId))
            onRetry()
          }}
        >
          Retry
        </button>
        {!failure.retryable && (
          <a
            className="illustration-badge__settings"
            data-testid={testids.illustrationSettingsLink}
            href="/settings"
            onClick={(e) => e.stopPropagation()}
          >
            Settings
          </a>
        )}
      </div>
    )
  }

  return null
}
