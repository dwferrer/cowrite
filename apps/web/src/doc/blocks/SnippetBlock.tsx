import type { SnippetDto } from '@cowrite/shared'
import { useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router'
import { qk, useSaveSnippet, useSnippetRevisions } from '../../api/queries.js'
import { QuickEditBox } from '../../edit/QuickEditBox.js'
import { SelectionToolbar } from '../../edit/SelectionToolbar.js'
import { SnippetEditor } from '../../edit/SnippetEditor.js'
import { Markdown } from '../../render/Markdown.js'
import type { WorldMatcher } from '../../render/worldMatcher.js'
import { useDocUiStore } from '../../state/docUiStore.js'
import { useTaskStore } from '../../state/taskStore.js'
import { testids } from '../../testids.js'
import { Button } from '../../ui/Button.js'
import { KeepPartialCard } from './KeepPartialCard.js'

/**
 * A chat-like frontier block (docs/04-frontend.md §5.1, §7): rendered markdown at rest with
 * a whisper-quiet authorship edge tint; single-click selects (provenance-lite footer +
 * selection toolbar with the revision cycler + the quick-edit box); double-click swaps in
 * the plaintext editor (which clears selection and fires the editing signal via
 * docUiStore.beginEdit). While a quick-edit task targets this snippet, the block shows the
 * "being rewritten" shimmer (no mid-document token streaming, §8.3); a conflict/failure
 * proposal renders inline as the keep-partial card (§8.4). The provenance footer links the
 * origin run and any revision runs into the run viewer (§7.4).
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
  // "being rewritten" shimmer while an interactive task targets this snippet (04 §8.3)
  const rewritingStage = useTaskStore((s) =>
    s.interactive?.target.kind === 'snippet' && s.interactive.target.id === snippet.id
      ? s.interactive.stage
      : null,
  )
  // conflict / keep-partial proposal targeting this snippet (04 §8.4)
  const proposal = useTaskStore((s) =>
    s.proposal?.target.kind === 'snippet' && s.proposal.target.id === snippet.id
      ? s.proposal
      : null,
  )

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
        rewritingStage !== null ? 'snippet-block--rewriting' : '',
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
        if (readonly || rewritingStage !== null) return
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

      {rewritingStage !== null ? (
        <div className="snippet-rewriting" data-testid={testids.snippetRewriting}>
          <span className="streaming-block__pulse" aria-hidden="true" />
          being rewritten — {rewritingStage}
        </div>
      ) : null}

      {proposal !== null ? <KeepPartialCard workId={workId} proposal={proposal} /> : null}

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
            {runLinks(workId, snippet, revisions.data)}
          </footer>
          {!readonly && rewritingStage === null && proposal === null ? (
            <QuickEditBox workId={workId} snippet={snippet} />
          ) : null}
        </>
      ) : null}
    </div>
  )
}

/** Provenance footer links into the run viewer (04 §7.4): origin run + revision runs. */
function runLinks(
  workId: string,
  snippet: SnippetDto,
  revisions: Array<{ rev: number; runId?: string | undefined }> | undefined,
) {
  const seen = new Set<string>()
  const links: Array<{ runId: string; label: string }> = []
  if (snippet.originRunId !== null) {
    seen.add(snippet.originRunId)
    links.push({ runId: snippet.originRunId, label: `run ${snippet.originRunId.slice(0, 8)}…` })
  }
  for (const r of revisions ?? []) {
    if (r.runId === undefined || seen.has(r.runId)) continue
    seen.add(r.runId)
    links.push({ runId: r.runId, label: `rev ${r.rev} · run ${r.runId.slice(0, 8)}…` })
  }
  if (links.length === 0) return null
  return links.slice(-3).map((link) => (
    <Link
      key={link.runId}
      to={`/w/${workId}/runs/${link.runId}`}
      data-testid={testids.snippetRunLink}
      onClick={(e) => e.stopPropagation()}
    >
      {link.label}
    </Link>
  ))
}
