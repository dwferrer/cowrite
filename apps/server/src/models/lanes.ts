import type { AppConfig, HarnessKnobs, HarnessKnobsOverrides } from '@cowrite/shared'
import { HarnessKnobs as HarnessKnobsSchema } from '@cowrite/shared'
import { OpenAiCompatClient } from './client.js'

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

export function buildClients(config: AppConfig, deps: LaneDeps = {}): LaneClients {
  const knobs = resolveHarnessKnobs(config.harness)
  const high =
    config.models.high === null
      ? null
      : new OpenAiCompatClient({
          lane: 'high',
          endpoint: config.models.high,
          knobs,
          allowImageParts: false, // the high model never sees images (05 §3.1)
          ...deps,
        })
  const low =
    config.models.low === null
      ? null
      : new OpenAiCompatClient({
          lane: 'low',
          endpoint: config.models.low,
          knobs,
          allowImageParts: true, // illustration VLM critique attaches image_url parts (08)
          ...deps,
        })
  return { high, low }
}
