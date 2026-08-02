import { z } from 'zod'
import { ConfigTestReq, ConfigUpdate, ConfigWriteRes, ProbeResult, PublicConfig } from './config.js'
import { ContextCandidate, ContextPreviewReq, ContextPreviewRes } from './context.js'
import { Hash } from './ids.js'
import { IllustrationHealthRes } from './illustration.js'
import { RunEvent, RunSummary } from './runs.js'
import {
  SectionContent,
  SectionContentPatch,
  SectionRow,
  SectionSummaries,
  SectionTitlePatch,
  SummariesUpdate,
} from './section.js'
import { SituationDto, SituationPut, SituationPutRes } from './situation.js'
import {
  EditingSignal,
  RestoreReq,
  RevisionEvent,
  SnippetCreate,
  SnippetDto,
  SnippetPatch,
} from './snippet.js'
import { Task, TaskEstimate, TaskSpec } from './tasks.js'
import { WorkCreate, WorkDetail, WorkPatch, WorkSummary } from './work.js'
import { WorldEntryCreate, WorldEntryDto, WorldEntryPatch } from './world.js'

/**
 * The error envelope and the typed route registry (docs/03-api.md §5.2, §6.2, §7) — one table
 * binding paths to shared schemas, consumed by the web client wrapper (`call(api.x)`) and the
 * server-side contract test (every Fastify route schema must be identity-equal to a shared
 * export; every registry entry must have a registered route, and vice versa).
 */

// ---------------------------------------------------------------------------
// §7 — Error envelope. One shape for every non-2xx JSON response; the same closed
// ErrorCode enum is reused inside SSE `task.failed` events — one taxonomy, one UI mapping.
// ---------------------------------------------------------------------------

export const ErrorCode = z.enum([
  // request-shaped
  'validation', // 400 — Zod issues in details
  'forbidden_host', // 403 — Host/Origin allowlist rejection (§5.4)
  'not_found', // 404
  'conflict', // 409 — stale baseRev/baseHash; details carry current
  'busy', // 409 — interactive lane occupied; details: {runningTaskId}
  'readonly', // 409 — second-instance lock (02 §locking)
  'payload_too_large', // 413
  // task/agent (05 §failure taxonomy; surfaced at task-create or via SSE task.failed)
  'config_missing',
  'auth',
  'endpoint_unreachable',
  'rate_limited',
  'timeout',
  'output_invalid',
  'pipeline',
  'crash',
  // registered-but-stubbed routes (§6.2) and storage entry points that land in a later stage
  'not_implemented', // 501
  // catch-all
  'internal', // 500 — includes a logRef ULID printed to the server console
])
export type ErrorCode = z.infer<typeof ErrorCode>

export const ApiErrorBody = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(), // human-readable, safe to toast
    details: z.unknown().optional(), // structured extras, schema per code
  }),
})
export type ApiErrorBody = z.infer<typeof ApiErrorBody>

// ---------------------------------------------------------------------------
// Small response shapes owned by the route table (§3).
// ---------------------------------------------------------------------------

/** GET /api/health — also the Playwright/Docker readiness probe (§3.12). */
export const HealthRes = z.object({
  ok: z.literal(true),
  version: z.string(),
  uptime: z.number().nonnegative(), // seconds since listen
})
export type HealthRes = z.infer<typeof HealthRes>

/** PATCH /sections/:s/content response. */
export const SectionContentWriteRes = z.object({ contentHash: Hash })
export type SectionContentWriteRes = z.infer<typeof SectionContentWriteRes>

/** POST /sections/:s/illustration response (user PNG upload). */
export const IllustrationVersionRes = z.object({ illustrationVersion: z.string() })
export type IllustrationVersionRes = z.infer<typeof IllustrationVersionRes>

/** POST /world/:e/image response (user PNG upload). */
export const ImageVersionRes = z.object({ imageVersion: z.string() })
export type ImageVersionRes = z.infer<typeof ImageVersionRes>

/** POST /tasks/:t/proposal/apply response — keep-partial / conflict resolution (§3.7). */
export const ProposalApplyRes = z.object({
  snippet: SnippetDto.optional(),
  section: SectionRow.optional(),
})
export type ProposalApplyRes = z.infer<typeof ProposalApplyRes>

/** GET /runs?artifact=<kind>:<id>&limit=20 query (§3.9). */
export const RunsQuery = z.object({
  artifact: z.string(), // "<kind>:<id>" — via the run_artifacts index
  limit: z.coerce.number().int().positive().max(100).default(20),
})
export type RunsQuery = z.infer<typeof RunsQuery>

// ---------------------------------------------------------------------------
// §6.2 — The route registry. `res` is the 2xx body schema; absent for 204, image bytes
// (image/png in/out is a raw body, not JSON — see `raw`), and the SSE stream.
// Stage 3/4 entries are registered-but-stubbed: routes exist so the contract test and the
// client wrapper stay total, but Stage 2 handlers return 404/501-style envelopes.
// ---------------------------------------------------------------------------

export interface RouteDef {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: (...ids: string[]) => string
  /** JSON request-body schema; absent for GET/DELETE and raw-body routes. */
  body?: z.ZodType
  /** Query-string schema, where one exists. */
  query?: z.ZodType
  /** 2xx JSON response schema; absent for 204, raw image bytes, and SSE. */
  res?: z.ZodType
  /** Non-JSON marker: raw request/response content type. */
  raw?: 'image/png' | 'text/event-stream'
  /** Success status when it isn't 200. */
  status?: 201 | 202 | 204
}

export const api = {
  // ---- works (§3.1) ----
  listWorks: { method: 'GET', path: () => '/api/works', res: z.array(WorkSummary) },
  createWork: {
    method: 'POST',
    path: () => '/api/works',
    body: WorkCreate,
    res: WorkDetail,
    status: 201,
  },
  getWork: { method: 'GET', path: (w: string) => `/api/works/${w}`, res: WorkDetail },
  patchWork: {
    method: 'PATCH',
    path: (w: string) => `/api/works/${w}`,
    body: WorkPatch,
    res: WorkDetail,
  },
  deleteWork: { method: 'DELETE', path: (w: string) => `/api/works/${w}`, status: 204 },

  // ---- document view (§3.2) ----
  listSections: {
    method: 'GET',
    path: (w: string) => `/api/works/${w}/sections`,
    res: z.array(SectionRow),
  },
  getSectionContent: {
    method: 'GET',
    path: (w: string, s: string) => `/api/works/${w}/sections/${s}/content`,
    res: SectionContent,
  },
  patchSectionContent: {
    method: 'PATCH',
    path: (w: string, s: string) => `/api/works/${w}/sections/${s}/content`,
    body: SectionContentPatch,
    res: SectionContentWriteRes,
  },
  patchSection: {
    method: 'PATCH',
    path: (w: string, s: string) => `/api/works/${w}/sections/${s}`,
    body: SectionTitlePatch,
    res: SectionRow,
  },
  getSectionSummaries: {
    method: 'GET',
    path: (w: string, s: string) => `/api/works/${w}/sections/${s}/summaries`,
    res: SectionSummaries,
  },
  putSectionSummaries: {
    method: 'PUT',
    path: (w: string, s: string) => `/api/works/${w}/sections/${s}/summaries`,
    body: SummariesUpdate,
    res: SectionRow,
  },
  // GET /sections/:s/history is structured-for but deferred post-M2 (§3.2, §13) — not registered.

  // ---- snippets (§3.3) ----
  listSnippets: {
    method: 'GET',
    path: (w: string) => `/api/works/${w}/snippets`,
    res: z.array(SnippetDto),
  },
  createSnippet: {
    method: 'POST',
    path: (w: string) => `/api/works/${w}/snippets`,
    body: SnippetCreate,
    res: SnippetDto,
    status: 201,
  },
  patchSnippet: {
    method: 'PATCH',
    path: (w: string, s: string) => `/api/works/${w}/snippets/${s}`,
    body: SnippetPatch,
    res: SnippetDto,
  },
  deleteSnippet: {
    method: 'DELETE',
    path: (w: string, s: string) => `/api/works/${w}/snippets/${s}`,
    status: 204,
  },
  listSnippetRevisions: {
    method: 'GET',
    path: (w: string, s: string) => `/api/works/${w}/snippets/${s}/revisions`,
    res: z.array(RevisionEvent),
  },
  restoreSnippet: {
    method: 'POST',
    path: (w: string, s: string) => `/api/works/${w}/snippets/${s}/restore`,
    body: RestoreReq,
    res: SnippetDto,
  },

  // ---- editing signal (§3.4) ----
  setEditing: {
    method: 'POST',
    path: (w: string) => `/api/works/${w}/editing`,
    body: EditingSignal,
    status: 204,
  },

  // ---- world (§3.5) ----
  listWorldEntries: {
    method: 'GET',
    path: (w: string) => `/api/works/${w}/world`,
    res: z.array(WorldEntryDto),
  },
  getWorldEntry: {
    method: 'GET',
    path: (w: string, e: string) => `/api/works/${w}/world/${e}`,
    res: WorldEntryDto,
  },
  createWorldEntry: {
    method: 'POST',
    path: (w: string) => `/api/works/${w}/world`,
    body: WorldEntryCreate,
    res: WorldEntryDto,
    status: 201,
  },
  patchWorldEntry: {
    method: 'PATCH',
    path: (w: string, e: string) => `/api/works/${w}/world/${e}`,
    body: WorldEntryPatch,
    res: WorldEntryDto,
  },
  deleteWorldEntry: {
    method: 'DELETE',
    path: (w: string, e: string) => `/api/works/${w}/world/${e}`,
    status: 204,
  },
  uploadWorldImage: {
    method: 'POST',
    path: (w: string, e: string) => `/api/works/${w}/world/${e}/image`,
    raw: 'image/png', // ≤ 10 MB request body
    res: ImageVersionRes,
  },
  deleteWorldImage: {
    method: 'DELETE',
    path: (w: string, e: string) => `/api/works/${w}/world/${e}/image`,
    status: 204,
  },

  // ---- situation (§3.6) ----
  getSituation: {
    method: 'GET',
    path: (w: string) => `/api/works/${w}/situation`,
    res: SituationDto,
  },
  putSituation: {
    method: 'PUT',
    path: (w: string) => `/api/works/${w}/situation`,
    body: SituationPut,
    res: SituationPutRes,
  },

  // ---- tasks (§3.7; Stage 3 stubs — the harness owns handler semantics) ----
  createTask: {
    method: 'POST',
    path: (w: string) => `/api/works/${w}/tasks`,
    body: TaskSpec,
    res: Task,
    status: 202,
  },
  listTasks: { method: 'GET', path: (w: string) => `/api/works/${w}/tasks`, res: z.array(Task) },
  getTask: {
    method: 'GET',
    path: (w: string, t: string) => `/api/works/${w}/tasks/${t}`,
    res: Task,
  },
  cancelTask: {
    method: 'POST',
    path: (w: string, t: string) => `/api/works/${w}/tasks/${t}/cancel`,
    res: Task,
    status: 202,
  },
  estimateTask: {
    method: 'POST',
    path: (w: string) => `/api/works/${w}/tasks/estimate`,
    body: TaskSpec,
    res: TaskEstimate, // M2
  },
  applyProposal: {
    method: 'POST',
    path: (w: string, t: string) => `/api/works/${w}/tasks/${t}/proposal/apply`,
    res: ProposalApplyRes,
  },
  discardProposal: {
    method: 'POST',
    path: (w: string, t: string) => `/api/works/${w}/tasks/${t}/proposal/discard`,
    status: 204,
  },

  // ---- consolidation controls (§3.8; Stage 4 stubs) ----
  consolidateNow: {
    method: 'POST',
    path: (w: string) => `/api/works/${w}/consolidate`,
    res: Task,
    status: 202,
  },
  undoConsolidation: {
    method: 'POST',
    path: (w: string, undoToken: string) => `/api/works/${w}/consolidations/${undoToken}/undo`,
    status: 204,
  },

  // ---- runs (§3.9; Stage 3 stubs). GET /usage is deferred — not registered. ----
  getRun: {
    method: 'GET',
    path: (w: string, r: string) => `/api/works/${w}/runs/${r}`,
    res: z.array(RunEvent),
  },
  listRuns: {
    method: 'GET',
    path: (w: string) => `/api/works/${w}/runs`,
    query: RunsQuery,
    res: z.array(RunSummary),
  },

  // ---- images (§3.10; handlers Stage 5, upload/delete registered from M1) ----
  getSectionIllustration: {
    method: 'GET',
    path: (w: string, s: string) => `/api/works/${w}/sections/${s}/illustration`,
    raw: 'image/png', // immutable behind ?v=<SectionRow.illustration.version>
  },
  uploadSectionIllustration: {
    method: 'POST',
    path: (w: string, s: string) => `/api/works/${w}/sections/${s}/illustration`,
    raw: 'image/png',
    res: IllustrationVersionRes,
  },
  deleteSectionIllustration: {
    method: 'DELETE',
    path: (w: string, s: string) => `/api/works/${w}/sections/${s}/illustration`,
    status: 204, // writes the suppression tombstone (08 §5); idempotent
  },
  getWorldImage: {
    method: 'GET',
    path: (w: string, e: string) => `/api/works/${w}/world/${e}/image`,
    raw: 'image/png', // immutable behind ?v=<imageVersion>
  },

  // ---- context engine (§3.11; Stage 3 stubs — 06 owns handlers). /context/state and
  // /context/usage are registered when 06 defines their DTOs. ----
  getContextCandidates: {
    method: 'GET',
    path: (w: string) => `/api/works/${w}/context/candidates`,
    res: z.array(ContextCandidate),
  },
  previewContext: {
    method: 'POST',
    path: (w: string) => `/api/works/${w}/context/preview`,
    body: ContextPreviewReq,
    res: ContextPreviewRes,
  },
  resetContext: {
    method: 'POST',
    path: (w: string) => `/api/works/${w}/context/reset`,
    status: 204,
  },

  // ---- config & meta (§3.12) ----
  health: { method: 'GET', path: () => '/api/health', res: HealthRes },
  illustrationHealth: {
    method: 'GET',
    path: () => '/api/illustration/health',
    res: IllustrationHealthRes,
  },
  getConfig: { method: 'GET', path: () => '/api/config', res: PublicConfig },
  putConfig: { method: 'PUT', path: () => '/api/config', body: ConfigUpdate, res: ConfigWriteRes },
  testConfig: {
    method: 'POST',
    path: () => '/api/config/test',
    body: ConfigTestReq,
    res: ProbeResult,
  },
  reloadConfig: { method: 'POST', path: () => '/api/config/reload', res: ConfigWriteRes },

  // ---- events (§3.13) — the one SSE stream per open work; payloads validated by WorkEvent ----
  events: {
    method: 'GET',
    path: (w: string) => `/api/works/${w}/events`,
    raw: 'text/event-stream',
  },
} as const satisfies Record<string, RouteDef>

export type ApiRoutes = typeof api
export type ApiRouteName = keyof ApiRoutes
