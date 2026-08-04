import type { AppConfig, ModelEndpoint, ProbeResult, ProbeTarget } from '@cowrite/shared'
import { ComfyConfig, ModelEndpointUpdate } from '@cowrite/shared'

/**
 * POST /api/config/test (docs/03-api.md §3.12, §9.4): connectivity probes for the
 * settings/setup screen. The optional candidate (the unsaved form) is deep-merged over
 * the stored config ON THE RAW REQUEST JSON: an ABSENT section falls back to stored,
 * while an EXPLICIT null means "cleared / unconfigured" and probes nothing
 * (`config_missing`). The candidate must never be pre-parsed through `ConfigUpdate` —
 * its `.default(null)` sections materialize nulls for omitted keys and erase the
 * omitted-vs-cleared distinction. Within a present endpoint, `apiKey: null` still means
 * "use the stored key" (the client never sees keys).
 *
 * LLM probe: GET {baseUrl}/models; servers that don't implement /models (404) get a
 * tiny 1-token chat/completions call instead. ComfyUI probe: GET {baseUrl}/system_stats.
 * 10 s timeout; global fetch. A failed probe is a 200 ProbeResult{ok:false}, never a
 * thrown error — unreachable endpoints are the expected case on this screen.
 */

export const PROBE_TIMEOUT_MS = 10_000

export interface ProbeDeps {
  fetchImpl?: typeof fetch
  timeoutMs?: number
  now?: () => number
}

/** The probe request over the RAW body: `candidate` is unparsed JSON (see header). */
export interface ProbeRequest {
  target: ProbeTarget
  candidate?: unknown
}

/** Raw-JSON key lookup that distinguishes "absent" from "explicitly null". */
function rawSection(value: unknown, key: string): { present: boolean; value: unknown } {
  if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) {
    return { present: false, value: undefined }
  }
  return { present: true, value: (value as Record<string, unknown>)[key] }
}

/**
 * Candidate-over-stored merge for the LLM endpoint under test, on the raw candidate:
 * lane absent → stored endpoint; lane null → unconfigured (probe nothing); lane object →
 * that endpoint, with `apiKey: null` falling back to the stored key.
 */
export function resolveLlmEndpoint(
  target: 'high' | 'low',
  rawCandidate: unknown,
  stored: AppConfig,
): ModelEndpoint | null {
  const storedEndpoint = stored.models[target]
  const models = rawSection(rawCandidate, 'models')
  if (!models.present) return storedEndpoint
  const lane = rawSection(models.value, target)
  if (!lane.present) return storedEndpoint
  if (lane.value === null) return null // explicitly cleared card ⇒ unconfigured
  const { apiKey, ...rest } = ModelEndpointUpdate.parse(lane.value)
  return { ...rest, apiKey: apiKey ?? storedEndpoint?.apiKey ?? '' }
}

/** Same merge for the ComfyUI section: absent → stored, null → unconfigured. */
export function resolveComfy(rawCandidate: unknown, stored: AppConfig): ComfyConfig | null {
  const section = rawSection(rawCandidate, 'comfyui')
  if (!section.present) return stored.comfyui
  if (section.value === null) return null
  return ComfyConfig.parse(section.value)
}

function failureFromStatus(status: number, body: string): ProbeResult {
  const message = `HTTP ${status}${body === '' ? '' : `: ${truncate(body)}`}`
  if (status === 401 || status === 403) return { ok: false, code: 'auth', message }
  if (status === 429) return { ok: false, code: 'rate_limited', message }
  return { ok: false, code: 'endpoint_unreachable', message }
}

function failureFromError(err: unknown, timeoutMs: number): ProbeResult {
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return { ok: false, code: 'timeout', message: `no response within ${timeoutMs} ms` }
  }
  const cause = err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : ''
  const message = err instanceof Error ? `${err.message}${cause}` : String(err)
  return { ok: false, code: 'endpoint_unreachable', message }
}

function truncate(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

async function safeBody(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}

async function probeLlm(endpoint: ModelEndpoint, deps: Required<ProbeDeps>): Promise<ProbeResult> {
  const base = trimBase(endpoint.baseUrl)
  const headers: Record<string, string> = {}
  if (endpoint.apiKey !== '') headers.authorization = `Bearer ${endpoint.apiKey}`

  const start = deps.now()
  try {
    let res = await deps.fetchImpl(`${base}/models`, {
      headers,
      signal: AbortSignal.timeout(deps.timeoutMs),
    })
    let viaFallback = false
    if (res.status === 404) {
      // Some OpenAI-compatible servers skip /models — fall back to a 1-token completion.
      viaFallback = true
      res = await deps.fetchImpl(`${base}/chat/completions`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: endpoint.model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
        signal: AbortSignal.timeout(deps.timeoutMs),
      })
    }
    if (!res.ok) return failureFromStatus(res.status, await safeBody(res))
    if (viaFallback) {
      const latencyMs = Math.max(0, Math.round(deps.now() - start))
      return { ok: true, latencyMs, detail: 'chat/completions responded (no /models endpoint)' }
    }
    // A model listing can be PUBLIC (OpenRouter serves /models without auth), so a 200 here
    // proves reachability, not credentials. When a key is configured, verify it with a
    // 1-token completion — otherwise the settings screen green-lights a bad key that every
    // real task then fails on.
    if (endpoint.apiKey !== '') {
      const authRes = await deps.fetchImpl(`${base}/chat/completions`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: endpoint.model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
        signal: AbortSignal.timeout(deps.timeoutMs),
      })
      if (!authRes.ok) return failureFromStatus(authRes.status, await safeBody(authRes))
    }
    const latencyMs = Math.max(0, Math.round(deps.now() - start))
    return { ok: true, latencyMs, detail: await modelListDetail(res, endpoint.model) }
  } catch (err) {
    return failureFromError(err, deps.timeoutMs)
  }
}

async function modelListDetail(res: Response, model: string): Promise<string | null> {
  try {
    const parsed: unknown = JSON.parse(await res.text())
    const data =
      parsed !== null &&
      typeof parsed === 'object' &&
      Array.isArray((parsed as { data?: unknown }).data)
        ? (parsed as { data: unknown[] }).data
        : null
    if (data === null) return null
    const ids = data
      .map((entry) =>
        entry !== null && typeof entry === 'object' ? (entry as { id?: unknown }).id : undefined,
      )
      .filter((id): id is string => typeof id === 'string')
    const listed = ids.includes(model)
    return `${data.length} models listed${listed ? `; '${model}' available` : `; '${model}' not in the list`}`
  } catch {
    return null
  }
}

async function probeComfy(config: ComfyConfig, deps: Required<ProbeDeps>): Promise<ProbeResult> {
  const base = trimBase(config.baseUrl)
  const start = deps.now()
  try {
    const res = await deps.fetchImpl(`${base}/system_stats`, {
      signal: AbortSignal.timeout(deps.timeoutMs),
    })
    const latencyMs = Math.max(0, Math.round(deps.now() - start))
    if (!res.ok) return failureFromStatus(res.status, await safeBody(res))
    return { ok: true, latencyMs, detail: await comfyDetail(res) }
  } catch (err) {
    return failureFromError(err, deps.timeoutMs)
  }
}

async function comfyDetail(res: Response): Promise<string | null> {
  try {
    const parsed: unknown = JSON.parse(await res.text())
    const system =
      parsed !== null && typeof parsed === 'object'
        ? (parsed as { system?: { comfyui_version?: unknown } }).system
        : undefined
    const version = system?.comfyui_version
    return typeof version === 'string' ? `ComfyUI ${version}` : 'system_stats ok'
  } catch {
    return null
  }
}

export async function runProbe(
  req: ProbeRequest,
  stored: AppConfig,
  deps: ProbeDeps = {},
): Promise<ProbeResult> {
  const resolved: Required<ProbeDeps> = {
    fetchImpl: deps.fetchImpl ?? fetch,
    timeoutMs: deps.timeoutMs ?? PROBE_TIMEOUT_MS,
    now: deps.now ?? Date.now,
  }
  const missing: ProbeResult = {
    ok: false,
    code: 'config_missing',
    message: `${req.target} is not configured — nothing to test`,
  }
  if (req.target === 'comfyui') {
    const comfy = resolveComfy(req.candidate, stored)
    return comfy === null ? missing : probeComfy(comfy, resolved)
  }
  const endpoint = resolveLlmEndpoint(req.target, req.candidate, stored)
  return endpoint === null ? missing : probeLlm(endpoint, resolved)
}
