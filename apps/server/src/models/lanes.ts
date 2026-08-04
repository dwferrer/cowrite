import type { AppConfig, HarnessKnobs, HarnessKnobsOverrides, ModelEndpoint } from '@cowrite/shared'
import { HarnessKnobs as HarnessKnobsSchema } from '@cowrite/shared'
import { OpenAiCompatClient } from './client.js'
import { type DiscoveredPrices, discoverPrices, fillPrices } from './pricing.js'

/**
 * Model lanes (docs/05-agents.md §3.1): two clients built from `AppConfig.models`.
 *
 * Hard invariant, enforced here by construction: the HIGH client rejects any message
 * carrying image content parts (typed `validation` error before any bytes leave the
 * process); only the LOW client accepts `image_url` parts (Stage 5 VLM critique).
 *
 * An unconfigured lane builds to `null` — task creation surfaces `409 config_missing`
 * (05 §3.1); nothing here throws for missing config. Sampler params (temperature,
 * maxOutputTokens) come from the `ModelEndpoint` config; timeout/retry knobs from
 * `config.harness` resolved over the HarnessKnobs defaults (05 §6.4).
 */

export interface LaneClients {
  high: OpenAiCompatClient | null
  low: OpenAiCompatClient | null
}

/** Test-seam deps threaded into both clients (fast sleeps, scripted fetch). */
export interface LaneDeps {
  fetchImpl?: typeof fetch
  sleepImpl?: (ms: number) => Promise<void>
  random?: () => number
}

/** Sparse `config.harness` overrides → full knob set (defaults from the schema, 05 §6.4). */
export function resolveHarnessKnobs(overrides: HarnessKnobsOverrides): HarnessKnobs {
  return HarnessKnobsSchema.parse(overrides)
}

/**
 * Per-process price-discovery cache keyed by `baseUrl|model`: clients are built per task
 * (harness submit), so discovery must fire once per endpoint, not once per client. Filled
 * prices land on each client's endpoint COPY — the AppConfig object is never mutated, and
 * config-set prices always win (fillPrices only fills nulls).
 */
const priceDiscovery = new Map<string, Promise<DiscoveredPrices | null>>()
const priceLogged = new Set<string>()

export function resetPriceDiscoveryCache(): void {
  priceDiscovery.clear()
  priceLogged.clear()
}

function withDiscoveredPrices(
  endpoint: ModelEndpoint,
  fetchImpl: typeof fetch | undefined,
): ModelEndpoint {
  const copy = { ...endpoint }
  if (copy.promptCostPerMTok !== null && copy.completionCostPerMTok !== null) return copy
  const key = `${copy.baseUrl}|${copy.model}`
  let pending = priceDiscovery.get(key)
  if (pending === undefined) {
    pending = discoverPrices(copy, fetchImpl)
    priceDiscovery.set(key, pending)
  }
  void pending.then((found) => {
    if (found === null) return
    if (fillPrices(copy, found) && !priceLogged.has(key)) {
      priceLogged.add(key)
      console.log(
        `[models] prices for ${copy.model} from the API: ` +
          `$${found.promptCostPerMTok.toFixed(3)}/$${found.completionCostPerMTok.toFixed(3)} per MTok`,
      )
    }
  })
  return copy
}

export function buildClients(config: AppConfig, deps: LaneDeps = {}): LaneClients {
  const knobs = resolveHarnessKnobs(config.harness)
  const high =
    config.models.high === null
      ? null
      : new OpenAiCompatClient({
          lane: 'high',
          endpoint: withDiscoveredPrices(config.models.high, deps.fetchImpl),
          knobs,
          allowImageParts: false, // the high model never sees images (05 §3.1)
          ...deps,
        })
  const low =
    config.models.low === null
      ? null
      : new OpenAiCompatClient({
          lane: 'low',
          endpoint: withDiscoveredPrices(config.models.low, deps.fetchImpl),
          knobs,
          allowImageParts: true, // illustration VLM critique attaches image_url parts (08)
          ...deps,
        })
  return { high, low }
}
