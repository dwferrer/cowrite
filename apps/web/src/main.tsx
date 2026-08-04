import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router'
import { makeEnsureConfiguredLoader, Settings } from './routes/Settings.js'
import { WorksList } from './routes/WorksList.js'
import { WorkView } from './routes/WorkView.js'
import './styles/tokens.css'
import './styles/doc.css'
import { Toaster } from './ui/Toast.js'

/**
 * App bootstrap (docs/04-frontend.md §3.1, §4.2): router + QueryClientProvider + theme root.
 * Theme is CSS-only (prefers-color-scheme in tokens.css). Query defaults: 30 s staleTime for
 * lists, retry 1; immutable resources override per-hook.
 */

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      // SSE is the change channel (04 §4.3): window focus must not trigger refetch storms.
      refetchOnWindowFocus: false,
    },
  },
})

const ensureConfigured = makeEnsureConfiguredLoader(queryClient)

const router = createBrowserRouter([
  { path: '/', element: <WorksList />, loader: ensureConfigured },
  { path: '/settings', element: <Settings /> },
  { path: '/w/:workId', element: <WorkView />, loader: ensureConfigured },
  { path: '/w/:workId/world', element: <WorkView />, loader: ensureConfigured },
  { path: '/w/:workId/world/:entryId', element: <WorkView />, loader: ensureConfigured },
  // provenance viewer — a route-driven modal over the work view (04 §7.4)
  { path: '/w/:workId/runs/:runId', element: <WorkView />, loader: ensureConfigured },
])

const root = document.getElementById('root')
if (!root) throw new Error('missing #root element')

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster />
    </QueryClientProvider>
  </StrictMode>,
)
