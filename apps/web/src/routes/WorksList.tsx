import { type FormEvent, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { ApiError } from '../api/client.js'
import { useCreateWork, useWorks } from '../api/queries.js'
import { testids } from '../testids.js'
import { Button } from '../ui/Button.js'
import { TextInput } from '../ui/TextInput.js'
import { ModelsNotConfiguredBanner } from './Settings.js'

/**
 * `/` — list, create, open works (docs/04-frontend.md §3.1).
 */

function formatDate(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString()
}

export function WorksList() {
  const works = useWorks()
  const createWork = useCreateWork()
  const navigate = useNavigate()
  const [title, setTitle] = useState('')

  const onCreate = (e: FormEvent) => {
    e.preventDefault()
    const trimmed = title.trim()
    if (!trimmed || createWork.isPending) return
    createWork.mutate(
      { title: trimmed },
      {
        onSuccess: (work) => {
          setTitle('')
          void navigate(`/w/${work.id}`)
        },
      },
    )
  }

  return (
    <main style={{ margin: '0 auto', maxWidth: 640, padding: 'var(--space-6) var(--space-4)' }}>
      <header
        style={{
          alignItems: 'baseline',
          display: 'flex',
          gap: 'var(--space-3)',
          marginBottom: 'var(--space-5)',
        }}
      >
        <h1 style={{ flex: 1, fontSize: 22, margin: 0 }}>Cowrite</h1>
        <Link to="/settings" style={{ color: 'var(--fg-muted)' }}>
          Settings
        </Link>
      </header>

      <ModelsNotConfiguredBanner />

      <form
        onSubmit={onCreate}
        style={{
          alignItems: 'flex-end',
          display: 'flex',
          gap: 'var(--space-2)',
          marginBottom: 'var(--space-5)',
        }}
      >
        <div style={{ flex: 1 }}>
          <TextInput
            label="New work"
            placeholder="Title…"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            data-testid={testids.worksCreateInput}
          />
        </div>
        <Button
          type="submit"
          variant="primary"
          disabled={!title.trim() || createWork.isPending}
          data-testid={testids.worksCreateButton}
        >
          Create
        </Button>
      </form>
      {createWork.isError ? (
        <p role="alert" style={{ color: 'var(--danger)' }}>
          {createWork.error instanceof ApiError
            ? createWork.error.message
            : 'Could not create the work.'}
        </p>
      ) : null}

      {works.isLoading ? <p style={{ color: 'var(--fg-faint)' }}>Loading…</p> : null}
      {works.isError ? (
        <p role="alert" style={{ color: 'var(--danger)' }}>
          Could not reach the server.
        </p>
      ) : null}

      <ul data-testid={testids.worksList} style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {works.data?.map((work) => (
          <li key={work.id} data-testid={testids.worksRow}>
            <Link
              to={`/w/${work.id}`}
              style={{
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-1)',
                color: 'var(--fg)',
                display: 'block',
                marginBottom: 'var(--space-2)',
                padding: 'var(--space-3) var(--space-4)',
                textDecoration: 'none',
              }}
            >
              <div style={{ alignItems: 'baseline', display: 'flex', gap: 'var(--space-2)' }}>
                <strong style={{ flex: 1 }}>{work.title}</strong>
                <span style={{ color: 'var(--fg-faint)', fontSize: 12 }}>
                  {formatDate(work.updatedAt)}
                </span>
              </div>
              <div style={{ color: 'var(--fg-muted)', fontSize: 12 }}>
                {work.wordCount !== null ? `${work.wordCount.toLocaleString()} words` : null}
                {work.wordCount !== null && work.sectionCount !== null ? ' · ' : null}
                {work.sectionCount !== null ? `${work.sectionCount} sections` : null}
                {(work.wordCount !== null || work.sectionCount !== null) &&
                work.snippetCount !== null
                  ? ' · '
                  : null}
                {work.snippetCount !== null ? `${work.snippetCount} snippets` : null}
              </div>
            </Link>
          </li>
        ))}
        {works.data?.length === 0 ? (
          <li style={{ color: 'var(--fg-faint)' }}>No works yet — create one above.</li>
        ) : null}
      </ul>
    </main>
  )
}
