import type { SnippetDto } from '@cowrite/shared'
import { useQueryClient } from '@tanstack/react-query'
import { qk, useSaveSnippet, useSnippetRevisions } from '../../api/queries.js'
import { SelectionToolbar } from '../../edit/SelectionToolbar.js'
import { SnippetEditor } from '../../edit/SnippetEditor.js'
import { Markdown } from '../../render/Markdown.js'
import type { WorldMatcher } from '../../render/worldMatcher.js'
import { useDocUiStore } from '../../state/docUiStore.js'
import { testids } from '../../testids.js'
import { Button } from '../../ui/Button.js'

/**
 * A chat-like frontier block (docs/04-frontend.md §5.1, §7): rendered markdown at rest with
 * a whisper-quiet authorship edge tint; single-click selects (provenance-lite footer +
 * selection toolbar with the revision cycler); double-click swaps in the plaintext editor
 * (which clears selection and fires the editing signal via docUiStore.beginEdit).
 */

export interface SnippetBlockProps {
  workId: string
  snippet: SnippetDto
  matcher: WorldMatcher | null
  readonly?: boolean
}

export function SnippetBlock({ workId, snippet, matcher, readonly = false }: SnippetBlockProps) {
  const qc = useQueryClient()
  const selected = useDocUiStore((s) => s.selection?.id === snippet.id)
  const editingThis = useDocUiStore(
    (s) => s.editing?.kind === 'snippet' && s.editing.id === snippet.id,
  )
  const peek = useDocUiStore((s) =>
    s.peekRevision?.snippetId === snippet.id ? s.peekRevision : null,
  )
  const select = useDocUiStore((s) => s.select)
  const beginEdit = useDocUiStore((s) => s.beginEdit)
  const endEdit = useDocUiStore((s) => s.endEdit)
  const setPeekRevision = useDocUiStore((s) => s.setPeekRevision)
  // fetched on selection (toolbar mount prefetches revisions, 04 §13)
  const revisions = useSnippetRevisions(workId, snippet.id, selected || peek !== null)
  const save = useSaveSnippet(workId)

  if (editingThis) {
    return (
      <div className="snippet-block snippet-block--editing" data-testid={testids.snippetBlock}>
        <SnippetEditor
          workId={workId}
          blockId={snippet.id}
          initial={snippet.text}
          onSave={async (text) => {
            // read the freshest rev at call time so a "Keep mine" retry uses the reloaded base
            const fresh = qc
              .getQueryData<SnippetDto[]>(qk.snippets(workId))
              ?.find((s) => s.id === snippet.id)
            await save.mutateAsync({
              snippetId: snippet.id,
              text,
              baseRev: fresh?.rev ?? snippet.rev,
            })
          }}
          onClose={endEdit}
        />
      </div>
    )
  }

  const peekedRevision = peek ? revisions.data?.find((r) => r.rev === peek.rev) : undefined
  const displayText = peekedRevision?.text ?? snippet.text
  const displayAuthorship = peekedRevision ? peekedRevision.author : snippet.authorship

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: prose block — click-select and dbl-click-edit per 04 §7; Esc/keyboard paths live in the global keymap
    // biome-ignore lint/a11y/useKeyWithClickEvents: selection/editing have global keyboard equivalents (04 §12)
    <div
      className={[
        'snippet-block',
        `snippet-block--${displayAuthorship}`,
        selected ? 'snippet-block--selected' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      data-testid={testids.snippetBlock}
      data-snippet-id={snippet.id}
      data-authorship={displayAuthorship}
      data-selected={selected || undefined}
      onClick={() => {
        if (!selected) select({ kind: 'snippet', id: snippet.id })
      }}
      onDoubleClick={() => {
        if (readonly) return
        beginEdit(workId, { kind: 'snippet', id: snippet.id }, snippet.text, {
          baseRev: snippet.rev,
        })
      }}
    >
      {peek ? (
        <div className="editor-banner" data-testid={testids.revisionPeekBanner}>
          <span style={{ flex: 1 }}>
            viewing rev {peek.rev} of {snippet.rev}
          </span>
          <Button variant="ghost" onClick={() => setPeekRevision(null)}>
            Latest
          </Button>
        </div>
      ) : null}

      <div className="prose">
        <Markdown markdown={displayText} matcher={matcher} />
      </div>

      {selected ? (
        <>
          <SelectionToolbar
            workId={workId}
            snippet={snippet}
            sourceLabel="frontier"
            readonly={readonly}
          />
          <footer className="snippet-footer" data-testid={testids.snippetFooter}>
            <span>{snippet.authorship}</span>
            <span>
              rev {snippet.rev}/{snippet.revisionCount}
            </span>
            <span>{new Date(snippet.updatedAt).toLocaleString()}</span>
          </footer>
        </>
      ) : null}
    </div>
  )
}
