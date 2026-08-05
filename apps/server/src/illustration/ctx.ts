import type { IllustrationMeta, PipelinePhase, RunEventInput } from '@cowrite/shared'
import type { ChatOpts, ChatRequest, ChatResult } from '../models/client.js'
import type { SectionRow } from '../storage/index/db.js'
import type { ComfyClient, ComfyProgress, ComfyResult } from './comfy/client.js'
import type { WorkflowRegistry } from './comfy/registry.js'

/**
 * The illustration pipeline's `RunContext` — the seam the harness implements when it hands an
 * `illustrate-section` / `world-image` run to this subsystem (docs/05-agents.md §13 illustration
 * handoff; docs/08-illustration.md §4). The five members 05 §13 names — `lowClient`, `emit`,
 * `progress`, `signal`, `remainingMs` — keep their exact spelling; this doc's pipeline additionally
 * needs the ComfyUI client, the storage commit/read surface, a `sharp`-backed downscaler, the
 * workflow registry, the loop knobs, the loaded template set, and the run id, so the harness
 * supplies those too. Everything here is an interface: the loop, composer, and critic are driven
 * entirely through it, so unit tests inject fakes with no HTTP, no models, and no ComfyUI (§11).
 */

// ---------------------------------------------------------------------------
// Low lane (05 §13: `lowClient`) — the structural subset the pipeline drives.
// `OpenAiCompatClient` satisfies it; the low lane is the only lane that accepts
// `image_url` content parts (05 §3.1), which the critic relies on.
// ---------------------------------------------------------------------------

export interface LowLaneClient {
  chat(request: ChatRequest, opts?: ChatOpts): Promise<ChatResult>
}

// ComfyUI client (docs/08 §2.3) — the interface OWNED by comfy/client.ts; re-exported here so
// the loop/testkit reference one type. `generate`'s request shape is inlined on `ComfyClient`.
export type { ComfyClient, ComfyProgress, ComfyResult }

/** The `generate` request shape (mirrors `ComfyClient.generate`'s inline parameter, §2.3). */
export interface ComfyGenerateRequest {
  workflow: Record<string, unknown>
  outputNodeId: string
  deadlineMs: number
  execTimeoutMs?: number
  signal: AbortSignal
  onProgress: (p: ComfyProgress) => void
}

// ---------------------------------------------------------------------------
// Storage commit + read surface (02 §StorageService). WorkHandle satisfies this
// structurally; the pipeline reads intent material and commits the winner only.
// ---------------------------------------------------------------------------

/** Parsed world entry as the pipeline consumes it (02 §StorageService `matchWorldEntries`). */
export interface BriefWorldEntry {
  meta: { id: string; name: string }
  body: string
}

export interface IllustrationStorage {
  getSection(sectionId: string): SectionRow | null
  getSectionContent(sectionId: string): Promise<{ text: string; contentHash: string }>
  getSummaries(sectionId: string): Promise<{ short: string | null; long: string | null }>
  getWorldEntry(entryId: string): Promise<{ meta: { id: string; name: string }; body: string }>
  matchWorldEntries(text: string): Promise<BriefWorldEntry[]>
  /**
   * Established-imagery lookup (§4.2, §7): the illustration metas whose recorded `entities`
   * intersect `entityIds` (the matched world-entry ids). Targeted by design — world images are
   * keyed by entry id and read directly, and only index-flagged illustrated sections are read —
   * so a compose never walks the whole section tree + every world sidecar just to find ≤3 priors.
   */
  listIllustrationMetasByEntities(
    entityIds: string[],
  ): Promise<Array<{ kind: 'section' | 'world'; id: string; meta: IllustrationMeta }>>
  putIllustration(sectionId: string, png: Uint8Array, meta: IllustrationMeta): Promise<void>
  putWorldImage(
    entryId: string,
    png: Uint8Array,
    meta: IllustrationMeta,
  ): Promise<{ imagePath: string }>
}

// ---------------------------------------------------------------------------
// Image ops (§4.3) — the `sharp`-backed downscaler the critic feeds the VLM.
// SEAM: provided by the ComfyClient task's imageOps helper; injected here so the
// critic stays pure and the unit tests need no `sharp`.
// ---------------------------------------------------------------------------

export interface ImageOps {
  /** Downscale a PNG to `maxEdge` px on its longest side, re-encoded as PNG (§4.3). */
  downscalePng(png: Uint8Array, maxEdge: number): Promise<Uint8Array>
  /** Re-encode any decodable image (WebP/JPEG from an exotic save node) to PNG before commit
   *  (§10 format guard). Rejects on an undecodable buffer — the caller fails the attempt. */
  transcodeToPng(png: Uint8Array): Promise<Uint8Array>
}

// ---------------------------------------------------------------------------
// Progress (05 §13) — forwarded verbatim as the canonical `task.progress` WorkEvent.
// ---------------------------------------------------------------------------

export interface IllustrationProgress {
  phase: PipelinePhase
  attempt: number
  maxAttempts: number
  /** ComfyUI sampler progress; null outside the "generating" phase. */
  pct: number | null
}

// ---------------------------------------------------------------------------
// The RunContext the pipeline consumes.
// ---------------------------------------------------------------------------

export interface RunContext {
  /** taskId == runId (05 §7): stamped into `IllustrationMeta.runId`. */
  runId: string
  lowClient: LowLaneClient
  comfy: ComfyClient
  storage: IllustrationStorage
  imageOps: ImageOps
  /** Resolves the route workflow; a broken/dangling route yields `config_missing` (§3). */
  registry: WorkflowRegistry
  /** `comfyui.loop` knobs (§3): default `maxAttempts` 3, `acceptScore` 7. */
  loop: { maxAttempts: number; acceptScore: number }
  /** The loaded prompt template set — its `promptsHash` is stamped by the harness (07 §9). */
  templates: import('../prompt/templates/loader.js').TemplateSet
  /** Recorded on the harness's run file (05 §13). */
  emit(e: RunEventInput): void
  /** Forwarded as `task.progress` WorkEvents (05 §13). */
  progress(p: IllustrationProgress): void
  signal: AbortSignal
  /** Remaining `illustrationBudgetMs`; checked before each attempt (§4.4). */
  remainingMs(): number
}

// ---------------------------------------------------------------------------
// Typed failures.
// ---------------------------------------------------------------------------

/** The pipeline's task-failure codes (05 §11): `pipeline` or `config_missing`. */
export type IllustrationErrorCode = 'pipeline' | 'config_missing'

/**
 * A terminal pipeline failure. `detail` is the §8 badge string
 * (`comfy_unreachable` | `workflow_invalid` | `comfy_exec_error` | `comfy_timeout` |
 * `commit_target_missing`) for `code: 'pipeline'`, or the registry's reason for
 * `config_missing`.
 */
export class IllustrationError extends Error {
  constructor(
    readonly code: IllustrationErrorCode,
    readonly detail: string,
    options?: { cause?: unknown },
  ) {
    super(detail, options)
    this.name = 'IllustrationError'
  }
}

/** Thrown when `ctx.signal` aborts (user cancel / work close): the run ends `cancelled`, nothing
 *  commits (§4.4). Distinct from `IllustrationError` so the harness maps it to `cancelled`. */
export class IllustrationAbortedError extends Error {
  constructor() {
    super('illustration run aborted')
    this.name = 'IllustrationAbortedError'
  }
}
