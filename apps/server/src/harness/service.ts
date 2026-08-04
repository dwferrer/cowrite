import type {
  AppConfig,
  BudgetKnobsOverrides,
  ProposalApplyRes,
  Task,
  TaskSpec,
  WorkEvent,
} from '@cowrite/shared'
import { QUEUE_LANE_CAPACITY } from '@cowrite/shared'
import { ulid } from 'ulid'
import { engineFor } from '../context/routes.js'
import { AppError } from '../http/errors.js'
import type { OpenWork } from '../http/workRegistry.js'
import { buildClients, type LaneDeps, resolveHarnessKnobs } from '../models/lanes.js'
import { deriveCostUsd } from '../models/usage.js'
import { loadTemplates, type TemplateSet } from '../prompt/templates/loader.js'
import type { WorkHandle } from '../storage/service.js'
import { applyProposal, discardProposal, listRunIds, reconstructProposal } from './proposals.js'
import { QueueLane, type TaskEntry, TERMINAL_STATUSES, WorkTaskState } from './queue.js'
import { runInteractiveTask } from './runner.js'
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
  now?: () => Date
  onError?: (context: string, err: unknown) => void
}

export class AgentHarness {
  private readonly deps: AgentHarnessDeps
  private readonly states = new WeakMap<WorkHandle, WorkTaskState>()
  private templatesPromise: Promise<TemplateSet> | null = null
  /** The single app-wide illustration slot (05 §6.1) — Stage 5 fills the pipeline. */
  readonly illustrationLane = new QueueLane(QUEUE_LANE_CAPACITY.illustration)
  /** Per-process cumulative derived cost across runs (the spend guard's odometer). */
  private spentUsdTotal = 0
  private spendWarned = false

  constructor(deps: AgentHarnessDeps) {
    this.deps = deps
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
    if (!isInteractiveSpec(spec)) {
      throw new AppError(
        'not_implemented',
        `task kind '${spec.kind}' is not implemented yet (M1 Stage ${spec.kind === 'edit-task' ? '— M2' : '4/5'})`,
      )
    }

    const config = this.deps.config() // per-task snapshot (05 §3.1)
    const knobs = resolveHarnessKnobs(config.harness)
    // Spend guard (05 §cost): past the hard stop, NEW submissions fail 409 spend_stop
    // until restart or a knob change — in-flight tasks are never killed.
    if (knobs.spendStopUsd !== null && this.spentUsdTotal >= knobs.spendStopUsd) {
      throw new AppError(
        'spend_stop',
        `this process has spent $${this.spentUsdTotal.toFixed(2)}, at or over ` +
          `harness.spendStopUsd ($${knobs.spendStopUsd.toFixed(2)}) — restart cowrite or raise the knob`,
        { spentUsd: this.spentUsdTotal, thresholdUsd: knobs.spendStopUsd },
      )
    }
    const modelLane = modelLaneFor(config, spec.kind)
    const client = buildClients(config, this.deps.laneDeps ?? {})[modelLane]
    if (client === null) {
      throw new AppError(
        'config_missing',
        `the ${modelLane} model lane is not configured — add models.${modelLane} in settings`,
        { lane: modelLane },
      )
    }

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

  /** POST /works/:w/tasks/:t/cancel — idempotent; running tasks abort, terminal no-op. */
  cancel(open: OpenWork, taskId: string): Task {
    const entry = this.state(open).get(taskId)
    if (entry === undefined) throw new AppError('not_found', `no task '${taskId}' in this process`)
    if (!TERMINAL_STATUSES.has(entry.task.status)) {
      entry.abort.abort(new Error('cancelled by user'))
    }
    return { ...entry.task }
  }

  /** Consolidation-undo hook (05 §6.2): cancel queued/running tasks touching these ids. */
  cancelByTarget(open: OpenWork, targetIds: readonly string[]): void {
    const wanted = new Set(targetIds)
    for (const entry of this.state(open).live()) {
      if (entry.targetIds.some((id) => wanted.has(id))) {
        entry.abort.abort(new Error('cancelled: target withdrawn'))
      }
    }
  }

  /** Live target ids for storage's consolidation guard (05 §5.6). */
  liveTargetIds(open: OpenWork): string[] {
    return this.state(open).liveTargetIds()
  }

  /** Work close (05 §6.2): cancel interactive work and wait for runners to settle. */
  async closeWork(open: OpenWork): Promise<void> {
    const state = this.states.get(open.handle)
    if (state === undefined) return
    const live = state.live()
    for (const entry of live) entry.abort.abort(new Error('cancelled: work closing'))
    await Promise.allSettled(live.map((entry) => entry.done))
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
   * stream, with no fetch-to-subscribe gap.
   */
  attachWork(open: OpenWork): void {
    open.bus.setAttachStateProvider(() => this.taskStateFrames(open))
  }

  private stateFrame(task: Task): WorkEvent {
    const target = isInteractiveSpec(task.spec)
      ? planFor(task.spec).target
      : ({ kind: 'frontier' } as const)
    return { type: 'task.state', task: { ...task }, lane: task.lane, target }
  }

  private taskStateFrames(open: OpenWork): WorkEvent[] | Promise<WorkEvent[]> {
    const state = this.states.get(open.handle)
    const known = state?.list() ?? []
    const live = known.find((t) => t.lane === 'interactive' && !TERMINAL_STATUSES.has(t.status))
    if (live !== undefined) return [this.stateFrame(live)]

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
