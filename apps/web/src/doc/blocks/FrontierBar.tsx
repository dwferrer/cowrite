import { useState } from 'react'
import { useCreateSnippet } from '../../api/queries.js'
import { SnippetEditor } from '../../edit/SnippetEditor.js'
import { useDocUiStore } from '../../state/docUiStore.js'
import { testids } from '../../testids.js'
import { Button } from '../../ui/Button.js'

/**
 * The frontier bar (docs/04-frontend.md §8.1) — always the last block. Stage 2 ships the
 * new-snippet flow; Continue and Instruct… are registered but DISABLED until the agent loop
 * lands (Stage 3, 10-roadmap) — global Ctrl-Enter routes to the same disabled Continue.
 *
 * ＋ snippet opens a compose editor in place; the snippet is created on save (the API
 * requires non-empty text, and creating on save keeps one localhost round-trip with no
 * temp-id reconciliation, §8.1).
 */

export interface FrontierBarProps {
  workId: string
  readonly?: boolean
}

const STAGE3_HINT = 'Agent tasks arrive in Stage 3'

export function FrontierBar({ workId, readonly = false }: FrontierBarProps) {
  const [composing, setComposing] = useState(false)
  const createSnippet = useCreateSnippet(workId)
  const select = useDocUiStore((s) => s.select)

  return (
    <div className="frontier-bar" data-testid={testids.frontierBar}>
      {composing ? (
        <div className="snippet-block snippet-block--user snippet-block--editing">
          <SnippetEditor
            workId={workId}
            blockId="new"
            initial=""
            onSave={async (text) => {
              await createSnippet.mutateAsync({ text })
            }}
            onClose={() => setComposing(false)}
          />
        </div>
      ) : (
        <div className="frontier-bar__controls">
          <Button
            data-testid={testids.frontierNewSnippet}
            disabled={readonly}
            onClick={() => {
              select(null) // opening an editor clears selection (04 §7.1)
              setComposing(true)
            }}
          >
            ＋ snippet
          </Button>
          <Button data-testid={testids.frontierContinue} disabled title={STAGE3_HINT}>
            Continue <kbd style={{ opacity: 0.7 }}>⌃⏎</kbd>
          </Button>
          <Button data-testid={testids.frontierInstruct} disabled title={STAGE3_HINT}>
            ✎ Instruct…
          </Button>
        </div>
      )}
    </div>
  )
}
