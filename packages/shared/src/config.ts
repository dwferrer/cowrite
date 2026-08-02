import { z } from 'zod'
import { BudgetKnobsOverrides } from './context.js'
import { ComfyConfig } from './illustration.js'
import { HarnessKnobsOverrides, Lane, TaskKind } from './tasks.js'

/**
 * App configuration — `~/.cowrite/config.jsonc` (docs/03-api.md §9).
 *
 * Zod 4 notes (the doc spells these differently; semantics are identical):
 * - nested-object `.default({})` → `.prefault({})` (defaults must be complete output objects);
 * - `z.string().url()` → `z.url()`;
 * - `BudgetKnobs.partial()` / `HarnessKnobs.partial()` → the dedicated *Overrides schemas
 *   (see context.ts / tasks.ts for why `.partial()` re-materializes defaults);
 * - `schemaVersion: z.literal(1)` carries `.default(1)` so the all-defaults empty object
 *   parses — the named regression of §12 ("AppConfig.parse({}) and the first-run template
 *   must both parse") guards this in config.test.ts.
 */

export const ModelEndpoint = z.object({
  baseUrl: z.url(), // ".../v1" — OpenAI-compatible root
  apiKey: z.string().default(''), // "" for keyless local servers
  model: z.string().min(1),
  maxOutputTokens: z.number().int().positive().default(2048),
  temperature: z.number().min(0).max(2).default(0.8),
  promptCostPerMTok: z.number().nonnegative().nullable().default(null),
  completionCostPerMTok: z.number().nonnegative().nullable().default(null),
})
export type ModelEndpoint = z.infer<typeof ModelEndpoint>

export const AppConfig = z.object({
  schemaVersion: z.literal(1).default(1),
  server: z
    .object({
      host: z.string().default('127.0.0.1'),
      port: z.number().int().min(1).max(65535).default(2697), // C-O-W-R on a phone keypad
      openBrowser: z.boolean().default(true),
      allowedHosts: z.array(z.string()).default([]), // extra Host names (§5.4)
    })
    .prefault({}),
  storage: z
    .object({
      dataDir: z.string().default('~/.cowrite/data'), // "~" expanded at load
    })
    .prefault({}),
  models: z
    .object({
      high: ModelEndpoint.nullable().default(null), // null ⇒ unconfigured ⇒ setup screen
      low: ModelEndpoint.nullable().default(null),
    })
    .prefault({}),
  comfyui: ComfyConfig.nullable().default(null), // owned by 08
  // Zod 4: z.record with an enum key schema is exhaustive; partialRecord is what
  // "per-kind overrides" means.
  routing: z.partialRecord(TaskKind, Lane).default({}),
  budgets: BudgetKnobsOverrides.default({}), // 06 §knobs, app-level overrides
  harness: HarnessKnobsOverrides.default({}), // timeouts/retries, 05 §6.4
  retention: z
    .object({
      pruneRunsAfterMonths: z.number().int().positive().nullable().default(null),
    })
    .prefault({}),
})
export type AppConfig = z.infer<typeof AppConfig>

// ---------------------------------------------------------------------------
// Update direction — PUT /api/config (§9.5: full replace) and probe candidates.
// The one shape difference: apiKey may be `null` = "keep the stored key" (the client never
// sees keys, so it cannot echo them); `""` = keyless endpoint.
// ---------------------------------------------------------------------------

export const ModelEndpointUpdate = ModelEndpoint.extend({
  apiKey: z.string().nullable().default(null), // null = keep stored; "" = keyless
})
export type ModelEndpointUpdate = z.infer<typeof ModelEndpointUpdate>

export const ConfigUpdate = AppConfig.extend({
  models: z
    .object({
      high: ModelEndpointUpdate.nullable().default(null),
      low: ModelEndpointUpdate.nullable().default(null),
    })
    .prefault({}),
})
export type ConfigUpdate = z.infer<typeof ConfigUpdate>

// ---------------------------------------------------------------------------
// Read direction — GET /api/config (§9.6). Always redacted: apiKey → {set: boolean}.
// ---------------------------------------------------------------------------

export const RedactedSecret = z.object({ set: z.boolean() })
export type RedactedSecret = z.infer<typeof RedactedSecret>

export const PublicModelEndpoint = ModelEndpoint.extend({ apiKey: RedactedSecret })
export type PublicModelEndpoint = z.infer<typeof PublicModelEndpoint>

export const ConfigOverride = z.object({
  path: z.string(), // "server.host", "models.high.apiKey", …
  by: z.enum(['env', 'flag']), // absent from the list ⇒ overriddenBy: null
})
export type ConfigOverride = z.infer<typeof ConfigOverride>

export const PublicConfig = AppConfig.extend({
  models: z
    .object({
      high: PublicModelEndpoint.nullable().default(null),
      low: PublicModelEndpoint.nullable().default(null),
    })
    .prefault({}),
  setup: z.object({
    highConfigured: z.boolean(),
    lowConfigured: z.boolean(),
    comfyConfigured: z.boolean(),
  }),
  overrides: z.array(ConfigOverride),
})
export type PublicConfig = z.infer<typeof PublicConfig>

/** PUT /api/config and POST /api/config/reload response (§3.12). */
export const ConfigWriteRes = z.object({
  config: PublicConfig,
  restartRequired: z.array(z.string()), // ["server.port", …]
})
export type ConfigWriteRes = z.infer<typeof ConfigWriteRes>

// ---------------------------------------------------------------------------
// POST /api/config/test (§3.12).
// ---------------------------------------------------------------------------

export const ProbeTarget = z.enum(['high', 'low', 'comfyui'])
export type ProbeTarget = z.infer<typeof ProbeTarget>

export const ConfigTestReq = z.object({
  target: ProbeTarget,
  candidate: ConfigUpdate.optional(), // deep-merged over the saved config before probing
})
export type ConfigTestReq = z.infer<typeof ConfigTestReq>

export const ProbeResult = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    latencyMs: z.number().int().nonnegative(),
    detail: z.string().nullable().default(null), // e.g. model list / system_stats summary
  }),
  z.object({
    ok: z.literal(false),
    code: z.enum([
      'auth',
      'endpoint_unreachable',
      'rate_limited',
      'timeout',
      'config_missing',
      'internal',
    ]),
    message: z.string(),
  }),
])
export type ProbeResult = z.infer<typeof ProbeResult>
