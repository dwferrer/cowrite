import type {
  AppConfig,
  BudgetKnobsOverrides,
  HarnessKnobs,
  IllustrationHealthRes,
  ProposalApplyRes,
  Task,
  TaskKind,
  TaskSpec,
  WorkEvent,
} from '@cowrite/shared'
import { QUEUE_LANE_CAPACITY } from '@cowrite/shared'
import { ulid } from 'ulid'
import { engineFor } from '../context/routes.js'
import { hydrateSection } from '../events/adapter.js'
import { AppError } from '../http/errors.js'
import type { OpenWork } from '../http/workRegistry.js'
import type { IllustrationProgress, ImageOps } from '../illustration/ctx.js'
import { IllustrationPipeline } from '../illustration/index.js'
import { buildClients, type LaneDeps, resolveHarnessKnobs } from '../models/lanes.js'
import { deriveCostUsd } from '../models/usage.js'
import { loadTemplates, type TemplateSet } from '../prompt/templates/loader.js'
import type { WorkHandle } from '../storage/service.js'
import {
  type BackgroundOutcome,
  type BackgroundSpec,
  backgroundDedupeKey,
  backgroundStartTarget,
  backgroundTargetIds,
  runBackgroundTask,
} from './backgroundTasks.js'
import {
  type BuildRuntimeOptions,
  buildIllustrationRuntime,
  type IllustrationRuntime,
  type IllustrationSpec,
  runIllustrationTask,
  sharpImageOps,
} from './illustrationTasks.js'
import { applyProposal, discardProposal, listRunIds, reconstructProposal } from './proposals.js'
import { QueueLane, type TaskEntry, TERMINAL_STATUSES, WorkTaskState } from './queue.js'
import { runInteractiveTask } from './runner.js'
import { type SchedulerHost, type SchedulerOptions, WorkScheduler } from './scheduler.js'
import {
  buildTask,
  isInteractiveSpec,
  modelLaneFor,
  planFor,
  validateInteractiveSpec,
} from './tasks.js'

/**
 * AgentHarness (docs/05-agents.md §10 `AgentService`): submit/cancel/list, cancelByTarget,
 * the proposal routes' commit paths, and work-close cancellation — the glue between the
 * HTTP layer, the per-work lanes (queue.ts), the runner (runner.ts), and the per-work
 * event bus. One instance per process; per-work state keys off the open WorkHandle (the
 * registry guarantees one live handle per open work).
 *
 * Config is snapshotted per task at submit time (§3.1): a PUT /api/config mid-run never
 * switches an in-flight task's endpoint. An unconfigured routed lane → `409
 * config_missing` and the task is never enqueued.
 */

export interface AgentHarnessDeps {
  /** Live config accessor; snapshotted once per submit. */
  config: () => AppConfig
  /** App-level context-budget overrides passed through to the engine (06 §8.1). */
  budgets?: () => BudgetKnobsOverrides
  /** Model-client test seams (scripted fetch, instant sleeps). */
  laneDeps?: LaneDeps
  /** Prompt template directory override (defaults to the checked-in set). */
  templatesDir?: string
  /** Background-scheduler tuning (sweep cadence/idle/cap — test injection). */
  scheduler?: SchedulerOptions
  /**
   * Illustration wiring (Stage 5, 08). Absent ⇒ illustration is "not configured": every
   * `illustrate-section` / `world-image` submit answers `409 config_missing` and the
   * health route reports comfy off. `configDir` roots the default `<configDir>/workflows`;
   * the rest are test seams (a scripted ComfyUI client / image ops / hermetic workflow dir).
   */
  illustration?: {
    configDir: string
    buildComfyClient?: BuildRuntimeOptions['buildComfyClient']
    imageOps?: ImageOps
    skipSampleCopy?: boolean
  }
  now?: () => Date
  onError?: (context: string, err: unknown) => void
}

/** What a scheduler/user illustration submit resolves with once its task is terminal. */
interface IllustrationOutcome {
  status: 'ok' | 'error' | 'cancelled'
}

export class AgentHarness {
  private readonly deps: AgentHarnessDeps
  private readonly states = new WeakMap<WorkHandle, WorkTaskState>()
  private readonly schedulers = new WeakMap<WorkHandle, WorkScheduler>()
  /** taskId → settle promise for live background tasks (dedupe returns the original). */
  private readonly backgroundOutcomes = new Map<string, Promise<BackgroundOutcome>>()
  private templatesPromise: Promise<TemplateSet> | null = null
  /** The single app-wide illustration slot (05 §6.1): capacity 1, user jumps scheduler jobs. */
  readonly illustrationLane = new QueueLane(QUEUE_LANE_CAPACITY.illustration)
  /** taskId → settle promise for live illustration tasks (dedupe returns the original). */
  private readonly illustrationOutcomes = new Map<string, Promise<IllustrationOutcome>>()
  /** taskId → latest illustration progress, replayed on SSE reconnect so a refreshed tab
   *  resumes the caption (§19). Cleared when the task settles. */
  private readonly illustrationProgress = new Map<string, IllustrationProgress>()
  private readonly illustrationPipeline: IllustrationPipeline
  /** Lazily (re)built from `config.comfyui`; reference-compared for hot-apply (§3). */
  private illustrationRuntimeP: Promise<IllustrationRuntime> | null = null
  private lastComfyConfig: AppConfig['comfyui'] = null
  /** Per-process cumulative derived cost across runs (the spend guard's odometer). */
  private spentUsdTotal = 0
  private spendWarned = false

  constructor(deps: AgentHarnessDeps) {
    this.deps = deps
    this.illustrationPipeline = new IllustrationPipeline(
      deps.now === undefined ? {} : { now: deps.now },
    )
  }

  /** Cumulative derived cost this process has spent (tests + status surfaces). */
  get spentUsd(): number {
    return this.spentUsdTotal
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date()
  }

  private state(open: OpenWork): WorkTaskState {
    let state = this.states.get(open.handle)
    if (state === undefined) {
      state = new WorkTaskState()
      this.states.set(open.handle, state)
    }
    return state
  }

  private templates(): Promise<TemplateSet> {
    this.templatesPromise ??= loadTemplates(this.deps.templatesDir)
    return this.templatesPromise
  }

  /** POST /works/:w/tasks (03 §3.7): validate, route, occupy the lane, start the runner. */
  async submit(open: OpenWork, spec: TaskSpec): Promise<Task> {
    if (spec.kind === 'propose-boundaries') {
      throw new AppError(
        'validation',
        'propose-boundaries is internal; use POST /works/:w/consolidate',
      )
    }
    if (spec.kind === 'enrich-section') {
      // The user's "refresh summary" button (05 §2). Validate the target up front so a
      // bad id answers 404/400 instead of a quiet background failure.
      const row = open.handle.getSection(spec.sectionId)
      if (row === null) throw new AppError('not_found', `no section '${spec.sectionId}'`)
      if (row.contentHash === null) {
        throw new AppError(
          'validation',
          'enrich-section targets a leaf section — interior sections carry no summaries',
        )
      }
      return { ...this.submitBackground(open, spec).task }
    }
    if (spec.kind === 'illustrate-section' || spec.kind === 'world-image') {
      // User-initiated illustration jumps ahead of scheduler jobs in the app-wide lane (§5).
      return { ...(await this.submitIllustration(open, spec, 'user')).task }
    }
    if (!isInteractiveSpec(spec)) {
      throw new AppError(
        'not_implemented',
        `task kind '${spec.kind}' is not implemented yet (M1 Stage ${spec.kind === 'edit-task' ? '— M2' : '5'})`,
      )
    }

    const config = this.deps.config() // per-task snapshot (05 §3.1)
    const knobs = resolveHarnessKnobs(config.harness)
    this.assertSpendAllowed(knobs)
    const client = this.clientFor(config, spec.kind)

    await validateInteractiveSpec(open.handle, spec)
    const plan = planFor(spec)
    const state = this.state(open)
    state.assertInteractiveFree() // 409 busy {runningTaskId} — never queued (§6.1)

    const task = buildTask(ulid(), open.handle.work.id, spec, this.now().toISOString())
    const abort = new AbortController()
    const entry: TaskEntry = { task, abort, targetIds: plan.targetIds, done: Promise.resolve() }
    state.registerInteractive(entry)
    open.bus.publish({ type: 'task.queued', task: { ...task }, position: 0 })

    task.status = 'running'
    task.startedAt = this.now().toISOString()
    open.bus.publish({
      type: 'task.started',
      task: { ...task },
      lane: 'interactive',
      target: plan.target,
    })

    entry.done = (async () => {
      try {
        // The engine's renderer and the runner's promptsHash come from the SAME template
        // set — the templates are the ONE wording source (07 §6).
        const [templates, engine] = await Promise.all([
          this.templates(),
          engineFor(open, this.deps.budgets, this.templates()),
        ])
        const result = await runInteractiveTask(
          task,
          spec,
          {
            handle: open.handle,
            bus: open.bus,
            engine,
            client,
            templates,
            knobs,
            ...(this.deps.now === undefined ? {} : { now: this.deps.now }),
          },
          abort.signal,
        )
        this.recordSpend(open, deriveCostUsd(result.usageTotal, client.endpoint), knobs)
        // Proposal discovery (05 §6.5): terminal tasks carry their partial text and an
        // unresolved-proposal marker so hydration (attach frame + GET /tasks) re-offers.
        const offeredPartial = plan.offersPartial ? result.partialText : null
        const unresolvedProposal =
          result.status !== 'ok' && offeredPartial !== null
            ? ({ kind: 'keep-partial' } as const)
            : result.status === 'ok' && result.artifacts.some((a) => a.state === 'conflict')
              ? ({ kind: 'conflict' } as const)
              : null
        state.finish(
          task.id,
          result.status === 'ok' ? 'done' : result.status,
          result.error === null ? null : { code: result.error.code, message: result.error.message },
          this.now().toISOString(),
          { partialText: offeredPartial, unresolvedProposal },
        )
      } catch (err) {
        // The runner reports its own failures; reaching here is a harness bug — record
        // it so the task never wedges the interactive lane.
        this.deps.onError?.(`runner for task ${task.id}`, err)
        state.finish(
          task.id,
          'error',
          { code: 'internal', message: err instanceof Error ? err.message : String(err) },
          this.now().toISOString(),
        )
        open.bus.publish({
          type: 'task.failed',
          taskId: task.id,
          code: 'internal',
          message: err instanceof Error ? err.message : String(err),
          partialText: null,
          retryable: false,
        })
      }
    })()

    return { ...task }
  }

  // -- background lane (Stage 4: enrich-section, propose-boundaries) --------------------

  /**
   * Enqueue a background task on the per-work background lane (05 §6.1: capacity 2,
   * FIFO, `(kind, targetId)` dedupe, propose-boundaries jumps the queue). Shared by the
   * user-facing enrich submit and the scheduler host. Throws `409 config_missing` /
   * `409 spend_stop` — the scheduler pre-checks `backgroundReady` so its sweeps back
   * off instead of spinning into these.
   */
  private submitBackground(
    open: OpenWork,
    spec: BackgroundSpec,
  ): { task: Task; outcome: Promise<BackgroundOutcome>; deduped: boolean } {
    const config = this.deps.config() // per-task snapshot (05 §3.1)
    const knobs = resolveHarnessKnobs(config.harness)
    this.assertSpendAllowed(knobs)
    const client = this.clientFor(config, spec.kind)

    const state = this.state(open)
    const dedupeKey = backgroundDedupeKey(spec) as string

    const task = buildTask(ulid(), open.handle.work.id, spec, this.now().toISOString())
    const abort = new AbortController()
    let settle!: (outcome: BackgroundOutcome) => void
    const outcome = new Promise<BackgroundOutcome>((resolve) => {
      settle = resolve
    })

    const finishCancelledQueued = (): void => {
      if (task.status !== 'queued') return
      state.finish(task.id, 'cancelled', null, this.now().toISOString())
      open.bus.publish({ type: 'task.cancelled', taskId: task.id, partialText: null })
      settle({ status: 'cancelled', errorCode: null, proposal: null })
    }
    const entry: TaskEntry = {
      task,
      abort,
      targetIds: backgroundTargetIds(spec),
      done: outcome.then(() => {}),
      cancelQueued: finishCancelledQueued,
    }

    const position = state.background.queuedIds().length
    const enqueued = state.background.enqueue({
      id: task.id,
      dedupeKey,
      // Consolidation is waiting on the boundary agent — it jumps the queue (05 §6.1).
      jumpQueue: spec.kind === 'propose-boundaries',
      start: async () => {
        if (task.status !== 'queued') return // cancelled by removal before launch
        if (abort.signal.aborted) {
          finishCancelledQueued()
          return
        }
        task.status = 'running'
        task.startedAt = this.now().toISOString()
        open.bus.publish({
          type: 'task.started',
          task: { ...task },
          lane: 'background',
          target: backgroundStartTarget(spec),
        })
        try {
          const templates = await this.templates()
          const result = await runBackgroundTask(
            task,
            spec,
            {
              handle: open.handle,
              bus: open.bus,
              client,
              templates,
              knobs,
              ...(this.deps.now === undefined ? {} : { now: this.deps.now }),
            },
            abort.signal,
          )
          this.recordSpend(open, deriveCostUsd(result.usageTotal, client.endpoint), knobs)
          state.finish(
            task.id,
            result.status === 'ok' ? 'done' : result.status,
            result.error === null
              ? null
              : { code: result.error.code, message: result.error.message },
            this.now().toISOString(),
          )
          settle({
            status: result.status,
            errorCode: result.error?.code ?? null,
            proposal: result.proposal,
          })
        } catch (err) {
          // The background runner reports its own failures; reaching here is a bug —
          // record it so the task never wedges the lane slot or the scheduler cycle.
          this.deps.onError?.(`background runner for task ${task.id}`, err)
          state.finish(
            task.id,
            'error',
            { code: 'internal', message: err instanceof Error ? err.message : String(err) },
            this.now().toISOString(),
          )
          open.bus.publish({
            type: 'task.failed',
            taskId: task.id,
            code: 'internal',
            message: err instanceof Error ? err.message : String(err),
            partialText: null,
            retryable: false,
          })
          settle({ status: 'error', errorCode: 'internal', proposal: null })
        }
      },
    })
    if (enqueued.status === 'deduped') {
      // Dedupe (05 §6.1): enqueueing an enrich for an already-queued section is a
      // no-op — the LANE is the one dedupe mechanism and reports the live job id;
      // the caller gets that existing task. Nothing above was registered/published.
      const existing = state.get(enqueued.existingId)
      return {
        task: existing?.task ?? task,
        outcome:
          this.backgroundOutcomes.get(enqueued.existingId) ??
          Promise.resolve({ status: 'cancelled', errorCode: null, proposal: null }),
        deduped: true,
      }
    }
    state.registerBackground(entry)
    this.backgroundOutcomes.set(task.id, outcome)
    void outcome.then(() => this.backgroundOutcomes.delete(task.id))
    open.bus.publish({ type: 'task.queued', task: { ...task }, position })
    return { task, outcome, deduped: false }
  }

  // -- illustration lane (Stage 5: illustrate-section, world-image) ---------------------

  /**
   * The illustration runtime (registry + ComfyUI client) for the current `config.comfyui`.
   * Lazily built and reference-compared for hot-apply (§3): a changed `comfyui` block
   * rebuilds and releases the old client's socket. `null` when illustration is unwired
   * (no `deps.illustration`) or `comfyui` is unconfigured — both surface as `config_missing`.
   */
  private illustrationRuntime(): Promise<IllustrationRuntime> | null {
    const wiring = this.deps.illustration
    if (wiring === undefined) return null
    const comfy = this.deps.config().comfyui
    if (comfy === null) {
      if (this.illustrationRuntimeP !== null) {
        void this.illustrationRuntimeP.then((r) => r.close()).catch(() => {})
        this.illustrationRuntimeP = null
        this.lastComfyConfig = null
      }
      return null
    }
    if (this.illustrationRuntimeP === null || this.lastComfyConfig !== comfy) {
      const previous = this.illustrationRuntimeP
      this.lastComfyConfig = comfy
      this.illustrationRuntimeP = buildIllustrationRuntime(comfy, {
        configDir: wiring.configDir,
        ...(wiring.buildComfyClient === undefined
          ? {}
          : { buildComfyClient: wiring.buildComfyClient }),
        ...(wiring.skipSampleCopy === undefined ? {} : { skipSampleCopy: wiring.skipSampleCopy }),
      })
      if (previous !== null) void previous.then((r) => r.close()).catch(() => {})
    }
    return this.illustrationRuntimeP
  }

  /** Rebuild the illustration runtime from the current config (startup + config hot-apply). */
  reloadIllustration(): void {
    void this.illustrationRuntime()
  }

  private illustrationImageOps(): ImageOps {
    return this.deps.illustration?.imageOps ?? sharpImageOps
  }

  /** GET /api/illustration/health (§8): ComfyUI reachability + the registry report. */
  async illustrationHealth(): Promise<IllustrationHealthRes> {
    const runtimeP = this.illustrationRuntime()
    if (runtimeP === null) {
      const comfy = this.deps.config().comfyui
      const section = comfy?.route.section ?? 'default'
      const world = comfy?.route.world ?? 'default'
      return {
        ok: false,
        comfy: { ok: false, detail: 'comfyui is not configured' },
        workflows: [],
        route: { section: { name: section, ok: false }, world: { name: world, ok: false } },
      }
    }
    const runtime = await runtimeP
    const comfy = await runtime.client.health()
    const { workflows, route } = runtime.registry.report
    const workflowsOk = workflows.every((w) => w.ok)
    const routesOk = route.section.ok && route.world.ok
    return {
      ok: comfy.ok && workflowsOk && routesOk,
      comfy: comfy.detail === undefined ? { ok: comfy.ok } : { ok: comfy.ok, detail: comfy.detail },
      workflows: workflows.map((w) =>
        w.error === undefined
          ? { name: w.name, label: w.label, ok: w.ok }
          : { name: w.name, label: w.label, ok: w.ok, error: w.error },
      ),
      route: {
        section: { name: route.section.name, ok: route.section.ok },
        world: { name: route.world.name, ok: route.world.ok },
      },
    }
  }

  /**
   * Enqueue an illustration task on the app-wide illustration lane (05 §6.1). Throws
   * `409 config_missing` when the low lane OR comfyui is unconfigured/broken, and 404 for a
   * vanished target — the task is never enqueued. A suppressed section is un-suppressed
   * before the enqueue (§5 slot transitions). `(kind, targetId)`-deduped; user submits jump
   * ahead of the scheduler's queued jobs.
   */
  private async submitIllustration(
    open: OpenWork,
    spec: IllustrationSpec,
    initiator: 'user' | 'scheduler',
  ): Promise<{ task: Task; outcome: Promise<IllustrationOutcome>; deduped: boolean }> {
    const config = this.deps.config() // per-task snapshot (05 §3.1)
    const knobs = resolveHarnessKnobs(config.harness)
    this.assertSpendAllowed(knobs)
    const low = buildClients(config, this.deps.laneDeps ?? {}).low
    if (low === null) {
      throw new AppError('config_missing', 'the low model lane is not configured', { lane: 'low' })
    }
    const runtimeP = this.illustrationRuntime()
    if (runtimeP === null) {
      throw new AppError('config_missing', 'ComfyUI is not configured — add comfyui in settings', {
        lane: 'comfyui',
      })
    }
    const runtime = await runtimeP
    const routeKind = spec.kind === 'illustrate-section' ? 'section' : 'world'
    const resolved = runtime.registry.resolve(routeKind)
    if ('configMissing' in resolved) {
      throw new AppError('config_missing', resolved.configMissing, { lane: 'comfyui' })
    }

    let targetId: string
    let startTarget: { kind: 'section' | 'entry'; id: string }
    if (spec.kind === 'illustrate-section') {
      const row = open.handle.getSection(spec.sectionId)
      if (row === null) throw new AppError('not_found', `no section '${spec.sectionId}'`)
      // Only an explicit USER "Illustrate" lifts a tombstone (§13); idempotent (a no-op on a
      // present/absent slot). A scheduler-initiated sweep must NEVER resurrect deleted art —
      // that would race the sweep against a user's delete.
      if (initiator === 'user') await open.handle.clearSuppression(spec.sectionId)
      targetId = spec.sectionId
      startTarget = { kind: 'section', id: spec.sectionId }
    } else {
      await open.handle.getWorldEntry(spec.entryId) // WorldEntryNotFoundError → 404
      targetId = spec.entryId
      startTarget = { kind: 'entry', id: spec.entryId }
    }

    const state = this.state(open)
    const dedupeKey = `${spec.kind}:${targetId}`
    const task = buildTask(ulid(), open.handle.work.id, spec, this.now().toISOString())
    const abort = new AbortController()
    let settle!: (outcome: IllustrationOutcome) => void
    const outcome = new Promise<IllustrationOutcome>((resolve) => {
      settle = resolve
    })

    const finishCancelledQueued = (): void => {
      if (task.status !== 'queued') return
      state.finish(task.id, 'cancelled', null, this.now().toISOString())
      open.bus.publish({ type: 'task.cancelled', taskId: task.id, partialText: null })
      settle({ status: 'cancelled' })
    }
    const entry: TaskEntry = {
      task,
      abort,
      targetIds: [targetId],
      done: outcome.then(() => {}),
      cancelQueued: finishCancelledQueued,
    }

    const enqueued = this.illustrationLane.enqueue({
      id: task.id,
      dedupeKey,
      // User-initiated tasks jump ahead of scheduler-initiated ones (§5 priority).
      jumpQueue: initiator === 'user',
      start: async () => {
        if (task.status !== 'queued') return
        if (abort.signal.aborted) {
          finishCancelledQueued()
          return
        }
        task.status = 'running'
        task.startedAt = this.now().toISOString()
        open.bus.publish({
          type: 'task.started',
          task: { ...task },
          lane: 'illustration',
          target: startTarget,
        })
        try {
          const templates = await this.templates()
          const result = await runIllustrationTask(
            task,
            spec,
            {
              handle: open.handle,
              bus: open.bus,
              lowClient: low,
              comfy: runtime.client,
              registry: runtime.registry,
              imageOps: this.illustrationImageOps(),
              templates,
              pipeline: this.illustrationPipeline,
              loop: runtime.comfyConfig.loop,
              illustrationBudgetMs: knobs.illustrationBudgetMs,
              onProgress: (p) => this.illustrationProgress.set(task.id, p),
              ...(this.deps.now === undefined ? {} : { now: this.deps.now }),
            },
            abort.signal,
          )
          this.recordSpend(open, deriveCostUsd(result.usageTotal, low.endpoint), knobs)
          state.finish(
            task.id,
            result.status === 'ok' ? 'done' : result.status,
            result.error === null
              ? null
              : { code: result.error.code, message: result.error.message },
            this.now().toISOString(),
          )
          settle({ status: result.status })
        } catch (err) {
          this.deps.onError?.(`illustration runner for task ${task.id}`, err)
          state.finish(
            task.id,
            'error',
            { code: 'internal', message: err instanceof Error ? err.message : String(err) },
            this.now().toISOString(),
          )
          open.bus.publish({
            type: 'task.failed',
            taskId: task.id,
            code: 'internal',
            message: err instanceof Error ? err.message : String(err),
            partialText: null,
            retryable: false,
          })
          settle({ status: 'error' })
        }
      },
    })
    if (enqueued.status === 'deduped') {
      // A live job already targets this section/entry (05 §6.1, §10 lane dedupe): return it.
      const existing = state.get(enqueued.existingId)
      return {
        task: existing?.task ?? task,
        outcome:
          this.illustrationOutcomes.get(enqueued.existingId) ??
          Promise.resolve({ status: 'cancelled' }),
        deduped: true,
      }
    }
    state.registerBackground(entry) // registers into the per-work task registry (no lane bookkeeping)
    this.illustrationOutcomes.set(task.id, outcome)
    void outcome.then(() => {
      this.illustrationOutcomes.delete(task.id)
      this.illustrationProgress.delete(task.id)
    })
    open.bus.publish({
      type: 'task.queued',
      task: { ...task },
      position: this.illustrationLane.queuedIds().length,
    })
    return { task, outcome, deduped: false }
  }

  /** Spend guard (05 §cost): past the hard stop, NEW submissions fail `409 spend_stop`
   *  until restart or a knob change — in-flight tasks are never killed. */
  private assertSpendAllowed(knobs: HarnessKnobs): void {
    if (knobs.spendStopUsd !== null && this.spentUsdTotal >= knobs.spendStopUsd) {
      throw new AppError(
        'spend_stop',
        `this process has spent $${this.spentUsdTotal.toFixed(2)}, at or over ` +
          `harness.spendStopUsd ($${knobs.spendStopUsd.toFixed(2)}) — restart cowrite or raise the knob`,
        { spentUsd: this.spentUsdTotal, thresholdUsd: knobs.spendStopUsd },
      )
    }
  }

  /** Route the kind to its model lane and build the client; `409 config_missing` if unset. */
  private clientFor(config: AppConfig, kind: TaskKind) {
    const modelLane = modelLaneFor(config, kind)
    const client = buildClients(config, this.deps.laneDeps ?? {})[modelLane]
    if (client === null) {
      throw new AppError(
        'config_missing',
        `the ${modelLane} model lane is not configured — add models.${modelLane} in settings`,
        { lane: modelLane },
      )
    }
    return client
  }

  /** GET /works/:w/tasks — queued + running + last 50 terminal (in-memory by design). */
  list(open: OpenWork): Task[] {
    return this.state(open)
      .list()
      .map((task) => ({ ...task }))
  }

  /** GET /works/:w/tasks/:t — 404 after a restart by design (03 §3.7). */
  get(open: OpenWork, taskId: string): Task | null {
    const entry = this.state(open).get(taskId)
    return entry === undefined ? null : { ...entry.task }
  }

  /** POST /works/:w/tasks/:t/cancel — idempotent; running tasks abort, queued
   *  background tasks cancel by removal (05 §6.3), terminal no-op. */
  cancel(open: OpenWork, taskId: string): Task {
    const entry = this.state(open).get(taskId)
    if (entry === undefined) throw new AppError('not_found', `no task '${taskId}' in this process`)
    if (!TERMINAL_STATUSES.has(entry.task.status)) this.cancelEntry(open, entry)
    return { ...entry.task }
  }

  /** Abort a running entry; remove-and-settle a still-queued background entry. */
  private cancelEntry(open: OpenWork, entry: TaskEntry, reason = 'cancelled by user'): void {
    if (
      entry.task.lane === 'background' &&
      entry.task.status === 'queued' &&
      this.state(open).background.removeQueued(entry.task.id)
    ) {
      entry.cancelQueued?.()
      return
    }
    if (
      entry.task.lane === 'illustration' &&
      entry.task.status === 'queued' &&
      this.illustrationLane.removeQueued(entry.task.id)
    ) {
      // A still-queued illustration job cancels by removal from the app-wide lane (§5 undo).
      entry.cancelQueued?.()
      return
    }
    entry.abort.abort(new Error(reason))
  }

  /** Consolidation-undo hook (05 §6.2): cancel queued/running tasks touching these ids. */
  cancelByTarget(open: OpenWork, targetIds: readonly string[]): void {
    const wanted = new Set(targetIds)
    for (const entry of this.state(open).live()) {
      if (entry.targetIds.some((id) => wanted.has(id))) {
        this.cancelEntry(open, entry, 'cancelled: target withdrawn')
      }
    }
  }

  /** Cancel-by-target AND wait for the affected runners to settle — the pre-undo
   *  barrier (02 §6.4: an enrichment run must never write into a dir being deleted). */
  async cancelByTargetAndSettle(open: OpenWork, targetIds: readonly string[]): Promise<void> {
    const wanted = new Set(targetIds)
    const affected = this.state(open)
      .live()
      .filter((entry) => entry.targetIds.some((id) => wanted.has(id)))
    this.cancelByTarget(open, targetIds)
    await Promise.allSettled(affected.map((entry) => entry.done))
  }

  /** Live target ids for storage's consolidation guard (05 §5.6). */
  liveTargetIds(open: OpenWork): string[] {
    return this.state(open).liveTargetIds()
  }

  /** Work close (05 §6.2): stop the scheduler, cancel lanes, wait for runners. */
  async closeWork(open: OpenWork): Promise<void> {
    this.schedulers.get(open.handle)?.dispose()
    const state = this.states.get(open.handle)
    if (state === undefined) return
    const live = state.live()
    for (const entry of live) this.cancelEntry(open, entry, 'cancelled: work closing')
    await Promise.allSettled(live.map((entry) => entry.done))
  }

  // -- consolidation controls (03 §3.8) -------------------------------------------------

  /** POST /works/:w/consolidate — the manual "Consolidate now" trigger. */
  consolidateNow(open: OpenWork): ReturnType<WorkScheduler['consolidateNow']> {
    return this.schedulerFor(open).consolidateNow()
  }

  /** POST /works/:w/consolidations/:undoToken/undo — cancel-by-target THEN undo. */
  undoWorkConsolidation(open: OpenWork, undoToken: string): Promise<void> {
    return this.schedulerFor(open).undo(undoToken)
  }

  /** The per-work scheduler; created by attachWork, lazily otherwise (presence-less). */
  private schedulerFor(open: OpenWork, presence?: () => boolean): WorkScheduler {
    let scheduler = this.schedulers.get(open.handle)
    if (scheduler !== undefined) return scheduler
    scheduler = new WorkScheduler(
      open.handle,
      { onLocal: (listener) => open.bus.onLocal(listener) },
      this.schedulerHost(open, presence ?? (() => false)),
      this.deps.scheduler ?? {},
    )
    this.schedulers.set(open.handle, scheduler)
    scheduler.start()
    // Registry-driven close (idle timeout, DELETE) also tears the timers down even
    // when no onClose→closeWork hook was registered at this composition root.
    open.addCloseResource(() => scheduler?.dispose())
    return scheduler
  }

  /** The scheduler's window into this harness (scheduler.ts `SchedulerHost`). */
  private schedulerHost(open: OpenWork, presence: () => boolean): SchedulerHost {
    return {
      hasSubscribers: presence,
      interactiveIdleMs: () => this.state(open).interactiveIdleMs(),
      liveTargetIds: () => this.liveTargetIds(open),
      backgroundReady: (kind) => {
        const config = this.deps.config()
        const knobs = resolveHarnessKnobs(config.harness)
        if (knobs.spendStopUsd !== null && this.spentUsdTotal >= knobs.spendStopUsd) return false
        return buildClients(config, this.deps.laneDeps ?? {})[modelLaneFor(config, kind)] !== null
      },
      enqueueEnrich: (sectionId) => {
        const res = this.submitBackground(open, { kind: 'enrich-section', sectionId })
        // The outcome feeds the scheduler's per-section failure cooldown (05 §6.5).
        return { deduped: res.deduped, outcome: res.outcome }
      },
      enqueueBoundaries: (eligibleSnippetIds) => {
        const res = this.submitBackground(open, {
          kind: 'propose-boundaries',
          eligibleSnippetIds,
        })
        return { task: res.task, outcome: res.outcome }
      },
      // Illustration sweep + post-enrich trigger (§5). Ready when comfyui + the low lane
      // are configured and spend is under the stop; enqueue is fire-and-forget (the lane
      // dedupes, config_missing/404 races are quiet — the staleness badge persists).
      illustrationReady: () => {
        const config = this.deps.config()
        const knobs = resolveHarnessKnobs(config.harness)
        if (knobs.spendStopUsd !== null && this.spentUsdTotal >= knobs.spendStopUsd) return false
        if (this.deps.illustration === undefined || config.comfyui === null) return false
        return buildClients(config, this.deps.laneDeps ?? {}).low !== null
      },
      enqueueIllustrate: (sectionId) => {
        // The run outcome feeds the scheduler's per-section illustrate failure cooldown (§11):
        // a config_missing/spend_stop at submit, or a failed run, both read as 'error'.
        const outcome = this.submitIllustration(
          open,
          { kind: 'illustrate-section', sectionId },
          'scheduler',
        )
          .then((r) => r.outcome)
          .catch((err) => {
            this.deps.onError?.(`scheduler illustrate enqueue ${sectionId}`, err)
            return { status: 'error' as const }
          })
        return { outcome }
      },
      cancelByTargetAndSettle: (targetIds) => this.cancelByTargetAndSettle(open, targetIds),
    }
  }

  // -- spend guard (05 §cost) ---------------------------------------------------------

  private recordSpend(
    open: OpenWork,
    costUsd: number | null,
    knobs: ReturnType<typeof resolveHarnessKnobs>,
  ): void {
    if (costUsd === null || costUsd <= 0) return
    this.spentUsdTotal += costUsd
    if (
      knobs.spendWarnUsd !== null &&
      !this.spendWarned &&
      this.spentUsdTotal >= knobs.spendWarnUsd
    ) {
      this.spendWarned = true // one-time per process
      open.bus.publish({
        type: 'spend.warning',
        spentUsd: this.spentUsdTotal,
        thresholdUsd: knobs.spendWarnUsd,
      })
      console.warn(
        `[cowrite] model spend this session crossed $${knobs.spendWarnUsd.toFixed(2)} ` +
          `(now $${this.spentUsdTotal.toFixed(2)}) — see config.harness.spendWarnUsd/spendStopUsd`,
      )
    }
  }

  // -- attach-time task state (03 §8.3 hydration fencing) -------------------------------

  /**
   * Install this work's attach-state provider on its bus — registered via the registry's
   * `onOpen` hook at every composition root, so a fresh EventSource hydrates the
   * interactive slot (and any pending keep-partial/conflict offer) purely from the
   * stream, with no fetch-to-subscribe gap. Also starts the work's background scheduler
   * (scheduler.ts); `presence` reports "≥ 1 SSE subscriber" for its sweep gate — absent
   * (CLI compositions) the sweep stays gated off and only the consolidation driver and
   * explicit submits run.
   */
  attachWork(open: OpenWork, presence?: () => boolean): void {
    open.bus.setAttachStateProvider(() => this.taskStateFrames(open))
    // Mid-grace hydration (02 §6.4; 03 §8.3): a reload/restart while a consolidation
    // is still inside its undo window re-offers the undo toast with the TRUE remaining
    // deadline — a synthetic consolidation.applied frame on every attach.
    open.bus.addAttachProvider(() => this.pendingConsolidationFrames(open))
    this.schedulerFor(open, presence)
  }

  private async pendingConsolidationFrames(open: OpenWork): Promise<WorkEvent[]> {
    try {
      const pending = await open.handle.pendingConsolidation()
      if (pending === null || pending.undoDeadline === null) return []
      const first = pending.sectionIds[0]
      const section = first === undefined ? null : hydrateSection(open.handle, first)
      return [
        {
          type: 'consolidation.applied',
          sectionIds: pending.sectionIds,
          title: section?.title ?? '',
          undoToken: pending.opId,
          undoDeadline: pending.undoDeadline,
        },
      ]
    } catch {
      return [] // a broken journal read must not break the stream
    }
  }

  private stateFrame(task: Task): WorkEvent {
    return {
      type: 'task.state',
      task: { ...task },
      lane: task.lane,
      target: this.frameTarget(task),
    }
  }

  /** The target an attach-frame carries. Interactive tasks use their plan target; an illustration
   *  task keys the section/entry so the overlay resumes on that slot (§19). */
  private frameTarget(task: Task): Extract<WorkEvent, { type: 'task.state' }>['target'] {
    if (isInteractiveSpec(task.spec)) return planFor(task.spec).target
    if (task.spec.kind === 'illustrate-section') {
      return { kind: 'section', id: task.spec.sectionId }
    }
    if (task.spec.kind === 'world-image') return { kind: 'entry', id: task.spec.entryId }
    return { kind: 'frontier' }
  }

  /** The live illustration task's task.progress replay frame, if any progress has been seen (§19). */
  private illustrationProgressFrame(taskId: string): WorkEvent | null {
    const p = this.illustrationProgress.get(taskId)
    if (p === undefined) return null
    return {
      type: 'task.progress',
      taskId,
      phase: p.phase,
      attempt: p.attempt,
      maxAttempts: p.maxAttempts,
      pct: p.pct,
    }
  }

  private taskStateFrames(open: OpenWork): WorkEvent[] | Promise<WorkEvent[]> {
    const state = this.states.get(open.handle)
    const known = state?.list() ?? []
    // A live illustration task replays its state + latest progress so a refreshed tab resumes
    // the caption (§19). Emitted alongside any live interactive frame.
    const liveFrames: WorkEvent[] = []
    const liveInteractive = known.find(
      (t) => t.lane === 'interactive' && !TERMINAL_STATUSES.has(t.status),
    )
    if (liveInteractive !== undefined) liveFrames.push(this.stateFrame(liveInteractive))
    const liveIllustration = known.find(
      (t) => t.lane === 'illustration' && !TERMINAL_STATUSES.has(t.status),
    )
    if (liveIllustration !== undefined) {
      liveFrames.push(this.stateFrame(liveIllustration))
      const progressFrame = this.illustrationProgressFrame(liveIllustration.id)
      if (progressFrame !== null) liveFrames.push(progressFrame)
    }
    if (liveFrames.length > 0) return liveFrames

    const unresolved = [...known]
      .reverse()
      .find((t) => TERMINAL_STATUSES.has(t.status) && t.unresolvedProposal !== null)
    if (unresolved !== undefined) {
      if (unresolved.partialText !== null) return [this.stateFrame(unresolved)]
      // Conflict offers keep no in-memory text — fill it from the durable run file.
      return reconstructProposal(open.handle, unresolved.id)
        .then((proposal) =>
          proposal === null || proposal.resolved !== null
            ? []
            : [this.stateFrame({ ...unresolved, partialText: proposal.text })],
        )
        .catch(() => [])
    }
    if (known.length > 0) return [] // this process knows the work: nothing to offer

    // Post-restart: no in-memory tasks — the LAST run file decides lazily (03 §8.4).
    return this.latestUnresolvedFrame(open).catch(() => [])
  }

  private async latestUnresolvedFrame(open: OpenWork): Promise<WorkEvent[]> {
    const runIds = await listRunIds(open.handle.workDir)
    const lastRunId = runIds[runIds.length - 1]
    if (lastRunId === undefined) return []
    const proposal = await reconstructProposal(open.handle, lastRunId)
    if (proposal === null || proposal.resolved !== null) return []
    const task: Task = {
      id: lastRunId,
      workId: open.handle.work.id,
      spec: proposal.spec,
      lane: 'interactive',
      status: proposal.status === 'ok' ? 'done' : proposal.status,
      queuedAt: proposal.startedAt,
      startedAt: proposal.startedAt,
      endedAt: proposal.endedAt,
      error: proposal.error,
      partialText: proposal.text,
      unresolvedProposal: { kind: proposal.kind },
    }
    return [this.stateFrame(task)]
  }

  /** POST …/proposal/apply (03 §3.7). Refuses while the task still runs in-process. */
  async applyProposal(open: OpenWork, taskId: string): Promise<ProposalApplyRes> {
    this.assertNotRunning(open, taskId)
    const res = await applyProposal(open.handle, taskId)
    this.clearUnresolved(open, taskId)
    return res
  }

  /** POST …/proposal/discard — durable marker; idempotent 204. */
  async discardProposal(open: OpenWork, taskId: string): Promise<void> {
    this.assertNotRunning(open, taskId)
    await discardProposal(open.handle, taskId)
    this.clearUnresolved(open, taskId)
  }

  /** The in-memory task stops advertising its proposal once resolved (05 §6.5). */
  private clearUnresolved(open: OpenWork, taskId: string): void {
    const entry = this.state(open).get(taskId)
    if (entry !== undefined) entry.task.unresolvedProposal = null
  }

  private assertNotRunning(open: OpenWork, taskId: string): void {
    const entry = this.state(open).get(taskId)
    if (entry !== undefined && !TERMINAL_STATUSES.has(entry.task.status)) {
      throw new AppError('conflict', `task '${taskId}' is still running — cancel it first`)
    }
  }
}
