import type { WorldEntryDto } from '@cowrite/shared'
import { api } from '@cowrite/shared'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useCreateWorldEntry, useDeleteWorldEntry, useWorld } from '../../api/queries.js'
import { testids } from '../../testids.js'
import { Button } from '../../ui/Button.js'
import { pushToast } from '../../ui/Toast.js'
import { EntryEditor } from './EntryEditor.js'

/**
 * The routed world panel (docs/04-frontend.md §9.3): an overlay sheet from the right.
 * `/w/:workId/world` — searchable list (client-side over the loaded list) + create;
 * `/w/:workId/world/:entryId` — the entry editor. Back/Esc close via the router.
 */

export interface WorldPanelProps {
  workId: string
  entryId?: string
  readonly?: boolean
}

function matchesFilter(entry: WorldEntryDto, filter: string): boolean {
  const q = filter.trim().toLowerCase()
  if (q.length === 0) return true
  return (
    entry.name.toLowerCase().includes(q) ||
    entry.keys.some((k) => k.toLowerCase().includes(q)) ||
    (entry.shortSummary ?? '').toLowerCase().includes(q)
  )
}

export function WorldPanel({ workId, entryId, readonly = false }: WorldPanelProps) {
  const world = useWorld(workId)
  const navigate = useNavigate()
  const create = useCreateWorldEntry(workId)
  const deleteEntry = useDeleteWorldEntry(workId)
  const [filter, setFilter] = useState('')
  const [newName, setNewName] = useState('')
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const entry = entryId ? world.data?.find((e) => e.id === entryId) : undefined
  const filtered = (world.data ?? []).filter((e) => matchesFilter(e, filter))

  const createEntry = () => {
    const name = newName.trim()
    if (name.length === 0) return
    create.mutate(
      { name },
      {
        onSuccess: (created) => {
          setNewName('')
          navigate(`/w/${workId}/world/${created.id}`)
        },
        onError: (err) =>
          pushToast(err instanceof Error ? err.message : 'Create failed', { tone: 'error' }),
      },
    )
  }

  return (
    <aside className="world-panel" data-testid={testids.worldPanel} aria-label="World">
      <div
        style={{
          alignItems: 'center',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          gap: 'var(--space-2)',
          padding: 'var(--space-2) var(--space-3)',
        }}
      >
        <strong style={{ flex: 1 }}>{entry ? entry.name : 'World'}</strong>
        {entry ? (
          <>
            {readonly ? null : confirmingDelete ? (
              <span style={{ display: 'inline-flex', gap: 2 }}>
                <Button
                  variant="danger"
                  data-testid={testids.worldEntryDelete}
                  disabled={deleteEntry.isPending}
                  onClick={() => {
                    deleteEntry.mutate(entry.id, {
                      onSuccess: () => navigate(`/w/${workId}/world`),
                    })
                    setConfirmingDelete(false)
                  }}
                >
                  Delete?
                </Button>
                <Button variant="ghost" onClick={() => setConfirmingDelete(false)}>
                  ✕
                </Button>
              </span>
            ) : (
              <Button
                variant="ghost"
                aria-label={`Delete ${entry.name}`}
                onClick={() => setConfirmingDelete(true)}
              >
                🗑
              </Button>
            )}
            <Button variant="ghost" onClick={() => navigate(`/w/${workId}/world`)}>
              ← list
            </Button>
          </>
        ) : null}
        <Button
          variant="ghost"
          data-testid={testids.worldPanelClose}
          aria-label="Close world panel"
          onClick={() => navigate(`/w/${workId}`)}
        >
          ✕
        </Button>
      </div>

      {entry ? (
        <EntryEditor workId={workId} entry={entry} readonly={readonly} />
      ) : (
        <>
          <div
            style={{
              borderBottom: '1px solid var(--border)',
              display: 'flex',
              gap: 'var(--space-2)',
              padding: 'var(--space-2) var(--space-3)',
            }}
          >
            <input
              data-testid={testids.worldSearch}
              aria-label="Search entries"
              placeholder="search…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && filter.length > 0) {
                  e.stopPropagation()
                  setFilter('')
                }
              }}
              style={{
                background: 'var(--bg-raised)',
                border: '1px solid var(--border-strong)',
                borderRadius: 'var(--radius-1)',
                color: 'var(--fg)',
                flex: 1,
                font: 'inherit',
                padding: '4px 10px',
              }}
            />
          </div>

          <ul
            data-testid={testids.worldList}
            style={{
              flex: 1,
              listStyle: 'none',
              margin: 0,
              overflowY: 'auto',
              padding: 'var(--space-2)',
            }}
          >
            {filtered.map((e) => (
              <li key={e.id} data-testid={testids.worldEntryRow}>
                <Link
                  to={`/w/${workId}/world/${e.id}`}
                  style={{
                    alignItems: 'center',
                    borderRadius: 'var(--radius-1)',
                    color: 'var(--fg)',
                    display: 'flex',
                    gap: 'var(--space-2)',
                    padding: 'var(--space-2)',
                    textDecoration: 'none',
                  }}
                >
                  {e.hasImage ? (
                    <img
                      src={`${api.getWorldImage.path(workId, e.id)}?v=${e.imageVersion ?? ''}`}
                      alt=""
                      width={40}
                      height={40}
                      style={{ borderRadius: 'var(--radius-1)', flexShrink: 0, objectFit: 'cover' }}
                    />
                  ) : (
                    <span
                      aria-hidden
                      style={{
                        alignItems: 'center',
                        background: 'var(--bg-sunken)',
                        borderRadius: 'var(--radius-1)',
                        display: 'inline-flex',
                        flexShrink: 0,
                        height: 40,
                        justifyContent: 'center',
                        width: 40,
                      }}
                    >
                      ◈
                    </span>
                  )}
                  <span style={{ minWidth: 0 }}>
                    <strong>{e.name}</strong>
                    {e.keys.length > 0 ? (
                      <span
                        style={{
                          color: 'var(--fg-faint)',
                          fontSize: 12,
                          marginLeft: 'var(--space-2)',
                        }}
                      >
                        {e.keys.length} key{e.keys.length === 1 ? '' : 's'}
                      </span>
                    ) : null}
                    {e.shortSummary ? (
                      <span
                        style={{
                          color: 'var(--fg-muted)',
                          display: 'block',
                          fontSize: 12,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {e.shortSummary}
                      </span>
                    ) : null}
                  </span>
                </Link>
              </li>
            ))}
            {world.data && filtered.length === 0 ? (
              <li style={{ color: 'var(--fg-faint)', padding: 'var(--space-2)' }}>
                {world.data.length === 0 ? 'No entries yet.' : 'No matches.'}
              </li>
            ) : null}
          </ul>

          {readonly ? null : (
            <div
              style={{
                borderTop: '1px solid var(--border)',
                display: 'flex',
                gap: 'var(--space-2)',
                padding: 'var(--space-2) var(--space-3)',
              }}
            >
              <input
                data-testid={testids.worldCreateName}
                aria-label="New entry name"
                placeholder="new entry name…"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    createEntry()
                  }
                }}
                style={{
                  background: 'var(--bg-raised)',
                  border: '1px solid var(--border-strong)',
                  borderRadius: 'var(--radius-1)',
                  color: 'var(--fg)',
                  flex: 1,
                  font: 'inherit',
                  padding: '4px 10px',
                }}
              />
              <Button
                data-testid={testids.worldCreateButton}
                disabled={newName.trim().length === 0 || create.isPending}
                onClick={createEntry}
              >
                ＋ New entry
              </Button>
            </div>
          )}
        </>
      )}
    </aside>
  )
}
