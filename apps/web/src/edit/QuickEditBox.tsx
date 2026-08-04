import type { SnippetDto } from '@cowrite/shared'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { useCreateTask } from '../api/queries.js'
import { toastTaskCreateError } from '../api/taskErrors.js'
import { useTaskStore } from '../state/taskStore.js'
import { testids } from '../testids.js'
import { Button } from '../ui/Button.js'

/**
 * The quick-edit affordance below a selected snippet (docs/04-frontend.md §7.2): a one-line
 * instruction input, distinct instruction styling (§8.2). Ctrl-Enter (in the input, or via
 * the selection-context keymap dispatching `cowrite:quick-edit`) launches a `quick-edit`
 * task targeting exactly this frontier snippet — the MVP rule. There is NO mid-document
 * token streaming: the target block shows the "being rewritten" shimmer until the committed
 * revision swaps in atomically (§8.3); a conflict surfaces the proposal card (§8.4).
 */

/** Selection-context Ctrl-Enter (keymap `selection.quickEdit`) routes here (04 §12). */
export const QUICK_EDIT_EVENT = 'cowrite:quick-edit'

export function dispatchQuickEdit(): void {
  window.dispatchEvent(new CustomEvent(QUICK_EDIT_EVENT))
}

export interface QuickEditBoxProps {
  workId: string
  snippet: SnippetDto
}

export function QuickEditBox({ workId, snippet }: QuickEditBoxProps) {
  const [instruction, setInstruction] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const createTask = useCreateTask(workId)
  const interactiveActive = useTaskStore((s) => s.interactive !== null)
  const navigate = useNavigate()

  const disabled = interactiveActive || createTask.isPending

  const launch = () => {
    const text = instruction.trim()
    if (disabled || text.length === 0) return
    createTask.mutate(
      {
        kind: 'quick-edit',
        instruction: text,
        target: { type: 'snippet', snippetId: snippet.id, baseRev: snippet.rev },
        // MVP: the whole snippet is the selection (span quick-edits ship in M2)
        selection: { text: snippet.text, start: 0, end: snippet.text.length },
      },
      {
        onSuccess: () => setInstruction(''),
        onError: (err) => toastTaskCreateError(err, () => navigate('/settings')),
      },
    )
  }

  // no dependency array on purpose: re-subscribing per render keeps launch fresh
  useEffect(() => {
    const onQuickEdit = () => launch()
    window.addEventListener(QUICK_EDIT_EVENT, onQuickEdit)
    return () => window.removeEventListener(QUICK_EDIT_EVENT, onQuickEdit)
  })

  return (
    // stopPropagation: typing/clicking in the box must not re-toggle block selection
    // biome-ignore lint/a11y/noStaticElementInteractions: click containment only — the input and button carry the semantics
    <div
      className="quick-edit-box instruction-surface"
      data-testid={testids.quickEditBox}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <span className="instruction-microlabel">✎ instruction</span>
      <input
        ref={inputRef}
        type="text"
        data-testid={testids.quickEditInput}
        className="quick-edit-box__input"
        placeholder="Tell the agent how to change this passage…"
        value={instruction}
        disabled={disabled}
        onChange={(e) => setInstruction(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || !e.shiftKey)) {
            e.preventDefault()
            launch()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            if (instruction.length > 0) setInstruction('')
            else inputRef.current?.blur()
          }
        }}
      />
      <Button
        variant="primary"
        data-testid={testids.quickEditSubmit}
        disabled={disabled || instruction.trim().length === 0}
        title={interactiveActive ? 'Already writing — cancel the running task first' : undefined}
        onClick={launch}
      >
        Rewrite
      </Button>
    </div>
  )
}
