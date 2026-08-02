import type { SnippetDto } from '@cowrite/shared'
import { useEffect, useState } from 'react'
import { useDeleteSnippet } from '../api/queries.js'
import { requestSituationAppend } from '../panes/situationBridge.js'
import { useDocUiStore } from '../state/docUiStore.js'
import { testids } from '../testids.js'
import { Button } from '../ui/Button.js'
import { RevisionCycler } from './RevisionCycler.js'

/**
 * The floating widgets on single-click select (docs/04-frontend.md §7.2): provenance chip,
 * revision cycler, delete (with confirm), and "＋ Situation" when a text range is selected
 * inside the block (§9.1). Positioned at the block's top-right (the block is the positioning
 * context). The quick-edit box ships with the agent loop (Stage 3).
 */

export interface SelectionToolbarProps {
  workId: string
  snippet: SnippetDto
  /** Attribution line for the copy-to-situation blockquote (e.g. "frontier"). */
  sourceLabel: string
  readonly?: boolean
}

function useDocTextSelection(): string {
  const [text, setText] = useState('')
  useEffect(() => {
    const onChange = () => {
      const selection = document.getSelection()
      setText(selection && !selection.isCollapsed ? selection.toString() : '')
    }
    document.addEventListener('selectionchange', onChange)
    return () => document.removeEventListener('selectionchange', onChange)
  }, [])
  return text
}

export function SelectionToolbar({
  workId,
  snippet,
  sourceLabel,
  readonly = false,
}: SelectionToolbarProps) {
  const deleteSnippet = useDeleteSnippet(workId)
  const select = useDocUiStore((s) => s.select)
  const [confirming, setConfirming] = useState(false)
  const selectedText = useDocTextSelection()

  return (
    // stopPropagation: toolbar clicks must not re-toggle block selection
    // biome-ignore lint/a11y/noStaticElementInteractions: click containment only — buttons inside carry the semantics
    <div
      className="selection-toolbar"
      data-testid={testids.selectionToolbar}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <span
        className="selection-toolbar__chip"
        title={`Origin run: ${snippet.originRunId ?? 'none'}`}
      >
        {snippet.authorship}
      </span>
      <RevisionCycler workId={workId} snippet={snippet} readonly={readonly} />
      {selectedText.length > 0 ? (
        <Button
          variant="ghost"
          data-testid={testids.addToSituation}
          onClick={() => requestSituationAppend(workId, selectedText, sourceLabel)}
        >
          ＋ Situation
        </Button>
      ) : null}
      {readonly ? null : confirming ? (
        <span style={{ display: 'inline-flex', gap: 2 }}>
          <Button
            variant="danger"
            data-testid={testids.snippetDelete}
            disabled={deleteSnippet.isPending}
            onClick={() => {
              deleteSnippet.mutate(snippet.id)
              select(null)
            }}
          >
            Delete?
          </Button>
          <Button variant="ghost" onClick={() => setConfirming(false)}>
            ✕
          </Button>
        </span>
      ) : (
        <Button variant="ghost" aria-label="Delete snippet" onClick={() => setConfirming(true)}>
          🗑
        </Button>
      )}
    </div>
  )
}
