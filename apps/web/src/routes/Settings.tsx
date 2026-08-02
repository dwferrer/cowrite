import type { ProbeResult, ProbeTarget, PublicConfig, PublicModelEndpoint } from '@cowrite/shared'
import type { QueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Link, redirect } from 'react-router'
import { type ApiBody, ApiError } from '../api/client.js'
import {
  fetchConfig,
  useConfig,
  useReloadConfig,
  useTestConfig,
  useUpdateConfig,
} from '../api/queries.js'
import { testids } from '../testids.js'
import { Button } from '../ui/Button.js'
import { TextInput } from '../ui/TextInput.js'

/**
 * `/settings` — first-run + endpoint cards over the server config file (docs/04-frontend.md
 * §11, 03 §9.5–9.7). Three cards: high model, low model, ComfyUI (skippable). API keys are
 * redacted server-side ({set}) — leaving the field blank keeps the stored key. Env/flag
 * overridden fields render disabled with a provenance badge.
 */

// ---------------------------------------------------------------------------
// Router integration (04 §3.1, 03 §9.4): an unconfigured high model redirects to
// /settings ONLY on the very first encounter — hand-writing must work with zero
// endpoints, so once the user has seen the setup screen the app never gates again;
// a dismissible banner (below) takes over.
// ---------------------------------------------------------------------------

export function isUnconfigured(config: PublicConfig): boolean {
  return !config.setup.highConfigured
}

const SETUP_SEEN_KEY = 'cowrite:setup-seen'
const BANNER_DISMISSED_KEY = 'cowrite:models-banner-dismissed'

export function hasSeenSetup(): boolean {
  try {
    return localStorage.getItem(SETUP_SEEN_KEY) === '1'
  } catch {
    return true // no storage ⇒ never gate
  }
}

export function markSetupSeen(): void {
  try {
    localStorage.setItem(SETUP_SEEN_KEY, '1')
  } catch {
    // best-effort
  }
}

/** Loader for every non-/settings route. Server unreachable ⇒ let the route render. */
export function makeEnsureConfiguredLoader(qc: QueryClient) {
  return async (): Promise<Response | null> => {
    if (hasSeenSetup()) return null // first encounter only — never a permanent gate
    try {
      const config = await fetchConfig(qc)
      if (isUnconfigured(config)) return redirect('/settings')
    } catch {
      // no config reachable — the destination route surfaces its own error state
    }
    return null
  }
}

/**
 * The post-first-run replacement for the redirect: a small dismissible banner shown by
 * WorksList/WorkView while the high model stays unconfigured.
 */
export function ModelsNotConfiguredBanner() {
  const config = useConfig()
  const [dismissed, setDismissed] = useState(() => {
    try {
      return sessionStorage.getItem(BANNER_DISMISSED_KEY) === '1'
    } catch {
      return false
    }
  })
  if (dismissed || !config.data || !isUnconfigured(config.data)) return null
  return (
    <div
      data-testid={testids.modelsBanner}
      role="status"
      style={{
        alignItems: 'center',
        background: 'var(--warn-bg)',
        borderRadius: 'var(--radius-1)',
        display: 'flex',
        fontSize: 13,
        gap: 'var(--space-2)',
        marginBottom: 'var(--space-3)',
        padding: 'var(--space-2) var(--space-3)',
      }}
    >
      <span style={{ flex: 1 }}>
        Models not configured — hand-writing works; agent features are off.
      </span>
      <Link to="/settings">Configure</Link>
      <Button
        variant="ghost"
        data-testid={testids.modelsBannerDismiss}
        aria-label="Dismiss models banner"
        onClick={() => {
          try {
            sessionStorage.setItem(BANNER_DISMISSED_KEY, '1')
          } catch {
            // best-effort
          }
          setDismissed(true)
        }}
      >
        ✕
      </Button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Form model
// ---------------------------------------------------------------------------

interface EndpointForm {
  baseUrl: string
  apiKey: string // '' = untouched (keep stored key if set, else keyless)
  model: string
}

interface FormState {
  high: EndpointForm
  low: EndpointForm
  comfyBaseUrl: string
}

const emptyEndpoint: EndpointForm = { baseUrl: '', apiKey: '', model: '' }

function seedForm(config: PublicConfig): FormState {
  return {
    high: config.models.high
      ? { baseUrl: config.models.high.baseUrl, apiKey: '', model: config.models.high.model }
      : { ...emptyEndpoint },
    low: config.models.low
      ? { baseUrl: config.models.low.baseUrl, apiKey: '', model: config.models.low.model }
      : { ...emptyEndpoint },
    comfyBaseUrl: config.comfyui?.baseUrl ?? '',
  }
}

function toEndpointUpdate(
  form: EndpointForm,
  existing: PublicModelEndpoint | null,
): NonNullable<ApiBody<'putConfig'>['models']>['high'] {
  const baseUrl = form.baseUrl.trim()
  const model = form.model.trim()
  if (!baseUrl || !model) return null
  return {
    baseUrl,
    model,
    // null = keep the stored key; '' = keyless endpoint (03 §9.5)
    apiKey: form.apiKey !== '' ? form.apiKey : existing?.apiKey.set ? null : '',
    ...(existing
      ? {
          maxOutputTokens: existing.maxOutputTokens,
          temperature: existing.temperature,
          promptCostPerMTok: existing.promptCostPerMTok,
          completionCostPerMTok: existing.completionCostPerMTok,
        }
      : {}),
  }
}

/** Full-replace document (03 §9.5): the saved config with the form's endpoints substituted. */
function buildUpdate(config: PublicConfig, form: FormState): ApiBody<'putConfig'> {
  const { setup: _setup, overrides: _overrides, models, comfyui, ...rest } = config
  const comfyBaseUrl = form.comfyBaseUrl.trim()
  return {
    ...rest,
    models: {
      high: toEndpointUpdate(form.high, models.high),
      low: toEndpointUpdate(form.low, models.low),
    },
    comfyui: comfyBaseUrl ? { ...(comfyui ?? {}), baseUrl: comfyBaseUrl } : null,
  }
}

function overrideFor(config: PublicConfig | undefined, path: string): 'env' | 'flag' | null {
  return config?.overrides.find((o) => o.path === path)?.by ?? null
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function ProbeResultLine({ result }: { result: ProbeResult }) {
  return (
    <p
      data-testid={testids.settingsTestResult}
      style={{ color: result.ok ? 'var(--ok)' : 'var(--danger)', fontSize: 13 }}
    >
      {result.ok
        ? `ok — ${result.latencyMs} ms${result.detail ? ` (${result.detail})` : ''}`
        : `${result.code}: ${result.message}`}
    </p>
  )
}

interface EndpointCardProps {
  title: string
  description: string
  target: ProbeTarget
  testId: string
  config: PublicConfig | undefined
  form: EndpointForm
  onChange: (form: EndpointForm) => void
  keyIsSet: boolean
  testResult: ProbeResult | undefined
  onTest: () => void
  testing: boolean
}

function EndpointCard(props: EndpointCardProps) {
  const { title, description, target, testId, config, form, onChange } = props
  const prefix = target === 'comfyui' ? 'comfyui' : `models.${target}`
  const field = (path: string) => overrideFor(config, `${prefix}.${path}`)

  const badge = (by: 'env' | 'flag' | null) =>
    by ? <span data-testid={testids.settingsOverrideBadge}>{`set by ${by}`}</span> : undefined

  const baseUrlOverride = field('baseUrl')
  const apiKeyOverride = field('apiKey')
  const modelOverride = field('model')

  return (
    <section
      data-testid={testId}
      aria-label={title}
      style={{
        background: 'var(--bg-raised)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-2)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-3)',
        padding: 'var(--space-4)',
      }}
    >
      <div>
        <h2 style={{ fontSize: 15, margin: 0 }}>{title}</h2>
        <p style={{ color: 'var(--fg-muted)', fontSize: 12, margin: 'var(--space-1) 0 0' }}>
          {description}
        </p>
      </div>
      <TextInput
        label="Base URL"
        placeholder="http://localhost:1234/v1"
        value={form.baseUrl}
        disabled={baseUrlOverride !== null}
        hint={badge(baseUrlOverride)}
        onChange={(e) => onChange({ ...form, baseUrl: e.target.value })}
      />
      {target !== 'comfyui' ? (
        <>
          <TextInput
            label="API key"
            type="password"
            placeholder={props.keyIsSet ? 'set — leave blank to keep' : 'not set'}
            value={form.apiKey}
            disabled={apiKeyOverride !== null}
            hint={badge(apiKeyOverride)}
            onChange={(e) => onChange({ ...form, apiKey: e.target.value })}
          />
          <TextInput
            label="Model"
            placeholder="model id"
            value={form.model}
            disabled={modelOverride !== null}
            hint={badge(modelOverride)}
            onChange={(e) => onChange({ ...form, model: e.target.value })}
          />
        </>
      ) : null}
      <div style={{ alignItems: 'center', display: 'flex', gap: 'var(--space-2)' }}>
        <Button
          data-testid={testids.settingsTestButton}
          onClick={props.onTest}
          disabled={props.testing}
        >
          Test
        </Button>
      </div>
      {props.testResult ? <ProbeResultLine result={props.testResult} /> : null}
    </section>
  )
}

export function Settings() {
  const config = useConfig()
  const updateConfig = useUpdateConfig()
  const reloadConfig = useReloadConfig()
  const testConfig = useTestConfig()

  const [form, setForm] = useState<FormState | null>(null)
  const [probeResults, setProbeResults] = useState<Partial<Record<ProbeTarget, ProbeResult>>>({})
  const [restartRequired, setRestartRequired] = useState<string[]>([])

  // Visiting settings IS the first-run encounter: from here on the loader never
  // hard-redirects again (03 §9.4 — hand-writing works with zero endpoints).
  useEffect(() => {
    markSetupSeen()
  }, [])

  // seed the form once the config arrives (later refetches never clobber typing)
  useEffect(() => {
    if (config.data && form === null) setForm(seedForm(config.data))
  }, [config.data, form])

  const firstRun = config.data ? isUnconfigured(config.data) : false

  const runTest = (target: ProbeTarget) => {
    if (!config.data || !form) return
    testConfig.mutate(
      { target, candidate: buildUpdate(config.data, form) },
      {
        onSuccess: (result) => setProbeResults((prev) => ({ ...prev, [target]: result })),
        onError: (error) =>
          setProbeResults((prev) => ({
            ...prev,
            [target]: {
              ok: false,
              code: 'internal',
              message: error instanceof ApiError ? error.message : 'request failed',
            },
          })),
      },
    )
  }

  const onSave = () => {
    if (!config.data || !form) return
    updateConfig.mutate(buildUpdate(config.data, form), {
      onSuccess: (res) => {
        setRestartRequired(res.restartRequired)
        setForm(seedForm(res.config))
      },
    })
  }

  return (
    <main
      data-testid={testids.settingsScreen}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-4)',
        margin: '0 auto',
        maxWidth: 560,
        padding: 'var(--space-6) var(--space-4)',
      }}
    >
      <header style={{ alignItems: 'baseline', display: 'flex', gap: 'var(--space-3)' }}>
        <h1 style={{ flex: 1, fontSize: 22, margin: 0 }}>
          {firstRun ? 'Welcome to Cowrite' : 'Settings'}
        </h1>
        <Link to="/" style={{ color: 'var(--fg-muted)' }}>
          Works
        </Link>
      </header>

      {firstRun ? (
        <p data-testid={testids.settingsFirstRun} style={{ color: 'var(--fg-muted)', margin: 0 }}>
          Connect at least the high model to start co-writing. Browsing and hand-writing work
          without any endpoints; the ComfyUI card is optional.{' '}
          <Link data-testid={testids.settingsSkipLink} to="/">
            Skip for now — write without models
          </Link>
        </p>
      ) : null}

      {config.isLoading ? <p style={{ color: 'var(--fg-faint)' }}>Loading…</p> : null}
      {config.isError ? (
        <p role="alert" style={{ color: 'var(--danger)' }}>
          Could not reach the server.
        </p>
      ) : null}

      {form ? (
        <>
          <EndpointCard
            title="High model"
            description="The flagship writer — continues, instructed edits."
            target="high"
            testId={testids.settingsCardHigh}
            config={config.data}
            form={form.high}
            onChange={(high) => setForm({ ...form, high })}
            keyIsSet={config.data?.models.high?.apiKey.set ?? false}
            testResult={probeResults.high}
            onTest={() => runTest('high')}
            testing={testConfig.isPending}
          />
          <EndpointCard
            title="Low model"
            description="Summaries, titles, boundary proposals — cheap and fast."
            target="low"
            testId={testids.settingsCardLow}
            config={config.data}
            form={form.low}
            onChange={(low) => setForm({ ...form, low })}
            keyIsSet={config.data?.models.low?.apiKey.set ?? false}
            testResult={probeResults.low}
            onTest={() => runTest('low')}
            testing={testConfig.isPending}
          />
          <EndpointCard
            title="ComfyUI"
            description="Illustration backend (optional — skip to write without images)."
            target="comfyui"
            testId={testids.settingsCardComfy}
            config={config.data}
            form={{ baseUrl: form.comfyBaseUrl, apiKey: '', model: '' }}
            onChange={(c) => setForm({ ...form, comfyBaseUrl: c.baseUrl })}
            keyIsSet={false}
            testResult={probeResults.comfyui}
            onTest={() => runTest('comfyui')}
            testing={testConfig.isPending}
          />

          <div style={{ alignItems: 'center', display: 'flex', gap: 'var(--space-2)' }}>
            <Button
              variant="primary"
              data-testid={testids.settingsSaveButton}
              onClick={onSave}
              disabled={updateConfig.isPending}
            >
              Save
            </Button>
            <Button
              data-testid={testids.settingsReloadButton}
              onClick={() => reloadConfig.mutate()}
              disabled={reloadConfig.isPending}
            >
              Reload from disk
            </Button>
          </div>

          {updateConfig.isError ? (
            <p role="alert" style={{ color: 'var(--danger)' }}>
              {updateConfig.error instanceof ApiError ? updateConfig.error.message : 'Save failed.'}
            </p>
          ) : null}

          {restartRequired.length > 0 ? (
            <p
              data-testid={testids.settingsRestartNotice}
              style={{
                background: 'var(--warn-bg)',
                borderRadius: 'var(--radius-1)',
                padding: 'var(--space-2) var(--space-3)',
              }}
            >
              Restart Cowrite to apply: {restartRequired.join(', ')}
            </p>
          ) : null}
        </>
      ) : null}
    </main>
  )
}
