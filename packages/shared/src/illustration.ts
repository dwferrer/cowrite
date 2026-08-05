import { z } from 'zod'
import { Hash, IsoTime, Ulid } from './ids.js'

/**
 * Illustration metadata (docs/08-illustration.md §6). The present-state of the section
 * illustration slot (enrichment.ts) and the sidecar for world-entry images.
 */

export const IllustrationMeta = z.object({
  source: z.enum(['agent', 'user']),
  runId: Ulid.nullable(), // null iff source === "user" (uploads have no run)
  generatedAt: IsoTime,
  sourceHash: Hash.nullable(), // content.md hash at generation; null for world images & uploads
  // Word count at generation — makes the >15 % staleness rule recomputable from files alone
  // (02 §6.5); null for world images & uploads.
  sourceWordCount: z.number().int().nonnegative().nullable(),
  // Matched world-entry ids, recorded at compose time (08 §4.2); the established-imagery
  // lookup key (08 §7).
  entities: z.array(Ulid).default([]),
  prompt: z.string().nullable(), // the winning composed prompt; null for uploads
  workflow: z.string().nullable(), // registry name, e.g. "default"
  workflowHash: Hash.nullable(), // ResolvedWorkflow.contentHash at generation time
  seed: z.number().int().nullable(),
  attempts: z.number().int().min(1).nullable(), // rounds actually run
  score: z.number().min(0).max(10).nullable(), // winner's critique score
  guidance: z.string().nullable(),
})
export type IllustrationMeta = z.infer<typeof IllustrationMeta>

/**
 * VLM critique result (docs/08-illustration.md §4.3). One low-model call per successful attempt
 * scores the image on a four-axis rubric; the loop stops early iff
 * `verdict === "accept" && overall >= acceptScore`. Parsed from a fenced JSON block with one
 * repair retry, then a neutral `{verdict: "revise", overall: 5}` fallback (§10) so a flaky critic
 * never wedges the loop. Recorded verbatim as a `vlm.critique` toolCall run event.
 */
export const CritiqueResult = z.object({
  verdict: z.enum(['accept', 'revise']),
  scores: z.object({
    subject: z.number().min(0).max(5), // is the chosen moment depicted? key elements present?
    consistency: z.number().min(0).max(5), // do characters/places match the brief's descriptions?
    craft: z.number().min(0).max(5), // artifacts: anatomy, garbled text, bad crops, dup limbs
    mood: z.number().min(0).max(5), // tone/lighting/palette vs the section's mood
  }),
  overall: z.number().min(0).max(10),
  problems: z.array(z.string()).max(5), // concrete, e.g. "the lighthouse is absent"
  promptAdvice: z.string().max(600), // one actionable rewrite instruction for the reviser
})
export type CritiqueResult = z.infer<typeof CritiqueResult>

/** Pipeline phase enum (08 §8) — the vocabulary of SSE `task.progress` (03 §8.2). */
export const PipelinePhase = z.enum([
  'composing',
  'submitting',
  'queued',
  'generating',
  'critiquing',
  'revising',
  'committing',
])
export type PipelinePhase = z.infer<typeof PipelinePhase>

// ---------------------------------------------------------------------------
// ComfyUI configuration (08 §3) — `config.comfyui`.
// OWNER: 08-illustration.md (Stage 5). Minimal placeholder with exactly the fields
// 03 §9.2 recaps so AppConfig can embed it; the workflow registry that validates
// the referenced files lands with the pipeline.
// ---------------------------------------------------------------------------

export const WorkflowEntryConfig = z.object({
  file: z.string().min(1), // relative to workflowsDir
  label: z.string().min(1),
  execTimeoutMs: z.number().int().positive().optional(), // per-workflow override (hq graphs are slower)
})
export type WorkflowEntryConfig = z.infer<typeof WorkflowEntryConfig>

// The doc spells this `.partial().default({})` inside ComfyConfig (08 §3), but zod 4
// re-materializes defaults under `.partial()` (see context.ts). Since these ARE the effective
// defaults with no further override chain, parsing to the full effective set is equivalent —
// `.prefault({})` keeps the wire semantics without the partial gotcha.
export const IllustrationTimeouts = z.object({
  healthTimeoutMs: z.number().int().positive().default(3_000),
  connectTimeoutMs: z.number().int().positive().default(5_000),
  queueTimeoutMs: z.number().int().positive().default(120_000),
  execTimeoutMs: z.number().int().positive().default(300_000),
  wsFallbackMs: z.number().int().positive().default(10_000),
})
export type IllustrationTimeouts = z.infer<typeof IllustrationTimeouts>

export const ComfyConfig = z.object({
  baseUrl: z.url(),
  workflowsDir: z.string().optional(), // default resolves to <configDir>/workflows at load
  workflows: z.record(z.string().regex(/^[a-z0-9-]+$/), WorkflowEntryConfig).default({}),
  route: z
    .object({
      section: z.string().default('default'),
      world: z.string().default('default'),
    })
    .prefault({}),
  loop: z
    .object({
      maxAttempts: z.number().int().min(1).max(6).default(3),
      acceptScore: z.number().min(0).max(10).default(7),
    })
    .prefault({}),
  timeouts: IllustrationTimeouts.prefault({}),
})
export type ComfyConfig = z.infer<typeof ComfyConfig>

/** GET /api/illustration/health response (08 §8) — powers the settings-page status row. */
export const IllustrationHealthRes = z.object({
  ok: z.boolean(),
  comfy: z.object({ ok: z.boolean(), detail: z.string().optional() }),
  workflows: z.array(
    z.object({
      name: z.string(),
      label: z.string(),
      ok: z.boolean(),
      error: z.string().optional(),
    }),
  ),
  route: z.object({
    section: z.object({ name: z.string(), ok: z.boolean() }),
    world: z.object({ name: z.string(), ok: z.boolean() }),
  }),
})
export type IllustrationHealthRes = z.infer<typeof IllustrationHealthRes>
