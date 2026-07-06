import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { App } from './App.js'

describe('App', () => {
  it('renders the shell and reports server status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ status: 'ok', app: 'cowrite', version: '0.0.1' }),
      }),
    )
    render(<App />)
    expect(screen.getByRole('heading', { name: 'Cowrite' })).toBeDefined()
    expect(await screen.findByText('ok')).toBeDefined()
    vi.unstubAllGlobals()
  })
})
