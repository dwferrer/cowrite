import type {
  BudgetKnobs,
  ContextState,
  Fidelity,
  ItemRef,
  TaskSpec,
  UsageEvent,
} from '@cowrite/shared'
import { type Assembly, assemble, elevatedSourceText } from './assemble.js'
import { type ElevationInput, fidelityRank, refKey } from './decay.js'
import type { DefaultMap } from './defaults.js'
import { renderableFidelity } from './defaults.js'
import type { SyncHasher, TokenEstimator } from './estimate.js'
import type { AssembledPrompt, PromptRenderer, ToolCall, ToolResult } from './renderTypes.js'
import type { WorkSnapshot } from './snapshot.js'
import { handleExpand, handleFinishPlanning, handleSearch, toolDefs } from './tools.js'

/**
 * TaskContextSession (docs/06-context-engine.md §9.3): the per-task surface 05's runner
 * drives — assembleInitialPrompt → handleToolCall* → compositionRefreshTurn →
 * finalize("completed") on success, abort() on every error/cancel path. All reads serve
 * from the snapshot frozen at beginTask (§10); `handleToolCall` is read-only and
 * idempotent (a replayed call returns byte-identical results and double-elevates
 * nothing); planning caps are owned here, not by the harness (§6).
 */

export interface TaskContextSession {
  /** Ordered region render + tool defs + the ContextSnapshot for the run's meta event. */
  assembleInitialPrompt(): AssembledPrompt
  /** Read-only and idempotent (replay-safe for the harness's retry ladder). */
  handleToolCall(call: ToolCall): Promise<ToolResult>
  /** §5.3; null if no tools were used (the prose already streamed IS the composition). */
  compositionRefreshTurn(): string | null
  /** Citations → ledger, decay, evict, persist. Only completed tasks reach this. */
  finalize(outcome: 'completed'): Promise<void>
  /** Discard session state; no side effects (aborted tasks are not "actions"). */
  abort(): void
}

/** What the engine needs back from a completed session (feeds §7.2 finalize). */
export interface SessionOutcome {
  opened: ElevationInput[]
  citations: ItemRef[] | null
  planningRounds: number
  toolCallCount: number
  finalTokens: number
  /** Base estimate for a hypothetical next `continue`: assembly minus expanded region. */
  baseTokens: number
  resolveCite: (ref: ItemRef) => ElevationInput | null
  anchorRefreshApplied: boolean
}

export interface SessionHost {
  workId: string
  est: TokenEstimator
  hasher: SyncHasher
  renderer: PromptRenderer
  emitEnrichmentWanted(sectionId: string): void
  emitUsage(event: UsageEvent): void
  /** Called once, on the session's first assembly (task_start + cache_break bookkeeping). */
  onAssembled(assembly: Assembly, spec: TaskSpec): void
  onFinalize(session: SessionOutcome, state: ContextState): Promise<void>
  onClosed(): void
  now(): Date
}

export class SessionAssemblyRequiredError extends Error {
  constructor() {
    super('assembleInitialPrompt() must run before tool calls or the refresh turn')
    this.name = 'SessionAssemblyRequiredError'
  }
}

export class TaskContextSessionImpl implements TaskContextSession {
  private readonly host: SessionHost
  private readonly spec: TaskSpec
  private readonly snapshot: WorkSnapshot
  private readonly state: ContextState // working copy (reconciled at beginTask)
  private readonly map: DefaultMap
  private readonly knobs: BudgetKnobs
  readonly anchorRefreshApplied: boolean
  private readonly taskNumber: number

  private assembly: Assembly | null = null
  private assembled: AssembledPrompt | null = null
  private readonly openedThisTask = new Map<string, ElevationInput>()
  private citations: ItemRef[] | null = null
  private toolCallCount = 0
  private planningRounds = 0
  private assembledTokens = 0
  private capReached = false
  private closed = false
  private readonly replayCache = new Map<string, ToolResult>()

  constructor(args: {
    host: SessionHost
    spec: TaskSpec
    snapshot: WorkSnapshot
    state: ContextState
    map: DefaultMap
    knobs: BudgetKnobs
    anchorRefreshApplied: boolean
  }) {
    this.host = args.host
    this.spec = args.spec
    this.snapshot = args.snapshot
    this.state = args.state
    this.map = args.map
    this.knobs = args.knobs
    this.anchorRefreshApplied = args.anchorRefreshApplied
    this.taskNumber = args.state.taskCounter + 1
  }

  assembleInitialPrompt(): AssembledPrompt {
    if (this.assembled !== null) return this.assembled // idempotent
    const assembly = assemble({
      snapshot: this.snapshot,
      state: this.state,
      map: this.map,
      knobs: this.knobs,
      spec: this.spec,
      instructionsBody: this.host.renderer.instructionsBody(this.spec),
      task: this.host.renderer.taskRegion(this.spec),
      est: this.host.est,
      workId: this.host.workId,
    })
    this.assembly = assembly
    this.assembledTokens = assembly.totalTokens
    this.assembled = {
      messages: [
        { role: 'system', content: this.host.renderer.systemPrompt() },
        { role: 'user', content: this.host.renderer.composeUserMessage(assembly.regions) },
      ],
      tools: toolDefs(),
      snapshot: assembly.contextSnapshot,
    }
    this.host.onAssembled(assembly, this.spec)
    return this.assembled
  }

  private maxRounds(): number {
    return this.spec.kind === 'quick-edit'
      ? this.knobs.maxPlanningRoundsQuickEdit
      : this.knobs.maxPlanningRounds
  }

  /** Session overlay > ledger elevation > default map (what the model currently sees). */
  private currentFidelity(kind: 'section' | 'world', id: string): Fidelity {
    const open = this.openedThisTask.get(refKey(kind, id))
    if (open !== undefined) return open.fidelity
    const elevated = this.state.elevated.find((e) => e.kind === kind && e.id === id)
    if (elevated !== undefined) return elevated.fidelity
    if (kind === 'section') return this.map.sections.get(id) ?? 'name'
    return this.map.world.get(id) ?? 'name'
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    if (this.assembly === null) throw new SessionAssemblyRequiredError()
    const replayKey = `${call.id ?? ''}|${call.name}|${JSON.stringify(call.args ?? null)}`
    const cached = this.replayCache.get(replayKey)
    if (cached !== undefined) return cached // replay after a stream death: identical bytes

    const result = this.execute(call)
    this.replayCache.set(replayKey, result)
    return result
  }

  private execute(call: ToolCall): ToolResult {
    const ts = this.host.now().toISOString()

    if (call.name === 'finish_planning') {
      const outcome = handleFinishPlanning(call.args)
      this.citations = outcome.citations
      this.host.emitUsage({
        kind: 'tool_call',
        task: this.taskNumber,
        tool: call.name,
        resultTokens: outcome.resultTokens,
        ts,
      })
      return {
        name: call.name,
        label: outcome.label,
        output: outcome.output,
        finishedPlanning: true,
        planningCapReached: false,
      }
    }

    // Engine-owned caps (§6): on a cap the harness takes the finish_planning path.
    if (call.round !== undefined)
      this.planningRounds = Math.max(this.planningRounds, call.round + 1)
    const roundCapped = call.round !== undefined && call.round >= this.maxRounds()
    if (this.capReached || this.toolCallCount >= this.knobs.maxToolCalls || roundCapped) {
      this.capReached = true
      return {
        name: call.name,
        label: 'planning cap reached',
        output: 'Planning cap reached — no more tool calls. Begin writing now.',
        finishedPlanning: false,
        planningCapReached: true,
      }
    }
    this.toolCallCount += 1
    if (call.round === undefined) this.planningRounds = Math.max(this.planningRounds, 1)

    if (call.name === 'context_search') {
      const outcome = handleSearch(
        call.args,
        this.snapshot,
        this.host.est,
        this.knobs.maxToolResultTokens,
      )
      this.assembledTokens += outcome.resultTokens
      this.host.emitUsage({
        kind: 'tool_call',
        task: this.taskNumber,
        tool: call.name,
        resultTokens: outcome.resultTokens,
        ts,
      })
      return {
        name: call.name,
        label: outcome.label,
        output: outcome.output,
        finishedPlanning: false,
        planningCapReached: false,
      }
    }

    if (call.name === 'context_expand') {
      const outcome = handleExpand(call.args, {
        snapshot: this.snapshot,
        knobs: this.knobs,
        est: this.host.est,
        hasher: this.host.hasher,
        assembledTokens: this.assembledTokens,
        currentFidelity: (kind, id) => this.currentFidelity(kind, id),
      })
      if (outcome.opened !== null) {
        const key = refKey(outcome.opened.kind, outcome.opened.id)
        const existing = this.openedThisTask.get(key)
        if (
          existing === undefined ||
          fidelityRank(outcome.opened.fidelity) > fidelityRank(existing.fidelity)
        ) {
          this.openedThisTask.set(key, { ...outcome.opened, source: 'tool' })
        }
        if (outcome.enrichmentWanted !== null) {
          this.host.emitEnrichmentWanted(outcome.enrichmentWanted)
        }
      }
      this.assembledTokens += outcome.resultTokens
      this.host.emitUsage({
        kind: 'tool_call',
        task: this.taskNumber,
        tool: call.name,
        ...(outcome.item === null ? {} : { item: outcome.item }),
        resultTokens: outcome.resultTokens,
        ts,
      })
      return {
        name: call.name,
        label: outcome.label,
        output: outcome.output,
        finishedPlanning: false,
        planningCapReached: false,
      }
    }

    const output = `Unknown tool '${call.name}'. Available: context_expand, context_search, finish_planning.`
    return {
      name: call.name,
      label: `unknown tool ${call.name}`,
      output,
      finishedPlanning: false,
      planningCapReached: false,
    }
  }

  compositionRefreshTurn(): string | null {
    if (this.assembly === null) throw new SessionAssemblyRequiredError()
    // Zero tool calls ⇒ <local-context> is already at the bottom and the prose the model
    // just streamed IS the composition (06 §5.3) — no refresh turn.
    if (this.toolCallCount === 0) return null
    const tail = this.host.est.tailByTokens(
      this.assembly.localContextBody,
      this.knobs.refreshTailTokens,
    )
    return this.host.renderer.refreshTurn(tail)
  }

  async finalize(_outcome: 'completed'): Promise<void> {
    if (this.closed) return
    this.closed = true
    // Ensure the base estimate exists even if the runner never assembled (defensive).
    if (this.assembly === null) this.assembleInitialPrompt()
    const assembly = this.assembly as Assembly
    const expandedTokens = assembly.regions.find((r) => r.name === 'expanded-context')?.tokens ?? 0
    const outcome: SessionOutcome = {
      opened: [...this.openedThisTask.values()],
      citations: this.citations,
      planningRounds: this.planningRounds,
      toolCallCount: this.toolCallCount,
      finalTokens: this.assembledTokens,
      baseTokens: assembly.totalTokens - expandedTokens,
      resolveCite: (ref) => this.resolveCite(ref),
      anchorRefreshApplied: this.anchorRefreshApplied,
    }
    try {
      await this.host.onFinalize(outcome, this.state)
    } finally {
      this.host.onClosed()
    }
  }

  abort(): void {
    if (this.closed) return
    this.closed = true
    this.host.onClosed() // no ledger side effects, no taskCounter bump, no persistence
  }

  /** A cited-but-not-opened, not-elevated item elevates one level above its default. */
  private resolveCite(ref: ItemRef): ElevationInput | null {
    if (ref.kind === 'section') {
      const section = this.snapshot.sectionById.get(ref.id)
      if (section === undefined) return null
      const defaultFidelity = this.map.sections.get(ref.id) ?? 'name'
      const rank = fidelityRank(defaultFidelity)
      const wanted: Fidelity =
        rank >= 3 ? 'full' : ((['name', 'short', 'long', 'full'] as const)[rank + 1] as Fidelity)
      const fidelity = renderableFidelity(section, wanted)
      const text = elevatedSourceText({ kind: 'section', id: ref.id, fidelity }, this.snapshot)
      if (text === null) return null
      return {
        kind: 'section',
        id: ref.id,
        fidelity,
        source: 'cite',
        tokens: this.host.est.count(text),
        sourceHash: this.host.hasher.hash(text),
      }
    }
    if (ref.kind === 'world') {
      const entry = this.snapshot.worldById.get(ref.id)
      if (entry === undefined) return null
      const defaultFidelity = this.map.world.get(ref.id) ?? 'name'
      const fidelity: Fidelity = defaultFidelity === 'name' ? 'short' : 'full'
      const text = elevatedSourceText({ kind: 'world', id: ref.id, fidelity }, this.snapshot)
      if (text === null) return null
      return {
        kind: 'world',
        id: ref.id,
        fidelity,
        source: 'cite',
        tokens: this.host.est.count(text),
        sourceHash: this.host.hasher.hash(text),
      }
    }
    return null // snippets are never elevated
  }
}
