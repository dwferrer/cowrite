import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { useCreateSnippet, useCreateTask } from '../../api/queries.js'
import { toastTaskCreateError } from '../../api/taskErrors.js'
import { SnippetEditor } from '../../edit/SnippetEditor.js'
import { useDocUiStore } from '../../state/docUiStore.js'
import { useTaskStore } from '../../state/taskStore.js'
import { testids } from '../../testids.js'
import { Button } from '../../ui/Button.js'
import { StreamingBlock } from './StreamingBlock.js'

/**
 * The frontier bar (docs/04-frontend.md §8.1) — always the last block. ＋ snippet opens a
 * compose editor in place (created on save). Continue launches a `continue` task — also via
 * global Ctrl-Enter (the keymap dispatches `cowrite:continue` when nothing is selected and
 * no editor is open). Instruct… expands into a textarea styled as instructions (§8.2);
 * Ctrl-Enter launches `instructed-continue`. The task buttons disable while the interactive
 * slot is occupied (the server answers 409 busy — there is no interactive queue); a 409
 * `config_missing` surfaces a toast linking /settings, never a bare error (§14).
 */

export interface FrontierBarProps {
  workId: string
  readonly?: boolean
}

/** Global Ctrl-Enter (keymap `global.continue`) routes here (04 §12). */
export const CONTINUE_EVENT = 'cowrite:continue'

export function dispatchContinue(): void {
  window.dispatchEvent(new CustomEvent(CONTINUE_EVENT))
}

export function FrontierBar({ workId, readonly = false }: FrontierBarProps) {
  const [composing, setComposing] = useState(false)
  const [instructing, setInstructing] = useState(false)
  const [instruction, setInstruction] = useState('')
  const instructRef = useRef<HTMLTextAreaElement>(null)
  const createSnippet = useCreateSnippet(workId)
  const createTask = useCreateTask(workId)
  const select = useDocUiStore((s) => s.select)
  const interactiveActive = useTaskStore((s) => s.interactive !== null)
  const navigate = useNavigate()

  const tasksDisabled = readonly || interactiveActive || createTask.isPending
  const busyHint = interactiveActive ? 'Already writing — cancel the running task first' : undefined

  const launchContinue = () => {
    if (tasksDisabled) return
    select(null) // starting any frontier task clears selection (04 §7.2)
    createTask.mutate(
      { kind: 'continue' },
      { onError: (err) => toastTaskCreateError(err, () => navigate('/settings')) },
    )
  }

  const launchInstructed = () => {
    const text = instruction.trim()
    if (tasksDisabled || text.length === 0) return
    select(null)
    createTask.mutate(
      { kind: 'instructed-continue', instruction: text },
      {
        onSuccess: () => {
          setInstruction('')
          setInstructing(false)
        },
        onError: (err) => toastTaskCreateError(err, () => navigate('/settings')),
      },
    )
  }

  // no dependency array on purpose: re-subscribing per render keeps launchContinue fresh
  useEffect(() => {
    const onContinue = () => launchContinue()
    window.addEventListener(CONTINUE_EVENT, onContinue)
    return () => window.removeEventListener(CONTINUE_EVENT, onContinue)
  })

  useEffect(() => {
    if (instructing) instructRef.current?.focus()
  }, [instructing])

  return (
    <div className="frontier-bar" data-testid={testids.frontierBar}>
      <StreamingBlock workId={workId} />
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
        <>
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
            <Button
              data-testid={testids.frontierContinue}
              disabled={tasksDisabled}
              title={busyHint}
              onClick={launchContinue}
            >
              Continue <kbd style={{ opacity: 0.7 }}>⌃⏎</kbd>
            </Button>
            <Button
              data-testid={testids.frontierInstruct}
              disabled={tasksDisabled}
              title={busyHint}
              aria-expanded={instructing}
              onClick={() => setInstructing((v) => !v)}
            >
              ✎ Instruct…
            </Button>
          </div>
          {instructing ? (
            <div className="frontier-instruct instruction-surface">
              <span className="instruction-microlabel">✎ instruction</span>
              <textarea
                ref={instructRef}
                data-testid={testids.frontierInstructInput}
                className="frontier-instruct__textarea"
                rows={3}
                placeholder="Tell the agent where to take the story…"
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && e.ctrlKey) {
                    e.preventDefault()
                    e.stopPropagation()
                    launchInstructed()
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    e.stopPropagation()
                    setInstructing(false)
                  }
                }}
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <Button
                  variant="primary"
                  data-testid={testids.frontierInstructSubmit}
                  disabled={tasksDisabled || instruction.trim().length === 0}
                  onClick={launchInstructed}
                >
                  Write <kbd style={{ fontFamily: 'var(--font-ui)', opacity: 0.8 }}>⌃⏎</kbd>
                </Button>
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}
