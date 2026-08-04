import process from 'node:process'
import type { MockLlm } from '@cowrite/mock-llm'
import type { AppConfig, RunArtifact, RunEvent, WorkEvent, WorkEventOf } from '@cowrite/shared'
import { RunEvent as RunEventSchema } from '@cowrite/shared'
import { formatConfigIssues, resolveEffectiveConfig } from './config/effective.js'
import { engineFor } from './context/routes.js'
import { createSseFrameSink } from './events/sseFrames.js'
import { listRunFiles, listRunIds } from './harness/proposals.js'
import { AgentHarness } from './harness/service.js'
import type { InteractiveSpec } from './harness/tasks.js'
import { type OpenWork, WorkRegistry } from './http/workRegistry.js'
import type { LaneDeps } from './models/lanes.js'
import { readJsonlBoundaryLines, readJsonlTailLines } from './storage/lib/fsx.js'
import { wordCount } from './storage/lib/hash.js'
import { shortId } from './storage/lib/paths.js'
import { createStorage, type StorageService, type WorkHandle } from './storage/service.js'

/**
 * Stage-3 agent commands for the dev CLI (docs/10 §Stage 1 dev-CLI note + §Stage 3):
 * `continue` / `instruct` / `quick-edit` run through the SAME harness code path the HTTP
 * layer uses (WorkRegistry → AgentHarness → runner), streaming composition deltas off the
 * per-work event bus to stdout; `prompt render` assembles via the real engine session and
 * prints the exact prompt without any model call; `context preview`/`context state` and
 * `runs list`/`runs show` are the read-only inspection surfaces.
 *
 * Everything takes an injected `out` writer so tests capture the stream in-process.
 * COWRITE_MOCK_LLM=1 boots `@cowrite/mock-llm` in-process (docs/09 §2.3) and the task
 * commands script one deterministic composition per submit — the scenario queue is
 * strict, so an unscripted mock request would fail loudly.
 */

export type CliWrite = (text: string) => void

// ---------------------------------------------------------------------------
// Runtime: storage + registry + harness wired exactly like the server's
// composition root (src/index.ts), minus HTTP.
// ---------------------------------------------------------------------------

export interface CliRuntimeOptions {
  dataDir: string
  /** Env for config + mock detection; defaults to process.env. */
  env?: NodeJS.ProcessEnv
  /** Test seam: skip config-file loading and use this config as-is. */
  config?: AppConfig
  /** Model-client test seams (instant retry sleeps). */
  laneDeps?: LaneDeps
}

export interface CliRuntime {
  readonly storage: StorageService
  readonly works: WorkRegistry
  readonly harness: AgentHarness
  readonly config: AppConfig
  /** Non-null when COWRITE_MOCK_LLM requested an in-process mock (both lanes). */
  readonly mockLlm: MockLlm | null
  openBySlug(slug: string): Promise<OpenWork>
  close(): Promise<void>
}

export async function createCliRuntime(options: CliRuntimeOptions): Promise<CliRuntime> {
  const env = options.env ?? process.env
  let mockLlm: MockLlm | null = null
  let config: AppConfig

  if (options.config !== undefined) {
    config = options.config
  } else {
    // The SAME effective-config resolution the server root uses (config/effective.ts):
    // mock mode tolerantly loads the user config and OVERLAYS the mock lanes on top —
    // an invalid config under mock mode warns and runs on defaults, never fatal.
    const resolved = await resolveEffectiveConfig({ env })
    if (!resolved.ok) {
      throw new Error(
        `invalid config at ${resolved.configPath}:\n${formatConfigIssues(resolved.issues)}`,
      )
    }
    for (const warning of resolved.warnings) console.warn(warning)
    config = resolved.config
    if (resolved.mock) {
      const { createMockLlm } = await import('@cowrite/mock-llm')
      const { withMockModels } = await import('./harness/mockLlm.js')
      mockLlm = await createMockLlm()
      config = withMockModels(config, mockLlm.url)
    }
  }

  const storage = createStorage(options.dataDir)
  const works = new WorkRegistry(storage)
  const harness = new AgentHarness({
    config: () => config,
    budgets: () => config.budgets,
    ...(options.laneDeps === undefined ? {} : { laneDeps: options.laneDeps }),
  })
  works.onClose((open) => harness.closeWork(open))
  works.onOpen((open) => harness.attachWork(open)) // attach-frame hydration (03 §8.3)

  return {
    storage,
    works,
    harness,
    config,
    mockLlm,
    openBySlug: async (slug) => {
      const listing = (await storage.listWorks()).find((w) => w.slug === slug)
      if (listing === undefined) throw new Error(`no work '${slug}' in ${options.dataDir}`)
      if (!listing.ok) throw new Error(`work '${slug}' is broken: ${listing.warning}`)
      return works.open(listing.meta.id)
    },
    close: async () => {
      await works.closeAll()
      await mockLlm?.close()
    },
  }
}

/** Parse the bus's SSE frames back into WorkEvents (the same bytes a web client gets). */
function attachEventListener(open: OpenWork, onEvent: (event: WorkEvent) => void): () => void {
  return open.bus.attach(createSseFrameSink(onEvent))
}

// ---------------------------------------------------------------------------
// continue / instruct / quick-edit — the real harness path, streamed to stdout.
// ---------------------------------------------------------------------------

/** What the CLI knows before the work is open; quick-edit resolves its target below. */
export type CliTaskRequest =
  | { kind: 'continue' }
  | { kind: 'instructed-continue'; instruction: string }
  | { kind: 'quick-edit'; snippetId: string; instruction: string }

export interface TaskCommandOptions {
  out: CliWrite
  /** Cancel the task after this many ms (testing the cancel path). */
  cancelAfterMs?: number
}

export interface TaskCommandResult {
  status: 'done' | 'error' | 'cancelled'
  runId: string
  artifacts: RunArtifact[]
}

const MOCK_CONTINUE_TEXT =
  'The mock model continues the story with one steady, deterministic paragraph — ' +
  'enough prose to stream in visible chunks while the console (or a test) captures stdout, ' +
  'and to end at a natural beat.'
const MOCK_EDIT_TEXT = 'The mock model rewrites the target snippet with one deterministic sentence.'

/** One scripted composition per submit — the strict scenario queue never free-runs. */
function scriptMockComposition(llm: MockLlm, spec: InteractiveSpec): void {
  const id =
    spec.kind === 'quick-edit' && spec.target.type === 'snippet' ? spec.target.snippetId : 'new'
  const body = spec.kind === 'quick-edit' ? MOCK_EDIT_TEXT : MOCK_CONTINUE_TEXT
  llm.scenario.respondStream(`<snippet id="${id}">\n${body}\n</snippet>\n`, {
    chunkSize: 16,
    delayMs: 5,
  })
}

async function toInteractiveSpec(
  handle: WorkHandle,
  request: CliTaskRequest,
): Promise<InteractiveSpec> {
  if (request.kind !== 'quick-edit') return request
  const snippet = await handle.getSnippet(request.snippetId) // SnippetNotFoundError → message
  return {
    kind: 'quick-edit',
    instruction: request.instruction,
    target: { type: 'snippet', snippetId: snippet.id, baseRev: snippet.rev },
    // The CLI edits the whole snippet: the selection is its full text (M1 single-snippet rule).
    selection: { text: snippet.text, start: 0, end: snippet.text.length },
  }
}

function formatArtifact(artifact: RunArtifact): string {
  const id = artifact.snippetId ?? artifact.sectionId ?? artifact.entryId ?? '(unknown)'
  if (artifact.state === 'conflict') {
    return (
      `conflict: ${artifact.kind} ${id} changed under the run — the rewrite is kept as a ` +
      'proposal (apply/discard via the proposal routes)'
    )
  }
  const rev = artifact.rev === undefined ? '' : ` rev ${artifact.rev}`
  return `committed ${artifact.kind} ${id}${rev}`
}

export async function runTaskCommand(
  rt: CliRuntime,
  slug: string,
  request: CliTaskRequest,
  options: TaskCommandOptions,
): Promise<TaskCommandResult> {
  const { out } = options
  const open = await rt.openBySlug(slug)
  const spec = await toInteractiveSpec(open.handle, request)
  const before =
    spec.kind === 'quick-edit' && spec.target.type === 'snippet'
      ? await open.handle.getSnippet(spec.target.snippetId)
      : null

  if (rt.mockLlm !== null) scriptMockComposition(rt.mockLlm, spec)

  const artifacts: RunArtifact[] = []
  let usageEvent: WorkEventOf<'task.usage'> | null = null
  let failedEvent: WorkEventOf<'task.failed'> | null = null
  let cancelledEvent: WorkEventOf<'task.cancelled'> | null = null
  let streamed = false

  let settle: (status: TaskCommandResult['status']) => void = () => {}
  const terminal = new Promise<TaskCommandResult['status']>((resolve) => {
    settle = resolve
  })

  // The interactive lane holds one task at a time, and it is ours: no taskId filtering.
  const detach = attachEventListener(open, (event) => {
    switch (event.type) {
      case 'task.delta':
        streamed = true
        out(event.text)
        break
      case 'task.stage':
        if (event.stage === 'planning') out('[planning]\n')
        break
      case 'task.tool':
        out(`[tool] ${event.label}\n`)
        break
      case 'task.retrying':
        out(`\n[retrying — attempt ${event.attempt}: ${event.reason}]\n`)
        break
      case 'task.artifact':
        artifacts.push(event.artifact)
        break
      case 'task.usage':
        usageEvent = event
        break
      case 'task.failed':
        failedEvent = event
        settle('error')
        break
      case 'task.cancelled':
        cancelledEvent = event
        settle('cancelled')
        break
      case 'task.completed':
        settle('done')
        break
      default:
        break
    }
  })

  try {
    const task = await rt.harness.submit(open, spec)
    if (options.cancelAfterMs !== undefined) {
      const timer = setTimeout(() => {
        try {
          rt.harness.cancel(open, task.id)
        } catch {
          // already terminal — nothing to cancel
        }
      }, options.cancelAfterMs)
      timer.unref?.()
    }
    const status = await terminal
    if (streamed) out('\n')
    out('\n')

    if (status === 'done') {
      for (const artifact of artifacts) out(`${formatArtifact(artifact)}\n`)
      const committed = artifacts.find(
        (a) => a.kind === 'snippet-revision' && a.state === 'committed',
      )
      if (before !== null && committed?.snippetId !== undefined) {
        const after = await open.handle.getSnippet(committed.snippetId)
        out(`words: ${wordCount(before.text)} -> ${wordCount(after.text)}\n`)
      }
    } else if (status === 'cancelled') {
      const partial = (cancelledEvent as WorkEventOf<'task.cancelled'> | null)?.partialText ?? null
      out(
        partial === null
          ? 'task cancelled\n'
          : `task cancelled — ${wordCount(partial)}w partial kept in run ${task.id} ` +
              '(keep-partial proposal)\n',
      )
    } else {
      const failed = failedEvent as WorkEventOf<'task.failed'> | null
      out(`task failed [${failed?.code ?? 'internal'}]: ${failed?.message ?? 'unknown error'}\n`)
      if (failed?.partialText != null) {
        out(
          `partial (${wordCount(failed.partialText)}w) kept — keep-partial proposal on run ${task.id}\n`,
        )
      }
    }

    const usage = usageEvent as WorkEventOf<'task.usage'> | null
    if (usage !== null) {
      const cost =
        usage.costUsd === null
          ? 'cost n/a (prices unconfigured)'
          : `cost $${usage.costUsd.toFixed(4)}`
      out(
        `usage: ${usage.promptTokens} prompt + ${usage.completionTokens} completion tok — ${cost}\n`,
      )
    }
    out(`run ${task.id}\n`)
    return { status, runId: task.id, artifacts }
  } finally {
    detach()
  }
}

// ---------------------------------------------------------------------------
// prompt render — the real engine session, no model call, aborted cleanly.
// ---------------------------------------------------------------------------

export interface PromptRenderOptions {
  kind: 'continue' | 'instructed-continue' | 'quick-edit'
  targetId?: string
  instruction?: string
  json: boolean
  out: CliWrite
}

async function buildRenderSpec(
  handle: WorkHandle,
  options: PromptRenderOptions,
): Promise<InteractiveSpec> {
  const instruction = options.instruction ?? '(instruction not provided)'
  if (options.kind === 'continue') return { kind: 'continue' }
  if (options.kind === 'instructed-continue') return { kind: 'instructed-continue', instruction }
  if (options.targetId === undefined) {
    throw new Error('prompt render --kind quick-edit needs --target <snippetId>')
  }
  const snippet = await handle.getSnippet(options.targetId)
  return {
    kind: 'quick-edit',
    instruction,
    target: { type: 'snippet', snippetId: snippet.id, baseRev: snippet.rev },
    selection: { text: snippet.text, start: 0, end: snippet.text.length },
  }
}

export async function promptRenderCommand(
  rt: CliRuntime,
  slug: string,
  options: PromptRenderOptions,
): Promise<void> {
  const open = await rt.openBySlug(slug)
  const spec = await buildRenderSpec(open.handle, options)
  const engine = await engineFor(open, () => rt.config.budgets)
  const session = await engine.beginTask(spec)
  try {
    const assembled = session.assembleInitialPrompt()
    if (options.json) {
      options.out(`${JSON.stringify(assembled.snapshot, null, 2)}\n`)
      return
    }
    for (const message of assembled.messages) {
      options.out(`──── ${message.role} ${'─'.repeat(Math.max(4, 40 - message.role.length))}\n`)
      options.out(`${message.content}\n`)
    }
  } finally {
    // Engine abort semantics (06): discard the session, no ledger mutation, no persistence.
    session.abort()
  }
}

// ---------------------------------------------------------------------------
// context preview / context state
// ---------------------------------------------------------------------------

const FIDELITIES = ['name', 'short', 'long', 'full'] as const

export async function contextPreviewCommand(
  rt: CliRuntime,
  slug: string,
  out: CliWrite,
): Promise<void> {
  const open = await rt.openBySlug(slug)
  const engine = await engineFor(open, () => rt.config.budgets)
  const preview = await engine.preview({ taskType: 'continue', selections: [], targets: [] })
  const candidates = await engine.candidates()

  const softStatus = preview.overSoft ? 'OVER' : 'ok'
  const hardStatus = preview.overHard ? 'OVER' : 'ok'
  out(
    `assembled ~${preview.totalTokens} tok — soft budget ${preview.softBudget} (${softStatus}), ` +
      `hard cap ${preview.hardCap} (${hardStatus})\n`,
  )
  out('regions:\n')
  for (const [name, tokens] of Object.entries(preview.perRegion)) {
    out(`  ${name.padEnd(18)} ${String(tokens).padStart(7)} tok\n`)
  }
  out(`items (${candidates.length}):\n`)
  if (candidates.length === 0) out('  (no sections or world entries yet)\n')
  for (const candidate of candidates) {
    const tokens = FIDELITIES.filter((f) => candidate.tokens[f] !== undefined)
      .map((f) => `${f} ${candidate.tokens[f]}`)
      .join(' / ')
    const elevated =
      candidate.currentFidelity === candidate.defaultFidelity
        ? ''
        : ` (default ${candidate.defaultFidelity})`
    const label = candidate.path === '' ? candidate.name : `${candidate.path} ${candidate.name}`
    out(
      `  ${candidate.kind.padEnd(7)} ${label}  #${shortId(candidate.id)}  ` +
        `fidelity ${candidate.currentFidelity}${elevated}  [${tokens}]\n`,
    )
  }
}

export async function contextStateCommand(
  rt: CliRuntime,
  slug: string,
  out: CliWrite,
): Promise<void> {
  const open = await rt.openBySlug(slug)
  const engine = await engineFor(open, () => rt.config.budgets)
  const { state } = await engine.stateRes()
  out(
    `task counter ${state.taskCounter}; anchors refreshed at task ` +
      `${state.anchors.refreshedAtTask} (${state.anchors.excerpts.length} excerpt(s))\n`,
  )
  out(`elevation ledger (${state.elevated.length} item(s)):\n`)
  if (state.elevated.length === 0) out('  (empty — nothing elevated above its default)\n')
  for (const item of state.elevated) {
    out(
      `  ${item.kind.padEnd(7)} ${item.id}  ${item.fidelity.padEnd(5)} ttl ${item.ttl}  ` +
        `source ${item.source}  elevated@${item.elevatedAtTask} lastCited@${item.lastCitedTask}  ` +
        `${item.tokens} tok\n`,
    )
  }
}

// ---------------------------------------------------------------------------
// runs list / runs show — provenance straight from the run files.
// ---------------------------------------------------------------------------

// Run-file enumeration lives with the proposal reconstruction (harness/proposals.ts) —
// the attach-frame path needs it too; re-exported here for the CLI's callers/tests.
export { listRunIds }

type MetaEvent = Extract<RunEvent, { type: 'meta' }>
type ResultEvent = Extract<RunEvent, { type: 'result' }>

/** Parse one JSONL line as a RunEvent; null for torn/foreign lines (listing tolerates). */
function parseRunEventLine(line: string | null | undefined): RunEvent | null {
  if (line == null) return null
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  const parsed = RunEventSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/** How many trailing lines `runs list` inspects for the result: the result line itself
 *  plus the (at most one) post-result proposal-resolution line, with one line of slack. */
const RUNS_LIST_TAIL_LINES = 3

export async function runsListCommand(rt: CliRuntime, slug: string, out: CliWrite): Promise<void> {
  const open = await rt.openBySlug(slug)
  const runFiles = await listRunFiles(open.handle.workDir)
  if (runFiles.length === 0) {
    out('no runs recorded\n')
    return
  }
  out(`${runFiles.length} run(s):\n`)
  for (const { runId, fileAbs } of runFiles) {
    // Boundary-line reads only (never the full transcript): meta is the first line;
    // the result is the last line unless a proposal resolution was appended after it,
    // so scan a short tail window backwards.
    const { first } = await readJsonlBoundaryLines(fileAbs)
    const head = parseRunEventLine(first)
    const meta: MetaEvent | undefined = head?.type === 'meta' ? head : undefined
    let result: ResultEvent | undefined
    const tail = await readJsonlTailLines(fileAbs, RUNS_LIST_TAIL_LINES)
    for (let i = tail.length - 1; i >= 0; i--) {
      const event = parseRunEventLine(tail[i])
      if (event?.type === 'result') {
        result = event
        break
      }
    }
    const kind = meta?.kind ?? '(no meta)'
    const model = meta === undefined ? '' : `  ${meta.lane}/${meta.model}`
    const status = result?.status ?? '(unfinished)'
    const usage =
      result === undefined
        ? ''
        : `  ${result.usageTotal.promptTokens}+${result.usageTotal.completionTokens} tok`
    const span =
      meta === undefined
        ? ''
        : `  ${meta.startedAt}${result === undefined ? '' : ` -> ${result.endedAt}`}`
    out(`  ${runId}  ${String(kind).padEnd(20)} ${status.padEnd(11)}${model}${usage}${span}\n`)
  }
}

function previewText(text: string, max = 60): string {
  const flat = text.replaceAll('\r', '').replaceAll('\n', ' ')
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `    | ${line}`)
    .join('\n')
}

/** One run event → its transcript line(s). Exported for the formatting tests. */
export function formatRunEvent(event: RunEvent, options: { full: boolean }): string {
  switch (event.type) {
    case 'meta': {
      const regions =
        event.contextSnapshot === null
          ? 'no context snapshot'
          : event.contextSnapshot.regions.map((r) => `${r.name} ${r.tokens}`).join(', ')
      return (
        `meta      ${event.kind}  lane ${event.lane}  model ${event.model}  ` +
        `started ${event.startedAt}\n  context: ${regions}`
      )
    }
    case 'message': {
      const head = `message   ${event.role} (${event.text.length} chars)`
      return options.full
        ? `${head}\n${indent(event.text)}`
        : `${head}: "${previewText(event.text)}"`
    }
    case 'stage':
      return `stage     ${event.stage} (round ${event.round})`
    case 'toolCall':
      return `tool      ${event.name}  ${event.durationMs}ms -> ${event.output.length} chars`
    case 'output':
      return `output    ${event.text.length} chars streamed`
    case 'attempt':
      return `attempt   #${event.n} (${event.reason})`
    case 'usage': {
      const estimated = event.estimated ? ' (estimated)' : ''
      return `usage     ${event.call}  ${event.promptTokens}+${event.completionTokens} tok${estimated}`
    }
    case 'proposal':
      return `proposal  ${event.resolution} at ${event.at}`
    case 'result': {
      const error =
        event.error === undefined ? '' : `  [${event.error.code}] ${event.error.message}`
      const artifacts =
        event.artifacts.length === 0
          ? 'none'
          : event.artifacts
              .map((a) => {
                const id = a.snippetId ?? a.sectionId ?? a.entryId ?? '(unknown)'
                const rev = a.rev === undefined ? '' : ` rev ${a.rev}`
                return `${a.kind} ${id}${rev} (${a.state})`
              })
              .join('; ')
      const partial =
        event.partialText === null ? '' : `\n  partial: "${previewText(event.partialText)}"`
      return (
        `result    ${event.status}${error}  ` +
        `${event.usageTotal.promptTokens}+${event.usageTotal.completionTokens} tok  ` +
        `ended ${event.endedAt}\n  artifacts: ${artifacts}${partial}`
      )
    }
  }
}

export async function runsShowCommand(
  rt: CliRuntime,
  slug: string,
  runId: string,
  options: { full: boolean; out: CliWrite },
): Promise<void> {
  const open = await rt.openBySlug(slug)
  const events = await open.handle.readRun(runId) // RunNotFoundError → message
  options.out(`run ${runId} — ${events.length} event(s)\n`)
  for (const event of events) options.out(`${formatRunEvent(event, options)}\n`)
}
