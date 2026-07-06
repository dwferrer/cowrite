import { healthResponseSchema } from '@cowrite/shared'
import { useEffect, useState } from 'react'

export function App() {
  const [status, setStatus] = useState<'checking' | 'ok' | 'unreachable'>('checking')

  useEffect(() => {
    let cancelled = false
    fetch('/api/health')
      .then((res) => res.json())
      .then((body) => {
        healthResponseSchema.parse(body)
        if (!cancelled) setStatus('ok')
      })
      .catch(() => {
        if (!cancelled) setStatus('unreachable')
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem' }}>
      <h1>Cowrite</h1>
      <p>Illustrated co-writing with an LLM. The real UI lands with milestone M1.</p>
      <p data-testid="server-status">
        server: <strong>{status}</strong>
      </p>
    </main>
  )
}
