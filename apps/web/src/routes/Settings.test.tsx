import { PublicConfig } from '@cowrite/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { testids } from '../testids.js'
import {
  isUnconfigured,
  ModelsNotConfiguredBanner,
  makeEnsureConfiguredLoader,
  markSetupSeen,
  Settings,
} from './Settings.js'

function makeConfig(overrides: Parameters<(typeof PublicConfig)['parse']>[0] = {}) {
  return PublicConfig.parse({
    models: {
      high: {
        baseUrl: 'http://localhost:1234/v1',
        apiKey: { set: true },
        model: 'big-writer',
      },
      low: null,
    },
    setup: { highConfigured: true, lowConfigured: false, comfyConfigured: false },
    overrides: [],
    ...(overrides as object),
  })
}

type FetchHandler = (
  url: string,
  init?: RequestInit,
) => { status: number; body: unknown } | undefined

function stubFetch(handler: FetchHandler) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const result = handler(String(input), init)
    if (!result) throw new Error(`unexpected fetch: ${String(input)}`)
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      json: () => Promise.resolve(result.body),
    }
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function renderSettings() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter([{ path: '/', element: <Settings /> }], {
    initialEntries: ['/'],
  })
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  localStorage.clear() // the setup-seen flag persists across tests otherwise
  sessionStorage.clear()
})

afterEach(() => {
  cleanup() // no vitest globals ⇒ testing-library auto-cleanup is off
  vi.unstubAllGlobals()
})

describe('Settings', () => {
  it('renders the three endpoint cards seeded from the config', async () => {
    stubFetch((url) =>
      url === '/api/config'
        ? { status: 200, body: JSON.parse(JSON.stringify(makeConfig())) }
        : undefined,
    )
    renderSettings()

    const high = await screen.findByTestId(testids.settingsCardHigh)
    expect(screen.getByTestId(testids.settingsCardLow)).toBeDefined()
    expect(screen.getByTestId(testids.settingsCardComfy)).toBeDefined()

    const baseUrl = within(high).getByLabelText(/Base URL/) as HTMLInputElement
    expect(baseUrl.value).toBe('http://localhost:1234/v1')
    const apiKey = within(high).getByLabelText(/API key/) as HTMLInputElement
    expect(apiKey.placeholder).toContain('leave blank to keep')
    // not first-run: the regular heading
    expect(screen.queryByTestId(testids.settingsFirstRun)).toBeNull()
  })

  it('shows the first-run welcome when the high model is unconfigured', async () => {
    const config = makeConfig({
      models: { high: null, low: null },
      setup: { highConfigured: false, lowConfigured: false, comfyConfigured: false },
      overrides: [],
    })
    stubFetch((url) =>
      url === '/api/config' ? { status: 200, body: JSON.parse(JSON.stringify(config)) } : undefined,
    )
    renderSettings()

    expect(await screen.findByTestId(testids.settingsFirstRun)).toBeDefined()
    expect(screen.getByText('Welcome to Cowrite')).toBeDefined()
    expect(isUnconfigured(config)).toBe(true)
    // 03 §9.4: the first-run screen offers an explicit way OUT with zero endpoints
    const skip = screen.getByTestId(testids.settingsSkipLink) as HTMLAnchorElement
    expect(skip.getAttribute('href')).toBe('/')
  })

  it('disables env-overridden fields and shows the provenance badge', async () => {
    const config = makeConfig({
      models: {
        high: { baseUrl: 'http://baked-in:9/v1', apiKey: { set: true }, model: 'big-writer' },
        low: null,
      },
      setup: { highConfigured: true, lowConfigured: false, comfyConfigured: false },
      overrides: [{ path: 'models.high.baseUrl', by: 'env' }],
    })
    stubFetch((url) =>
      url === '/api/config' ? { status: 200, body: JSON.parse(JSON.stringify(config)) } : undefined,
    )
    renderSettings()

    const high = await screen.findByTestId(testids.settingsCardHigh)
    const baseUrl = within(high).getByLabelText(/Base URL/) as HTMLInputElement
    expect(baseUrl.disabled).toBe(true)
    const badge = within(high).getByTestId(testids.settingsOverrideBadge)
    expect(badge.textContent).toBe('set by env')
    // the un-overridden model field stays editable
    const model = within(high).getByLabelText(/Model/) as HTMLInputElement
    expect(model.disabled).toBe(false)
  })

  it('tests a lane with the unsaved candidate and renders the per-lane result', async () => {
    const fetchMock = stubFetch((url) => {
      if (url === '/api/config')
        return { status: 200, body: JSON.parse(JSON.stringify(makeConfig())) }
      if (url === '/api/config/test')
        return { status: 200, body: { ok: true, latencyMs: 42, detail: '3 models' } }
      return undefined
    })
    renderSettings()

    const high = await screen.findByTestId(testids.settingsCardHigh)
    fireEvent.change(within(high).getByLabelText(/Model/), { target: { value: 'bigger-writer' } })
    fireEvent.click(within(high).getByTestId(testids.settingsTestButton))

    const result = await screen.findByTestId(testids.settingsTestResult)
    expect(result.textContent).toContain('ok — 42 ms')

    const testCall = fetchMock.mock.calls.find(([u]) => String(u) === '/api/config/test')
    expect(testCall).toBeDefined()
    const body = JSON.parse((testCall?.[1] as RequestInit).body as string)
    expect(body.target).toBe('high')
    expect(body.candidate.models.high.model).toBe('bigger-writer')
    expect(body.candidate.models.high.apiKey).toBeNull() // untouched ⇒ keep stored key
  })

  it('the ComfyUI card surfaces the marker setup step and the health report', async () => {
    stubFetch((url) => {
      if (url === '/api/config')
        return { status: 200, body: JSON.parse(JSON.stringify(makeConfig())) }
      if (url === '/api/illustration/health') {
        return {
          status: 200,
          body: {
            ok: false,
            comfy: { ok: true },
            workflows: [
              { name: 'default', label: 'Default (SDXL scene)', ok: false, error: 'mark %prompt%' },
            ],
            route: {
              section: { name: 'default', ok: false },
              world: { name: 'default', ok: false },
            },
          },
        }
      }
      return undefined
    })
    renderSettings()

    const comfy = await screen.findByTestId(testids.settingsCardComfy)
    expect(within(comfy).getByTestId(testids.settingsComfyMarkerHelp).textContent).toContain(
      '%prompt%',
    )
    const healthReport = await within(comfy).findByTestId(testids.settingsComfyHealth)
    expect(healthReport.textContent).toContain('reachable')
    expect(within(comfy).getByTestId(testids.settingsComfyWorkflowRow).textContent).toContain(
      'mark %prompt%',
    )
    expect(healthReport.textContent).toContain('broken')
  })

  it('saves the full document via PUT and renders the restartRequired notice', async () => {
    const config = makeConfig()
    const fetchMock = stubFetch((url, init) => {
      if (url === '/api/config' && init?.method === 'PUT')
        return {
          status: 200,
          body: {
            config: JSON.parse(JSON.stringify(config)),
            restartRequired: ['server.port'],
          },
        }
      if (url === '/api/config') return { status: 200, body: JSON.parse(JSON.stringify(config)) }
      return undefined
    })
    renderSettings()

    fireEvent.click(await screen.findByTestId(testids.settingsSaveButton))

    const notice = await screen.findByTestId(testids.settingsRestartNotice)
    expect(notice.textContent).toContain('server.port')

    const putCall = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === 'PUT')
    const body = JSON.parse((putCall?.[1] as RequestInit).body as string)
    expect(body.models.high.baseUrl).toBe('http://localhost:1234/v1')
    expect(body.models.low).toBeNull()
    expect(body.comfyui).toBeNull()
    // the redaction-only fields never round-trip
    expect(body.setup).toBeUndefined()
    expect(body.overrides).toBeUndefined()
  })
})

describe('makeEnsureConfiguredLoader', () => {
  const unconfigured = () =>
    makeConfig({
      models: { high: null, low: null },
      setup: { highConfigured: false, lowConfigured: false, comfyConfigured: false },
      overrides: [],
    })

  it('redirects to /settings on the FIRST encounter with an unconfigured high model', async () => {
    stubFetch((url) =>
      url === '/api/config'
        ? { status: 200, body: JSON.parse(JSON.stringify(unconfigured())) }
        : undefined,
    )
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const result = await makeEnsureConfiguredLoader(qc)()
    expect(result).toBeInstanceOf(Response)
    expect((result as Response).headers.get('Location')).toBe('/settings')
  })

  it('never redirects again once the setup screen has been seen (03 §9.4)', async () => {
    // Regression: the loader used to gate '/' and every work route PERMANENTLY while
    // models.high was unconfigured — hand-writing must work with zero endpoints.
    const fetchMock = stubFetch((url) =>
      url === '/api/config'
        ? { status: 200, body: JSON.parse(JSON.stringify(unconfigured())) }
        : undefined,
    )
    markSetupSeen()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    expect(await makeEnsureConfiguredLoader(qc)()).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled() // no gate, no config round trip
  })

  it('mounting Settings marks setup as seen', async () => {
    stubFetch((url) =>
      url === '/api/config'
        ? { status: 200, body: JSON.parse(JSON.stringify(unconfigured())) }
        : undefined,
    )
    renderSettings()
    await screen.findByTestId(testids.settingsFirstRun)
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    expect(await makeEnsureConfiguredLoader(qc)()).toBeNull()
  })

  it('passes through when configured, and on fetch failure', async () => {
    stubFetch((url) =>
      url === '/api/config'
        ? { status: 200, body: JSON.parse(JSON.stringify(makeConfig())) }
        : undefined,
    )
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    expect(await makeEnsureConfiguredLoader(qc)()).toBeNull()

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')))
    const qc2 = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    expect(await makeEnsureConfiguredLoader(qc2)()).toBeNull()
  })
})

describe('ModelsNotConfiguredBanner', () => {
  function renderBanner(config: ReturnType<typeof makeConfig>) {
    stubFetch((url) =>
      url === '/api/config' ? { status: 200, body: JSON.parse(JSON.stringify(config)) } : undefined,
    )
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const router = createMemoryRouter([{ path: '/', element: <ModelsNotConfiguredBanner /> }], {
      initialEntries: ['/'],
    })
    render(
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    )
  }

  it('shows while unconfigured, links to /settings, and dismisses', async () => {
    renderBanner(
      makeConfig({
        models: { high: null, low: null },
        setup: { highConfigured: false, lowConfigured: false, comfyConfigured: false },
        overrides: [],
      }),
    )
    const banner = await screen.findByTestId(testids.modelsBanner)
    expect(within(banner).getByText('Configure').getAttribute('href')).toBe('/settings')
    fireEvent.click(within(banner).getByTestId(testids.modelsBannerDismiss))
    expect(screen.queryByTestId(testids.modelsBanner)).toBeNull()
  })

  it('renders nothing when the high model is configured', async () => {
    renderBanner(makeConfig())
    // let the config query settle
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(screen.queryByTestId(testids.modelsBanner)).toBeNull()
  })
})
