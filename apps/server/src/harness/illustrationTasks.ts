import fsp from 'node:fs/promises'
import path from 'node:path'
import type { ComfyConfig, ErrorCode, RunArtifact, Task, TaskSpec } from '@cowrite/shared'
import type { WorkEventBus } from '../events/bus.js'
import { ComfyHttpClient } from '../illustration/comfy/client.js'
import {
  loadWorkflowRegistry,
  SAMPLE_WORKFLOW_FILENAME,
  sampleWorkflowPath,
  type WorkflowRegistry,
} from '../illustration/comfy/registry.js'
import type {
  ComfyClient,
  IllustrationProgress,
  ImageOps,
  RunContext,
} from '../illustration/ctx.js'
import { IllustrationAbortedError, IllustrationError } from '../illustration/ctx.js'
import { downscalePng, transcodeToPng } from '../illustration/imageOps.js'
import type { IllustrationPipeline } from '../illustration/index.js'
import type { OpenAiCompatClient } from '../models/client.js'
import { deriveCostUsd } from '../models/usage.js'
import type { TemplateSet } from '../prompt/templates/loader.js'
import { StorageError } from '../storage/errors.js'
import type { RunSink } from '../storage/runStore.js'
import type { WorkHandle } from '../storage/service.js'
import { classifyFailure } from './runner.js'

/**
 * The Stage-5 illustration task path (docs/05-agents.md §13 illustration handoff;
 * docs/08-illustration.md §4, §5, §8). `illustrate-section` / `world-image` run on the
 * app-wide illustration lane (harness/service.ts). This module owns the harness↔pipeline
 * seam: it builds the workflow registry + ComfyUI client from `config.comfyui`
 * (`buildIllustrationRuntime`) and, per run, constructs the `RunContext` the pipeline
 * consumes and drives `IllustrationPipeline.runSectionIllustration` /`runWorldImage`,
 * recording the full loop transcript (meta → composer/critic/loop events → result) through
 * the same run sink as every other kind, forwarding pipeline progress as `task.progress`,
 * and publishing the `task.*` SSE family. Config `config_missing` / target 404s are the
 * caller's (submit-time); this layer maps only the run-time pipeline failures (§8 details).
 */

// ---------------------------------------------------------------------------
// The illustration runtime: registry + ComfyUI client, rebuilt on config apply.
// ---------------------------------------------------------------------------

export interface IllustrationRuntime {
  /** The `config.comfyui` snapshot this runtime was built from (reference-compared for reload). */
  comfyConfig: ComfyConfig
  registry: WorkflowRegistry
  client: ComfyClient
  /** Resolved workflow directory (`comfyui.workflowsDir` or `<configDir>/workflows`). */
  workflowsDir: string
  /** Release the shared ComfyUI websocket (on config reload / shutdown). */
  close(): void
}

export interface BuildRuntimeOptions {
  /** Base for the default `<configDir>/workflows` when `comfyui.workflowsDir` is unset. */
  configDir: string
  /** Test seam: build the ComfyUI client (defaults to `ComfyHttpClient` over `baseUrl`). */
  buildComfyClient?: (comfy: ComfyConfig, workflowsDir: string) => ComfyClient
  /** Skip the first-run sample copy (tests provide their own workflow dir). */
  skipSampleCopy?: boolean
}

/** Resolve the workflow directory the same way the registry does at load. */
export function resolveWorkflowsDir(comfy: ComfyConfig, configDir: string): string {
  return comfy.workflowsDir ?? path.join(configDir, 'workflows')
}

/**
 * Copy the shipped sample workflow into `workflowsDir/default.json` on first run if absent
 * (§3, "Cowrite ships a sample default.json"). Never overwrites a user's file, and a copy
 * failure is swallowed — a missing workflow simply surfaces as a per-entry registry error.
 */
export async function copySampleWorkflowIfAbsent(workflowsDir: string): Promise<void> {
  const dest = path.join(workflowsDir, SAMPLE_WORKFLOW_FILENAME)
  try {
    await fsp.mkdir(workflowsDir, { recursive: true })
    await fsp.access(dest)
  } catch {
    try {
      await fsp.copyFile(sampleWorkflowPath(), dest)
    } catch {
      // Best-effort: an unwritable dir / missing sample is a per-workflow registry error,
      // never fatal (§3 "registry errors are per-workflow and task-time").
    }
  }
}

/**
 * Build the illustration runtime from a `config.comfyui` block. Never throws: a broken or
 * dangling workflow is a per-entry record surfaced at task time (`config_missing`), not a
 * boot failure (§3). The ComfyUI client is lazy — no connection is opened here.
 */
/** Name of the default workflow — matches `route.*`'s default and the sample filename. */
const DEFAULT_WORKFLOW_NAME = SAMPLE_WORKFLOW_FILENAME.replace(/\.json$/, '')

/**
 * Ensure a `workflows.default` entry exists so the default `route.section`/`route.world` don't
 * dangle (§18). Copying the sample default.json to disk isn't enough on its own — the registry
 * only knows the workflows the config names, so a config that set only `baseUrl` (empty
 * `workflows`) would resolve `config_missing` forever. Leaves an existing `default` untouched.
 */
function withDefaultWorkflow(comfy: ComfyConfig): ComfyConfig {
  if (Object.hasOwn(comfy.workflows, DEFAULT_WORKFLOW_NAME)) return comfy
  return {
    ...comfy,
    workflows: {
      ...comfy.workflows,
      [DEFAULT_WORKFLOW_NAME]: { file: SAMPLE_WORKFLOW_FILENAME, label: 'Default' },
    },
  }
}

export async function buildIllustrationRuntime(
  comfy: ComfyConfig,
  opts: BuildRuntimeOptions,
): Promise<IllustrationRuntime> {
  const workflowsDir = resolveWorkflowsDir(comfy, opts.configDir)
  if (opts.skipSampleCopy !== true) await copySampleWorkflowIfAbsent(workflowsDir)
  // Register the copied sample under the default name so the default routes resolve (§18).
  const registry = await loadWorkflowRegistry(withDefaultWorkflow(comfy), { workflowsDir })
  const client =
    opts.buildComfyClient?.(comfy, workflowsDir) ??
    new ComfyHttpClient({ baseUrl: comfy.baseUrl, timeouts: comfy.timeouts })
  return {
    comfyConfig: comfy,
    registry,
    client,
    workflowsDir,
    close: () => {
      ;(client as { close?: () => void }).close?.()
    },
  }
}

/** The `sharp`-backed image ops: the critic-facing downscaler (§4.3) and the pre-commit
 *  PNG transcode for exotic save-node formats (§10). */
export const sharpImageOps: ImageOps = {
  downscalePng: (png, maxEdge) => downscalePng(Buffer.from(png), maxEdge),
  transcodeToPng: (png) => transcodeToPng(Buffer.from(png)),
}

// ---------------------------------------------------------------------------
// The run: build the RunContext and drive the pipeline, recording the transcript.
// ---------------------------------------------------------------------------

export type IllustrationSpec = Extract<TaskSpec, { kind: 'illustrate-section' | 'world-image' }>

export interface IllustrationRunDeps {
  handle: WorkHandle
  bus: WorkEventBus
  /** The low lane (VLM critique attaches `image_url` parts — 05 §3.1). */
  lowClient: OpenAiCompatClient
  comfy: ComfyClient
  registry: WorkflowRegistry
  imageOps: ImageOps
  templates: TemplateSet
  pipeline: IllustrationPipeline
  /** `comfyui.loop` knobs (§3). */
  loop: { maxAttempts: number; acceptScore: number }
  /** `config.harness.illustrationBudgetMs` (05 §6.4) — the whole run budget. */
  illustrationBudgetMs: number
  /** Records the latest progress so a mid-run SSE reconnect can replay the caption (§19). */
  onProgress?: (p: IllustrationProgress) => void
  now?: () => Date
  warn?: (message: string) => void
}

export interface IllustrationRunResult {
  status: 'ok' | 'error' | 'cancelled'
  error: { code: ErrorCode; message: string; retryable: boolean } | null
  artifacts: RunArtifact[]
  usageTotal: { promptTokens: number; completionTokens: number; estimated: boolean }
}

/**
 * Which pipeline details render with a retry button (transient failures worth re-running).
 * Non-retryable: workflow_invalid / config_missing (fix the config), commit_target_missing
 * (the section is gone), commit_failed / transcode_failed (a re-run hits the same disk/format
 * fault). Everything else — a flaky box, a busy composer, a run that simply ran out of budget —
 * a plain retry can clear.
 */
export function retryablePipelineDetail(detail: string): boolean {
  return (
    detail === 'comfy_unreachable' ||
    detail === 'comfy_timeout' ||
    detail === 'comfy_exec_error' ||
    detail === 'budget_exhausted' ||
    detail === 'compose_failed' ||
    detail === 'critique_failed'
  )
}

/** Map a run-time pipeline throw to the 05 §11 error taxonomy. */
function classifyIllustrationFailure(err: unknown): {
  code: ErrorCode
  message: string
  retryable: boolean
} {
  if (err instanceof IllustrationError) {
    return {
      code: err.code,
      message: err.detail,
      retryable: err.code === 'pipeline' && retryablePipelineDetail(err.detail),
    }
  }
  // A vanished commit target that surfaced as a storage error rather than the pipeline's
  // own `commit_target_missing` guard.
  if (err instanceof StorageError && err.code === 'not_found') {
    return { code: 'not_found', message: err.message, retryable: false }
  }
  return classifyFailure(err)
}

/**
 * Run one `illustrate-section` / `world-image` task. Builds the `RunContext` (05 §13), drives
 * the pipeline, records the transcript (meta → pipeline `RunEvent`s → result) through the run
 * sink, and publishes `task.progress`/`task.artifact`/`task.usage`/`task.completed`
 * (or `task.failed`/`task.cancelled`). Never rejects — every outcome is a resolved
 * `IllustrationRunResult` so the lane job settles cleanly.
 */
export async function runIllustrationTask(
  task: Task,
  spec: IllustrationSpec,
  deps: IllustrationRunDeps,
  signal: AbortSignal,
): Promise<IllustrationRunResult> {
  const runId = task.id
  const now = deps.now ?? (() => new Date())
  const publish = deps.bus.publish.bind(deps.bus)
  const startMs = now().getTime()
  const endpoint = deps.lowClient.endpoint
  const usageTotal = { promptTokens: 0, completionTokens: 0, estimated: false }

  let sink: RunSink | null = null
  // Un-awaited sink appends (the pipeline's `emit` stream), settled BEFORE the result event.
  const sideEffects: Promise<void>[] = []
  const collect = (p: Promise<void>): void => {
    p.catch(() => {})
    sideEffects.push(p)
  }

  const ctx: RunContext = {
    runId,
    lowClient: deps.lowClient,
    comfy: deps.comfy,
    storage: deps.handle,
    imageOps: deps.imageOps,
    registry: deps.registry,
    loop: deps.loop,
    templates: deps.templates,
    emit: (event) => {
      if (event.type === 'usage') {
        usageTotal.promptTokens += event.promptTokens
        usageTotal.completionTokens += event.completionTokens
        if (event.estimated === true) usageTotal.estimated = true
      }
      // The sink exists by the time the pipeline emits (meta is appended first).
      if (sink !== null) collect(sink.append(event))
    },
    progress: (p) => {
      // Record the latest progress BEFORE publishing so a reconnect that races this frame still
      // replays the current caption on attach (§19).
      deps.onProgress?.(p)
      publish({
        type: 'task.progress',
        taskId: runId,
        phase: p.phase,
        attempt: p.attempt,
        maxAttempts: p.maxAttempts,
        pct: p.pct,
      })
    },
    signal,
    remainingMs: () => Math.max(0, deps.illustrationBudgetMs - (now().getTime() - startMs)),
  }

  const publishUsage = (): void => {
    publish({
      type: 'task.usage',
      taskId: runId,
      promptTokens: usageTotal.promptTokens,
      completionTokens: usageTotal.completionTokens,
      estimated: usageTotal.estimated,
      costUsd: deriveCostUsd(usageTotal, endpoint),
    })
  }

  try {
    await deps.handle.reconcile() // pre-run, 02 §reconciler / 03 §4.1 cadence
    sink = await deps.handle.recordRun(runId, task.startedAt ?? now().toISOString())
    await sink.append({
      type: 'meta',
      runId,
      kind: spec.kind,
      lane: deps.lowClient.lane,
      model: endpoint.model,
      spec,
      params: {
        promptsHash: deps.templates.promptsHash,
        temperature: endpoint.temperature,
        maxOutputTokens: endpoint.maxOutputTokens,
      },
      contextSnapshot: null, // no context-engine assembly (the pipeline reads storage directly)
      startedAt: task.startedAt ?? now().toISOString(),
    })

    const artifacts =
      spec.kind === 'illustrate-section'
        ? await deps.pipeline.runSectionIllustration(spec.sectionId, spec.guidance, ctx)
        : await deps.pipeline.runWorldImage(spec.entryId, spec.guidance, ctx)

    // The pipeline's emitted events settle BEFORE the result — a failing append fails the
    // run while nothing extra has been recorded past it.
    await Promise.all(sideEffects)
    sideEffects.length = 0

    try {
      await sink.append({
        type: 'result',
        status: 'ok',
        usageTotal,
        partialText: null,
        artifacts,
        endedAt: now().toISOString(),
      })
    } catch (appendErr) {
      ;(deps.warn ?? console.warn)(
        `run ${runId}: result append failed after commit: ${String(appendErr)}`,
      )
    }
    for (const artifact of artifacts) publish({ type: 'task.artifact', taskId: runId, artifact })
    publishUsage()
    publish({ type: 'task.completed', taskId: runId })
    return { status: 'ok', error: null, artifacts, usageTotal }
  } catch (err) {
    const cancelled = signal.aborted || err instanceof IllustrationAbortedError
    const failure = cancelled ? null : classifyIllustrationFailure(err)
    await Promise.allSettled(sideEffects)
    if (sink !== null && !sink.closed) {
      await sink
        .append({
          type: 'result',
          status: cancelled ? 'cancelled' : 'error',
          ...(failure === null ? {} : { error: { code: failure.code, message: failure.message } }),
          usageTotal,
          partialText: null,
          artifacts: [],
          endedAt: now().toISOString(),
        })
        .catch(() => {})
    }
    publishUsage()
    if (cancelled) {
      publish({ type: 'task.cancelled', taskId: runId, partialText: null })
      return { status: 'cancelled', error: null, artifacts: [], usageTotal }
    }
    const error = failure as NonNullable<typeof failure>
    // User-initiated tasks surface a toast (retry on transient details, §8); scheduler
    // tasks fail quietly by policy — the UI shows a staleness badge either way.
    publish({
      type: 'task.failed',
      taskId: runId,
      code: error.code,
      message: error.message,
      partialText: null,
      retryable: error.retryable,
    })
    return { status: 'error', error, artifacts: [], usageTotal }
  }
}
