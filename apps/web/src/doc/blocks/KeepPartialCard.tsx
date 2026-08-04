import { useApplyProposal, useDiscardProposal } from '../../api/queries.js'
import { type ProposalOffer, useTaskStore } from '../../state/taskStore.js'
import { testids } from '../../testids.js'
import { Button } from '../../ui/Button.js'
import { pushToast } from '../../ui/Toast.js'

/**
 * Keep-partial / conflict resolution card (docs/04-frontend.md §8.4). Shown by the
 * streaming block (failed/cancelled continue at the frontier) or inline at a quick-edit
 * target (conflict / failed rewrite). Keep/Apply calls the proposal apply route — the
 * server reconstructs the proposal from the durable run JSONL and commits it with agent
 * authorship + originRunId, so provenance is preserved server-side; the result arrives as
 * a normal snippet.created / snippet.revised event. Discard hits the discard route.
 */

export interface KeepPartialCardProps {
  workId: string
  proposal: ProposalOffer
}

function bannerText(proposal: ProposalOffer): string {
  switch (proposal.reason) {
    case 'conflict':
      return 'Text changed while editing — apply the rewrite anyway?'
    case 'cancelled':
      return 'Generation cancelled — keep the partial text?'
    case 'failed':
      return `Generation failed${proposal.message ? ` — ${proposal.message}` : ''}`
  }
}

function applyLabel(proposal: ProposalOffer): string {
  if (proposal.reason === 'conflict') return 'Apply anyway'
  return proposal.target.kind === 'frontier' ? 'Keep partial as snippet' : 'Keep'
}

export function KeepPartialCard({ workId, proposal }: KeepPartialCardProps) {
  const apply = useApplyProposal(workId)
  const discard = useDiscardProposal(workId)
  const clearProposal = useTaskStore((s) => s.clearProposal)
  const busy = apply.isPending || discard.isPending

  return (
    <div className="keep-partial" data-testid={testids.keepPartial}>
      <div className="editor-banner editor-banner--conflict">
        <span style={{ flex: 1 }}>{bannerText(proposal)}</span>
      </div>
      {/* copyable plain text — the M1 conflict card is deliberately diff-less (04 §8.4) */}
      <div className="prose keep-partial__text">{proposal.text}</div>
      <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end' }}>
        <Button
          data-testid={testids.keepPartialDiscard}
          disabled={busy}
          onClick={() =>
            discard.mutate(proposal.taskId, {
              onSuccess: clearProposal,
              onError: (err) =>
                pushToast(err instanceof Error ? err.message : 'Discard failed', {
                  tone: 'error',
                }),
            })
          }
        >
          Discard
        </Button>
        <Button
          variant="primary"
          data-testid={testids.keepPartialApply}
          disabled={busy}
          onClick={() =>
            apply.mutate(proposal.taskId, {
              onSuccess: clearProposal,
              onError: (err) =>
                pushToast(err instanceof Error ? err.message : 'Apply failed', { tone: 'error' }),
            })
          }
        >
          {applyLabel(proposal)}
        </Button>
      </div>
    </div>
  )
}
