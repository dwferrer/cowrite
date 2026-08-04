import path from 'node:path'
import type {
  ContextCandidate,
  ContextStateRes,
  DefaultMapEntry,
  Fidelity,
  PreviewRequest,
  PreviewResponse,
  TaskSpec,
  UsageEvent,
} from '@cowrite/shared'
import {
  BudgetKnobs,
  type BudgetKnobsOverrides,
  ContextState,
  TASK_KIND_LANE,
  UsageEvent as UsageEventSchema,
} from '@cowrite/shared'
import {
  appendJsonlLine,
  ensureDir,
  readIfExists,
  readJsonlTailLines,
  rotateFileIfOver,
  writeFileAtomic,
} from '../storage/lib/fsx.js'
import { reconcileAnchors, selectAnchors } from './anchors.js'
import { type Assembly, assemble, elevatedSourceText } from './assemble.js'
import { finalizeTask } from './decay.js'
import { computeDefaultMap } from './defaults.js'
import { createSyncHasher, type SyncHasher, TokenEstimator } from './estimate.js'
import type { PromptRenderer } from './renderTypes.js'
import type { SessionOutcome, TaskContextSession } from './session.js'
import { TaskContextSessionImpl } from './session.js'
import {
  captureSnapshot,
  type ManuscriptReader,
  type SectionContentCache,
  type SituationReader,
  type WorkSnapshot,
  type WorldInfoReader,
} from './snapshot.js'

/**
 * ContextEngine (docs/06-context-engine.md §9.3): one instance per open work, owning the
 * persistent ledger (`.cowrite/context/state.json` — a rebuildable cache: missing/corrupt
 * files regenerate with a warning, never a fatal error), the usage log
 * (`usage.jsonl`, §8.4), the one stateful session per task (snapshot-isolated, §10), and
 * the REST-facing queries (§11). Everything injected = everything mockable.
 */

export class SessionBusyError extends Error {
  constructor() {
    super('a context session is already open for this work (interactive lane capacity is 1)')
    this.name = 'SessionBusyError'
  }
}

/** Bad engine input (non-interactive kind, M2-only target shape) — routes map to 400. */
export class EngineValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EngineValidationError'
  }
}

export interface EngineChannels {
  /** `enrichment_wanted` (03 §in-process channels): nudge the enrich scheduler. */
  emitEnrichmentWanted(sectionId: string): void
  /** Chapter enrichment landed: queue the full anchor refresh for the next beginTask. */
  onEnrichmentCompleted(cb: (sectionId: string) => void): () => void
  /**
   * Any committed work mutation (storage `onChange`): invalidates the engine's cached
   * WorkSnapshot so beginTask and the REST queries re-capture. Without this channel the
   * engine never reuses a whole snapshot (safe default for bare test deps) — only the
   * contentHash-keyed section cache applies.
   */
  onWorkChanged(cb: () => void): () => void
}

export interface EngineDeps {
  workId: string
  /** `.cowrite/context/` of the work (state.json + usage.jsonl live here). */
  contextDir: string
  manuscript: ManuscriptReader
  worldInfo: WorldInfoReader
  situation: SituationReader
  channels?: Partial<EngineChannels>
  /** Teed to usage.jsonl by the engine; exposed for tests. */
  onUsage?: (e: UsageEvent) => void
  /** Override chain (§8.1) already merged by the caller: app config.budgets under
   *  work.json contextOverrides. A thunk re-resolves per task (PATCHes apply next task). */
  knobs?: Partial<BudgetKnobsOverrides> | (() => Partial<BudgetKnobsOverrides>)
  /** The prompt renderer — the template-backed one in production (prompt/renderer.ts);
   *  tests may inject a stub. REQUIRED: the templates are the ONE wording source. */
  renderer: PromptRenderer
  now?: () => Date
  warn?: (message: string) => void
  /** usage.jsonl rotation threshold in bytes (default 5 MB); a test seam. */
  usageRotateBytes?: number
}

/** usage.jsonl rotates at 5 MB to a single `.1` generation (E4). */
const USAGE_ROTATE_BYTES = 5 * 1024 * 1024

const EMPTY_STATE: ContextState = {
  version: 1,
  taskCounter: 0,
  elevated: [],
  anchors: { refreshedAtTask: 0, excerpts: [] },
}

function definedOnly<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>
}

/** Resolve effective knobs: schema defaults ← merged overrides (06 §8.1 chain). */
export function resolveBudgetKnobs(overrides: Partial<BudgetKnobsOverrides> = {}): BudgetKnobs {
  return BudgetKnobs.parse(definedOnly(overrides))
}

const INTERACTIVE = new Set(
  Object.entries(TASK_KIND_LANE)
    .filter(([, lane]) => lane === 'interactive')
    .map(([kind]) => kind),
)

export class ContextEngine {
  private readonly deps: EngineDeps
  private readonly est = new TokenEstimator()
  private readonly hasher: SyncHasher
  private readonly renderer: PromptRenderer
  private state: ContextState
  private activeSession: TaskContextSessionImpl | null = null
  private pendingAnchorRefresh = false
  private pendingFullBreak = false
  private lastRegionHashes = new Map<string, string>()
  private usageTail: Promise<void> = Promise.resolve()
  private readonly unsubscribes: Array<() => void> = []

  // -- snapshot caching (E1): section contents keyed by contentHash + whole-snapshot
  // reuse between work changes. `snapshotDirty` starts true (nothing captured yet) and
  // is re-armed by the onWorkChanged channel; without that channel it never clears, so
  // bare test deps always re-capture (the content cache still spares the reads).
  private readonly contentCache: SectionContentCache = new Map()
  private lastSnapshot: WorkSnapshot | null = null
  private snapshotDirty = true
  private readonly watchingChanges: boolean

  private constructor(deps: EngineDeps, hasher: SyncHasher, state: ContextState) {
    this.deps = deps
    this.hasher = hasher
    this.renderer = deps.renderer
    this.state = state
    const enrichUnsub = deps.channels?.onEnrichmentCompleted?.(() => {
      // Queued and applied at the next beginTask (§10) — never mid-task.
      this.pendingAnchorRefresh = true
    })
    if (enrichUnsub !== undefined) this.unsubscribes.push(enrichUnsub)
    const changeUnsub = deps.channels?.onWorkChanged?.(() => {
      this.snapshotDirty = true
      this.lastSnapshot = null
    })
    this.watchingChanges = changeUnsub !== undefined
    if (changeUnsub !== undefined) this.unsubscribes.push(changeUnsub)
  }

  static async load(deps: EngineDeps): Promise<ContextEngine> {
    const hasher = await createSyncHasher()
    await ensureDir(deps.contextDir)
    let state: ContextState = EMPTY_STATE
    let broke = false
    const statePath = path.join(deps.contextDir, 'state.json')
    const raw = await readIfExists(statePath)
    if (raw !== null) {
      try {
        state = ContextState.parse(JSON.parse(raw))
      } catch {
        broke = true
        ;(deps.warn ?? console.warn)(
          `[cowrite] context state at ${statePath} is corrupt or outdated — regenerating ` +
            '(it is a cache; the manuscript is truth)',
        )
      }
    }
    const engine = new ContextEngine(deps, hasher, state)
    engine.pendingFullBreak = broke
    if (state.anchors.excerpts.length === 0) engine.pendingAnchorRefresh = true
    return engine
  }

  /**
   * Detach the enrichment-completed subscriptions (storage onChange + bus local) and
   * await the usage-append tail, so a work close/delete can safely close the handle and
   * rename the directory afterwards (Windows EPERM otherwise — 03 §4.3 ordering).
   */
  async close(): Promise<void> {
    for (const unsubscribe of this.unsubscribes) unsubscribe()
    await this.usageTail
  }

  // -- internals ------------------------------------------------------------

  private now(): Date {
    return this.deps.now?.() ?? new Date()
  }

  private warn(message: string): void {
    ;(this.deps.warn ?? console.warn)(message)
  }

  private knobs(): BudgetKnobs {
    const k = this.deps.knobs
    return resolveBudgetKnobs(typeof k === 'function' ? k() : (k ?? {}))
  }

  private statePath(): string {
    return path.join(this.deps.contextDir, 'state.json')
  }

  private usagePath(): string {
    return path.join(this.deps.contextDir, 'usage.jsonl')
  }

  private emitUsage(event: UsageEvent): void {
    this.deps.onUsage?.(event)
    this.usageTail = this.usageTail
      .then(async () => {
        // Size-based rotation (one generation kept): the log is an inspection window,
        // not an archive — unbounded growth would eventually tax every usage() read.
        await rotateFileIfOver(this.usagePath(), this.deps.usageRotateBytes ?? USAGE_ROTATE_BYTES)
        await appendJsonlLine(this.usagePath(), event)
      })
      .catch((err) => {
        this.warn(`[cowrite] context usage.jsonl append failed: ${String(err)}`)
      })
  }

  /** Flush pending usage appends (tests and orderly shutdown). */
  usageSettled(): Promise<void> {
    return this.usageTail
  }

  private async persist(state: ContextState): Promise<void> {
    await writeFileAtomic(this.statePath(), `${JSON.stringify(state, null, 2)}\n`)
  }

  private snapshotReaders() {
    return {
      manuscript: this.deps.manuscript,
      worldInfo: this.deps.worldInfo,
      situation: this.deps.situation,
    }
  }

  /**
   * Capture (or reuse) the WorkSnapshot. Reuse requires the onWorkChanged channel AND no
   * change since the last capture; the dirty flag clears BEFORE the await, so a change
   * landing mid-capture re-arms it and the next call re-captures (never trapped stale).
   * Snapshots are immutable once built, so sharing one across beginTask and the REST
   * queries is exactly the §10 isolation semantics.
   */
  private async snapshot(): Promise<WorkSnapshot> {
    if (this.watchingChanges && !this.snapshotDirty && this.lastSnapshot !== null) {
      return this.lastSnapshot
    }
    this.snapshotDirty = false
    const snap = await captureSnapshot(this.snapshotReaders(), this.hasher, this.contentCache)
    this.lastSnapshot = snap
    return snap
  }

  /**
   * beginTask-time self-reconciliation (§10): drop elevations whose source vanished,
   * re-render/re-estimate ones whose sourceHash no longer matches the snapshot, refresh
   * or hash-check anchors. Works on a copy; nothing persists until finalize.
   */
  private reconcileState(
    snapshot: WorkSnapshot,
    knobs: BudgetKnobs,
  ): { working: ContextState; anchorRefreshApplied: boolean } {
    const working: ContextState = structuredClone(this.state)

    working.elevated = working.elevated.flatMap((item) => {
      const text = elevatedSourceText(item, snapshot)
      if (text === null) return [] // source deleted externally: drop from the ledger
      const hash = this.hasher.hash(text)
      if (hash === item.sourceHash) return [item]
      return [{ ...item, sourceHash: hash, tokens: this.est.count(text, hash) }]
    })

    let anchorRefreshApplied = false
    if (this.pendingAnchorRefresh) {
      working.anchors = {
        refreshedAtTask: working.taskCounter,
        excerpts: selectAnchors(snapshot, knobs.anchorTokensTotal, this.est, this.hasher),
      }
      anchorRefreshApplied = true
    } else {
      const { excerpts } = reconcileAnchors(
        working.anchors.excerpts,
        snapshot,
        knobs.anchorTokensTotal,
        this.est,
        this.hasher,
      )
      working.anchors = { ...working.anchors, excerpts }
    }
    return { working, anchorRefreshApplied }
  }

  // -- §9.3 session API -------------------------------------------------------

  async beginTask(spec: TaskSpec): Promise<TaskContextSession> {
    if (this.activeSession !== null) throw new SessionBusyError()
    if (!INTERACTIVE.has(spec.kind)) {
      throw new EngineValidationError(
        `task kind '${spec.kind}' never opens an engine session (05 §background assembly)`,
      )
    }
    if (spec.kind === 'quick-edit' && spec.target.type !== 'snippet') {
      throw new EngineValidationError('quick-edit targets one snippet in M1 (06 §9.1)')
    }
    const knobs = this.knobs()
    const snapshot = await this.snapshot()
    const { working, anchorRefreshApplied } = this.reconcileState(snapshot, knobs)
    const map = computeDefaultMap(snapshot, knobs, this.est)

    const session = new TaskContextSessionImpl({
      host: {
        workId: this.deps.workId,
        est: this.est,
        hasher: this.hasher,
        renderer: this.renderer,
        emitEnrichmentWanted: (sectionId) => this.deps.channels?.emitEnrichmentWanted?.(sectionId),
        emitUsage: (event) => this.emitUsage(event),
        onAssembled: (assembly, taskSpec) => this.noteAssembly(assembly, taskSpec),
        onFinalize: (outcome, state) => this.completeSession(outcome, state),
        onClosed: () => {
          this.activeSession = null
        },
        now: () => this.now(),
      },
      spec,
      snapshot,
      state: working,
      map,
      knobs,
      anchorRefreshApplied,
    })
    this.activeSession = session
    return session
  }

  /** cache_break attribution + the task_start usage event (§5.4, §8.4). */
  private noteAssembly(assembly: Assembly, spec: TaskSpec): void {
    const task = this.state.taskCounter + 1
    const ts = this.now().toISOString()
    const nextHashes = new Map<string, string>()
    for (const region of assembly.regions) {
      const hash = this.hasher.hash(`${JSON.stringify(region.attrs ?? {})}\n${region.body}`)
      nextHashes.set(region.name, hash)
      const previous = this.lastRegionHashes.get(region.name)
      if (this.pendingFullBreak || (previous !== undefined && previous !== hash)) {
        this.emitUsage({ kind: 'cache_break', task, region: region.name, ts })
      }
    }
    this.pendingFullBreak = false
    this.lastRegionHashes = nextHashes
    this.emitUsage({
      kind: 'task_start',
      task,
      taskKind: spec.kind,
      assembledTokens: assembly.totalTokens,
      regions: Object.fromEntries(assembly.regions.map((r) => [r.name, r.tokens])),
      ts,
    })
  }

  /** finalize("completed"): citations → ledger, decay, evict, persist (§7.2). */
  private async completeSession(outcome: SessionOutcome, working: ContextState): Promise<void> {
    const knobs = this.knobs()
    const result = finalizeTask(
      working,
      {
        opened: outcome.opened,
        citations: outcome.citations,
        resolveCite: outcome.resolveCite,
        // S: base regions + candidate elevations (+ ~20 tokens tag overhead per item).
        estimateAssembled: (elevated) =>
          outcome.baseTokens + elevated.reduce((sum, e) => sum + e.tokens + 20, 0),
      },
      { defaultTtl: knobs.defaultTtl, softBudget: knobs.softBudget, hardCap: knobs.hardCap },
    )
    for (const ref of result.unknownCites) {
      this.warn(`[cowrite] ignored unknown cite ${ref.kind}:${ref.id} (06 §12)`)
    }
    this.state = result.state
    if (outcome.anchorRefreshApplied) this.pendingAnchorRefresh = false
    await this.persist(this.state)
    this.emitUsage({
      kind: 'task_end',
      task: this.state.taskCounter,
      cited: outcome.citations ?? [],
      decayed: result.decayed,
      evicted: result.evicted,
      finalTokens: outcome.finalTokens,
      planningRounds: outcome.planningRounds,
      ts: this.now().toISOString(),
    })
  }

  // -- §11 REST queries -------------------------------------------------------

  /** GET /context/state — the ledger + the computed default fidelity map. */
  async stateRes(): Promise<ContextStateRes> {
    const snapshot = await this.snapshot()
    const map = computeDefaultMap(snapshot, this.knobs(), this.est)
    const defaultMap: DefaultMapEntry[] = [
      ...snapshot.sections.map((s) => ({
        id: s.id,
        kind: 'section' as const,
        fidelity: map.sections.get(s.id) ?? ('name' as Fidelity),
      })),
      ...snapshot.worldEntries.map((e) => ({
        id: e.id,
        kind: 'world' as const,
        fidelity: (map.world.get(e.id) ?? 'name') as Fidelity,
      })),
    ]
    return { state: this.state, defaultMap }
  }

  /** GET /context/candidates — flattened tree + world list, per-fidelity token counts. */
  async candidates(): Promise<ContextCandidate[]> {
    const snapshot = await this.snapshot()
    const map = computeDefaultMap(snapshot, this.knobs(), this.est)
    const current = (kind: 'section' | 'world', id: string, fallback: Fidelity): Fidelity =>
      this.state.elevated.find((e) => e.kind === kind && e.id === id)?.fidelity ?? fallback

    const out: ContextCandidate[] = []
    for (const s of snapshot.sections) {
      const tokens: Partial<Record<Fidelity, number>> = {
        name: this.est.count(`${s.path} ${s.name} ${s.id}`),
      }
      if (s.shortSummary !== null) tokens.short = this.est.count(s.shortSummary)
      if (s.longSummary !== null) tokens.long = this.est.count(s.longSummary)
      if (s.content !== null) tokens.full = this.est.count(s.content, s.contentHash ?? undefined)
      const defaultFidelity = map.sections.get(s.id) ?? 'name'
      out.push({
        id: s.id,
        kind: 'section',
        name: s.name,
        path: s.path,
        defaultFidelity,
        currentFidelity: current('section', s.id, defaultFidelity),
        tokens,
      })
    }
    for (const e of snapshot.worldEntries) {
      const tokens: Partial<Record<Fidelity, number>> = { name: this.est.count(e.name) }
      if (e.shortSummary !== null) tokens.short = this.est.count(e.shortSummary)
      tokens.full = this.est.count(e.body, e.bodyHash)
      const defaultFidelity = (map.world.get(e.id) ?? 'name') as Fidelity
      out.push({
        id: e.id,
        kind: 'world',
        name: e.name,
        path: '',
        defaultFidelity,
        currentFidelity: current('world', e.id, defaultFidelity),
        tokens,
      })
    }
    return out
  }

  /** POST /context/preview — dry-run assembly with the selections overlaid (§11). */
  async preview(req: PreviewRequest): Promise<PreviewResponse> {
    if (!INTERACTIVE.has(req.taskType)) {
      throw new EngineValidationError(
        `preview accepts interactive task kinds only; '${req.taskType}' is not one`,
      )
    }
    const knobs = this.knobs()
    const snapshot = await this.snapshot()
    const { working } = this.reconcileState(snapshot, knobs)
    const map = computeDefaultMap(snapshot, knobs, this.est)

    for (const selection of req.selections) {
      if (selection.kind === 'snippet') continue // snippets are always full already
      const source = elevatedSourceText(
        { kind: selection.kind, id: selection.id, fidelity: selection.fidelity },
        snapshot,
      )
      if (source === null) continue // unknown selection ids preview as no-ops
      const at = working.elevated.findIndex(
        (e) => e.kind === selection.kind && e.id === selection.id,
      )
      const entry = {
        kind: selection.kind,
        id: selection.id,
        fidelity: selection.fidelity,
        ttl: knobs.defaultTtl,
        source: 'user' as const,
        elevatedAtTask: working.taskCounter,
        lastCitedTask: working.taskCounter,
        tokens: this.est.count(source),
        sourceHash: this.hasher.hash(source),
      }
      if (at === -1) working.elevated.push(entry)
      else
        working.elevated[at] = {
          ...entry,
          elevatedAtTask: working.elevated[at]?.elevatedAtTask ?? working.taskCounter,
        }
    }

    const spec = previewSpec(req.taskType)
    const assembly = assemble({
      snapshot,
      state: working,
      map,
      knobs,
      spec,
      instructionsBody: this.renderer.instructionsBody(spec),
      task: this.renderer.taskRegion(spec),
      est: this.est,
      workId: this.deps.workId,
    })
    return {
      totalTokens: assembly.totalTokens,
      perRegion: Object.fromEntries(assembly.regions.map((r) => [r.name, r.tokens])),
      overSoft: assembly.totalTokens > knobs.softBudget,
      overHard: assembly.totalTokens > knobs.hardCap,
      softBudget: knobs.softBudget,
      hardCap: knobs.hardCap,
    }
  }

  /** POST /context/reset — wipe ledger + anchors; emits cache_break for every region. */
  async reset(): Promise<void> {
    if (this.activeSession !== null) throw new SessionBusyError()
    this.state = structuredClone(EMPTY_STATE)
    this.pendingAnchorRefresh = true
    await this.persist(this.state)
    const ts = this.now().toISOString()
    const task = this.state.taskCounter + 1
    for (const region of this.lastRegionHashes.keys()) {
      this.emitUsage({ kind: 'cache_break', task, region, ts })
    }
    this.lastRegionHashes = new Map()
  }

  /**
   * GET /context/usage — the most recent usage events, oldest first. A bounded tail
   * read: only the last `limit` lines are pulled (topping up from the rotated `.1`
   * generation when the live file is shorter), never the whole log.
   */
  async usage(limit: number): Promise<UsageEvent[]> {
    await this.usageTail
    const live = await readJsonlTailLines(this.usagePath(), limit)
    const lines =
      live.length >= limit
        ? live
        : [...(await readJsonlTailLines(`${this.usagePath()}.1`, limit - live.length)), ...live]
    const events: UsageEvent[] = []
    for (const line of lines) {
      let raw: unknown
      try {
        raw = JSON.parse(line)
      } catch {
        continue // torn tail line (crash mid-append) — readers tolerate it
      }
      const parsed = UsageEventSchema.safeParse(raw)
      if (parsed.success) events.push(parsed.data)
    }
    return events.slice(-limit)
  }
}

/** A minimal interactive spec for dry-run preview assembly (no user text known yet). */
function previewSpec(taskType: PreviewRequest['taskType']): TaskSpec {
  switch (taskType) {
    case 'instructed-continue':
      return { kind: 'instructed-continue', instruction: ' ' }
    default:
      // quick-edit/edit-task previews assemble continue-shaped: the target and
      // instruction arrive only at POST /tasks; the base map is what the meter needs.
      return { kind: 'continue' }
  }
}
