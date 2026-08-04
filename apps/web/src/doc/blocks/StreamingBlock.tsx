import { useCancelTask } from '../../api/queries.js'
import { useTaskStore } from '../../state/taskStore.js'
import { testids } from '../../testids.js'
import { Button } from '../../ui/Button.js'
import { KeepPartialCard } from './KeepPartialCard.js'

/**
 * The live generation block at the frontier (docs/04-frontend.md §8.3), rendered above the
 * frontier bar while the interactive task targets the frontier:
 *
 * - planning stage: a compact activity line cycling the `task.tool` notes — no fake prose;
 * - writing stage: buffered deltas append as plaintext-ish prose (whitespace preserved, NO
 *   markdown reparse per token) with a blinking caret, translucent until committed;
 * - retrying/usage ride a subtle status line; cancel ✕ is always available.
 *
 * On completion the `snippet.created` echo swaps in the real snippet (keyed swap — the slot
 * clears and the committed block renders in its place). After a failed/cancelled continue,
 * the keep-partial card (04 §8.4) renders here instead.
 */

export interface StreamingBlockProps {
  workId: string
}

function formatTokens(n: number): string {
  return n.toLocaleString('en-US')
}

export function StreamingBlock({ workId }: StreamingBlockProps) {
  const interactive = useTaskStore((s) => s.interactive)
  const proposal = useTaskStore((s) => s.proposal)
  const cancel = useCancelTask(workId)

  const frontierTask = interactive?.target.kind === 'frontier' ? interactive : null

  if (frontierTask === null) {
    // failed/cancelled continue: the streaming block's place shows the keep-partial card
    if (proposal !== null && proposal.target.kind === 'frontier') {
      return (
        <div className="snippet-block snippet-block--agent" data-testid={testids.streamingBlock}>
          <KeepPartialCard workId={workId} proposal={proposal} />
        </div>
      )
    }
    return null
  }

  const text = frontierTask.buffers.get('frontier') ?? ''
  const latestNote = frontierTask.toolNotes[frontierTask.toolNotes.length - 1]

  return (
    <div
      className="snippet-block snippet-block--agent streaming-block"
      data-testid={testids.streamingBlock}
      data-stage={frontierTask.stage}
    >
      <div className="streaming-block__header">
        {frontierTask.instruction !== null ? (
          <span className="streaming-block__instruction" title={frontierTask.instruction}>
            ↳ <em>{frontierTask.instruction}</em>
          </span>
        ) : (
          <span style={{ flex: 1 }} />
        )}
        <Button
          variant="ghost"
          aria-label="Cancel generation"
          data-testid={testids.streamingCancel}
          disabled={cancel.isPending}
          onClick={() => cancel.mutate(frontierTask.taskId)}
        >
          ✕
        </Button>
      </div>

      {frontierTask.stage === 'planning' ? (
        <div className="streaming-block__activity" data-testid={testids.streamingPlanning}>
          <span className="streaming-block__pulse" aria-hidden="true" />
          planning{latestNote ? ` — ${latestNote}` : '…'}
        </div>
      ) : (
        <div className="prose streaming-block__text" data-testid={testids.streamingText}>
          {text}
          <span className="streaming-block__caret" aria-hidden="true" />
        </div>
      )}

      {frontierTask.retrying !== null ? (
        <div className="streaming-block__status" data-testid={testids.streamingRetrying}>
          retrying (attempt {frontierTask.retrying.attempt}) — {frontierTask.retrying.reason}
        </div>
      ) : null}

      {frontierTask.usage !== null ? (
        <div className="streaming-block__status" data-testid={testids.streamingUsage}>
          {/* "~" marks estimated figures — some component was a chars/4 fallback (05 §9) */}
          {frontierTask.usage.estimated ? '~' : ''}
          {formatTokens(frontierTask.usage.promptTokens)} in /{' '}
          {formatTokens(frontierTask.usage.completionTokens)} out
          {frontierTask.usage.costUsd !== null
            ? ` · ${frontierTask.usage.estimated ? '~' : ''}$${frontierTask.usage.costUsd.toFixed(4)}`
            : ''}
        </div>
      ) : null}
    </div>
  )
}
