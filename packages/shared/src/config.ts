import { z } from 'zod'
import { BudgetKnobsOverrides } from './context.js'
import { ComfyConfig } from './illustration.js'
import { Lane, TaskKind } from './tasks.js'

/**
 * App configuration — `~/.cowrite/config.jsonc` (docs/03-api.md §9).
 *
 * Zod 4 notes (the doc spells these differently; semantics are identical):
 * - nested-object `.default({})` → `.prefault({})` (defaults must be complete output objects);
 * - `z.string().url()` → `z.url()`;
 * - `BudgetKnobs.partial()` / `HarnessKnobs.partial()` → the dedicated *Overrides schemas
 *   (see context.ts / the HarnessKnobsOverrides note below for why `.partial()`
 *   re-materializes defaults);
 * - `schemaVersion: z.literal(1)` carries `.default(1)` so the all-defaults empty object
 *   parses — the named regression of §12 ("AppConfig.parse({}) and the first-run template
 *   must both parse") guards this in config.test.ts.
 */

// ---------------------------------------------------------------------------
// Harness knobs (05 §6.4) — `config.harness`, the transport ladder the runner owns:
// timeouts, retries, and the illustration run budget (the pipeline reads it via
// `RunContext.remainingMs()`). `retry.backoffMs → backoffMaxMs` is the doc's
// "1 000 → 4 000 (+ full jitter)" ladder; `Retry-After` on 429 is honored above it.
//
// Deliberately NOT here — referenced, never duplicated:
// - planning caps (`maxPlanningRounds`, `maxPlanningRoundsQuickEdit`, `maxToolCalls`,
//   `maxToolResultTokens`): the engine owns them in `BudgetKnobs` (06 §8.1,
//   `config.budgets`); the harness keeps no round counter of its own (05 §4.2).
// - lane capacities: fixed policy, not config — `QUEUE_LANE_CAPACITY` in tasks.ts (05 §6.1).
// ---------------------------------------------------------------------------

export const HarnessKnobs = z.object({
  connectTimeoutMs: z.number().int().positive().default(15_000), // TCP/TLS + request write
  firstTokenTimeoutMs: z.number().int().positive().default(60_000), // sent → first stream event
  idleTokenTimeoutMs: z.number().int().positive().default(30_000), // gap between stream events
  totalTimeoutMs: z
    .object({
      high: z.number().int().positive().default(300_000), // whole model call, high lane
      // The low lane runs the reasoning-heavy background tasks (boundary decisions,
      // enrichment); a reasoning model deliberating a whole chapter needs writing-lane
      // headroom, so this matches the high lane rather than the old tight 120 s.
      low: z.number().int().positive().default(300_000), // whole model call, low lane
    })
    .prefault({}),
  illustrationBudgetMs: z.number().int().positive().default(600_000), // whole illustration run
  retry: z
    .object({
      maxAttempts: z.number().int().min(1).default(3), // per logical model call: total attempts
      backoffMs: z.number().int().positive().default(1_000),
      backoffMaxMs: z.number().int().positive().default(4_000),
    })
    .prefault({}),
  // Per-process cumulative spend guard (derived cost summed across runs since boot).
  // Crossing spendWarnUsd emits a one-time `spend.warning` event + console notice;
  // crossing spendStopUsd makes NEW task submissions fail until restart or a knob change.
  // null disables the threshold.
  spendWarnUsd: z.number().nonnegative().nullable().default(5),
  spendStopUsd: z.number().nonnegative().nullable().default(null),
})
export type HarnessKnobs = z.infer<typeof HarnessKnobs>

// The doc spells the config field `HarnessKnobs.partial().default({})` (03 §9.2), but zod 4
// fires ZodDefault even under the ZodOptional that `.partial()` adds — a sparse override
// object would parse into a full knob set (see context.ts BudgetKnobsOverrides for the same
// gotcha). Hand-written optional shape keeps true Partial<HarnessKnobs> semantics.
export const HarnessKnobsOverrides = z.object({
  connectTimeoutMs: z.number().int().positive().optional(),
  firstTokenTimeoutMs: z.number().int().positive().optional(),
  idleTokenTimeoutMs: z.number().int().positive().optional(),
  totalTimeoutMs: z
    .object({
      high: z.number().int().positive().optional(),
      low: z.number().int().positive().optional(),
    })
    .optional(),
  illustrationBudgetMs: z.number().int().positive().optional(),
  retry: z
    .object({
      maxAttempts: z.number().int().min(1).optional(),
      backoffMs: z.number().int().positive().optional(),
      backoffMaxMs: z.number().int().positive().optional(),
    })
    .optional(),
  spendWarnUsd: z.number().nonnegative().nullable().optional(),
  spendStopUsd: z.number().nonnegative().nullable().optional(),
})
export type HarnessKnobsOverrides = z.infer<typeof HarnessKnobsOverrides>

/**
 * Reasoning controls for reasoning models (OpenAI `reasoning_effort` + OpenRouter's
 * `reasoning` object). Reasoning models spend hidden thinking tokens before answering, and
 * some — Qwen's QwQ line especially, more so at low quantization — get stuck in reasoning
 * loops that exhaust the budget. `effort` dials the depth down; `maxTokens` hard-caps the
 * thinking so it can never loop past a ceiling (a separate budget from `maxOutputTokens`).
 */
export const ReasoningControls = z.object({
  effort: z.enum(['minimal', 'low', 'medium', 'high']).nullable().default(null),
  maxTokens: z.number().int().positive().nullable().default(null), // OpenRouter reasoning.max_tokens
  exclude: z.boolean().default(false), // think internally but omit reasoning from the response
})
export type ReasoningControls = z.infer<typeof ReasoningControls>

/**
 * OpenRouter provider-routing preferences, passed through to the request `provider` field
 * verbatim (docs: openrouter.ai/docs/features/provider-routing). Common keys: `order`,
 * `only`, `ignore` (provider slugs), `quantizations` (e.g. ["fp16","fp8"] — pin a higher
 * quant to dodge low-quant reasoning loops), `sort` ("price"|"throughput"|"latency"),
 * `allow_fallbacks`, `require_parameters`. Typed loose + passthrough for forward-compat;
 * ignored by non-OpenRouter servers. Only emitted when set.
 */
export const ProviderRouting = z.looseObject({})
export type ProviderRouting = z.infer<typeof ProviderRouting>

export const ModelEndpoint = z.object({
  baseUrl: z.url(), // ".../v1" — OpenAI-compatible root
  apiKey: z.string().default(''), // "" for keyless local servers
  model: z.string().min(1),
  // Generous by default: reasoning models spend hidden reasoning tokens against this same
  // budget before emitting content, so a tight ceiling truncates the visible answer. Cheap
  // per-token models make the headroom nearly free; lower it in config for expensive ones.
  maxOutputTokens: z.number().int().positive().default(8192),
  temperature: z.number().min(0).max(2).default(0.8),
  promptCostPerMTok: z.number().nonnegative().nullable().default(null),
  completionCostPerMTok: z.number().nonnegative().nullable().default(null),
  reasoning: ReasoningControls.nullable().default(null),
  provider: ProviderRouting.nullable().default(null),
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
