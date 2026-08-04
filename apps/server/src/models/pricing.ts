import type { ModelEndpoint } from '@cowrite/shared'

/**
 * Best-effort price discovery from the provider's models endpoint.
 *
 * The vanilla OpenAI `GET /v1/models` carries no pricing, but OpenRouter (and several
 * compatible gateways) return a per-model `pricing` object with USD-per-TOKEN strings:
 * `{ id, pricing: { prompt: "0.00000015", completion: "0.0000006", ... } }`.
 * When the configured model is found with parseable pricing, we convert to USD per MTok
 * (×1e6) and use it to fill any price the user left null in config. Config-set prices
 * always win; discovery never overwrites them and never throws — on any failure the
 * lane simply keeps showing "cost n/a".
 */

export interface DiscoveredPrices {
  promptCostPerMTok: number
  completionCostPerMTok: number
}

const DISCOVERY_TIMEOUT_MS = 10_000

function perMTok(perTokenUsd: unknown): number | null {
  if (typeof perTokenUsd !== 'string' && typeof perTokenUsd !== 'number') return null
  const n = Number(perTokenUsd)
  if (!Number.isFinite(n) || n < 0) return null
  return n * 1_000_000
}

export async function discoverPrices(
  endpoint: Pick<ModelEndpoint, 'baseUrl' | 'apiKey' | 'model'>,
  fetchImpl: typeof fetch = fetch,
): Promise<DiscoveredPrices | null> {
  try {
    const res = await fetchImpl(`${endpoint.baseUrl.replace(/\/$/, '')}/models`, {
      headers: endpoint.apiKey === '' ? {} : { authorization: `Bearer ${endpoint.apiKey}` },
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const body = (await res.json()) as { data?: unknown }
    if (!Array.isArray(body.data)) return null
    const row = body.data.find(
      (m): m is { id: string; pricing?: Record<string, unknown> } =>
        typeof m === 'object' && m !== null && (m as { id?: unknown }).id === endpoint.model,
    )
    if (row?.pricing === undefined) return null
    const prompt = perMTok(row.pricing.prompt)
    const completion = perMTok(row.pricing.completion)
    if (prompt === null || completion === null) return null
    return { promptCostPerMTok: prompt, completionCostPerMTok: completion }
  } catch {
    return null
  }
}

/**
 * Fill null prices on an endpoint from discovery, in place on the given copy.
 * Returns true when anything was filled (caller may log the provenance once).
 */
export function fillPrices(
  endpoint: Pick<ModelEndpoint, 'promptCostPerMTok' | 'completionCostPerMTok'>,
  discovered: DiscoveredPrices,
): boolean {
  let filled = false
  if (endpoint.promptCostPerMTok === null) {
    endpoint.promptCostPerMTok = discovered.promptCostPerMTok
    filled = true
  }
  if (endpoint.completionCostPerMTok === null) {
    endpoint.completionCostPerMTok = discovered.completionCostPerMTok
    filled = true
  }
  return filled
}
