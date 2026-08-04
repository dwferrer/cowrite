import type { ErrorCode, HarnessKnobs, RunArtifact, Task } from '@cowrite/shared'
import type { ContextEngine } from '../context/engine.js'
import { EngineValidationError, SessionBusyError } from '../context/engine.js'
import type { TaskContextSession } from '../context/session.js'
import type { WorkEventBus } from '../events/bus.js'
import type { ChatMessage, ChatResult, OpenAiCompatClient } from '../models/client.js'
import { ModelClientError } from '../models/client.js'
import { deriveCostUsd } from '../models/usage.js'
import {
  describeParseFailure,
  formatBlockList,
  isCloseLine,
  parseOpeningLine,
  parseTaskOutput,
} from '../prompt/outputParser.js'
import { renderTemplate, type TemplateSet } from '../prompt/templates/loader.js'
import { StorageError } from '../storage/errors.js'
import type { RunSink } from '../storage/runStore.js'
import { ReadOnlyError, type WorkHandle } from '../storage/service.js'
import { type InteractiveSpec, planFor, type TaskPlan } from './tasks.js'

/**
 * The two-stage agent loop (docs/05-agents.md §4): engine `beginTask` →
 * `assembleInitialPrompt` → model calls with the SAME `tools` array on every request →
 * planning tool-calls dispatched to `session.handleToolCall` → after `finish_planning`
 * (or an engine cap) the append-only refresh turn and one `toolChoice:"none"` composition
 * call. A no-tool-call prose response IS the composition (§4.1 rule 2). Output goes
 * through the tag-block parser with ONE repair turn (§5.5); commits are the task plan's;
 * `session.finalize` on success, `abort()` on every error/cancel path. The full RunEvent
 * stream tees to `storage.recordRun` as it happens (§7), so crash finalization and
 * keep-partial reconstruction (§6.5) work from the file alone.
 */

export interface RunnerDeps {
  handle: WorkHandle
  bus: WorkEventBus
  engine: ContextEngine
  client: OpenAiCompatClient
  templates: TemplateSet
  knobs: HarnessKnobs
  now?: () => Date
  /** Non-fatal diagnostics (post-commit append failures); defaults to console.warn. */
  warn?: (message: string) => void
}

export interface RunnerResult {
  status: 'ok' | 'error' | 'cancelled'
  error: { code: ErrorCode; message: string; retryable: boolean } | null
  artifacts: RunArtifact[]
  partialText: string | null
  /** Usage across EVERY attempt, failed streams included (05 §9 usage honesty). */
  usageTotal: { promptTokens: number; completionTokens: number; estimated: boolean }
}

/** A typed terminal failure raised inside the loop (e.g. output_invalid after repair).
 *  Exported for the background runner (backgroundTasks.ts), which shares the taxonomy. */
export class RunFailureError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly retryableFlag: boolean,
  ) {
    super(message)
    this.name = 'RunFailureError'
  }
}

export class AbortedError extends Error {
  constructor() {
    super('task cancelled')
    this.name = 'AbortedError'
  }
}

/**
 * Streaming delta gate (§5.2): withholds everything until an expected opening tag line,
 * streams block interiors as deltas, and swallows close-tag lines and between-block
 * chatter. Presentation only — the committed text always comes from `parseTaskOutput`
 * over the complete response, which owns the greedy-close edge cases.
 */
export class BlockStreamGate {
  private buffer = ''
  private inside: string | null = null
  /** Chars of the current incomplete line already emitted (partial-line streaming). */
  private partialSent = 0

  constructor(
    private readonly expectedTags: ReadonlySet<string>,
    private readonly emit: (text: string) => void,
    private readonly onBlockOpen: () => void,
  ) {}

  push(delta: string): void {
    this.buffer += delta
    for (;;) {
      const nl = this.buffer.indexOf('\n')
      if (nl === -1) break
      const line = this.buffer.slice(0, nl)
      this.buffer = this.buffer.slice(nl + 1)
      if (this.partialSent > 0) {
        // The rest of a content line whose head already streamed: cannot be a tag line.
        this.emit(`${line.slice(this.partialSent)}\n`)
        this.partialSent = 0
      } else {
        this.completeLine(line.endsWith('\r') ? line.slice(0, -1) : line)
      }
    }
    // Prose streams token-by-token WITHIN a line too — withhold only line heads that
    // might still become the close tag (or any tag-shaped line).
    if (
      this.inside !== null &&
      this.buffer.length > this.partialSent &&
      !(this.partialSent === 0 && this.buffer.startsWith('<'))
    ) {
      this.emit(this.buffer.slice(this.partialSent))
      this.partialSent = this.buffer.length
    }
  }

  private completeLine(line: string): void {
    if (this.inside === null) {
      const opening = parseOpeningLine(line, this.expectedTags)
      if (opening !== null) {
        this.inside = opening.tag
        this.onBlockOpen()
      }
      return // chatter outside blocks costs nothing (§5.2)
    }
    if (isCloseLine(line, this.inside)) {
      this.inside = null
      return
    }
    this.emit(`${line}\n`)
  }

  /** Flush the trailing partial line — unless it is a (possibly torn) tag line. */
  finish(): void {
    if (this.inside !== null && this.buffer.length > this.partialSent) {
      // A withheld head always starts with '<' (a whole or torn close tag); only
      // partially-streamed content lines flush their remainder.
      if (this.partialSent > 0 || !this.buffer.startsWith('<')) {
        this.emit(this.buffer.slice(this.partialSent))
      }
    }
    this.buffer = ''
    this.partialSent = 0
    this.inside = null
  }
}

/**
 * Best-effort prose extraction from a raw partial response: run the raw text through the
 * streaming gate so keep-partial drafts contain the block interior, not tag markup. Raw
 * text that never opened a block (already-clean prose, or a pre-tag preamble) passes
 * through unchanged. Used for `partialText` on results/events and by proposal
 * reconstruction (which must also handle crash-finalized raw output, 02 §10.7).
 */
export function cleanPartialText(raw: string, expectedTags: ReadonlySet<string>): string | null {
  const trimmedRaw = raw.replace(/\n+$/, '')
  if (trimmedRaw.trim() === '') return null
  let out = ''
  const gate = new BlockStreamGate(
    expectedTags,
    (text) => {
      out += text
    },
    () => {},
  )
  gate.push(raw)
  gate.finish()
  const prose = out.replace(/\n+$/, '')
  return prose.trim() !== '' ? prose : trimmedRaw
}

const OUTPUT_FLUSH_BYTES = 2048
const OUTPUT_FLUSH_MS = 2000

type SinkAppend = RunSink['append']

/**
 * Buffers composition deltas into consolidated `output` run events (§7.1: ≥ 2 s / 2 KB),
 * each tagged with the model-call attempt that streamed it (run-wide monotonic index) so
 * crash finalization and proposal reconstruction can isolate the FINAL attempt's text.
 * Mid-stream flush promises are routed into the runner's side-effect collection — never
 * `void`-dropped — so a rejecting sink surfaces on the error path instead of as an
 * unhandled rejection.
 */
export class OutputTee {
  private pending = ''
  private lastFlush: number

  constructor(
    private readonly append: SinkAppend,
    private readonly nowMs: () => number,
    /** Current run-wide attempt index at flush time. */
    private readonly attempt: () => number,
    /** Where un-awaited flush promises go (the runner's sideEffects). */
    private readonly collect: (p: Promise<void>) => void,
  ) {
    this.lastFlush = nowMs()
  }

  push(text: string): void {
    this.pending += text
    if (
      this.pending.length >= OUTPUT_FLUSH_BYTES ||
      this.nowMs() - this.lastFlush >= OUTPUT_FLUSH_MS
    ) {
      this.collect(this.flush())
    }
  }

  flush(): Promise<void> {
    if (this.pending === '') return Promise.resolve()
    const text = this.pending
    this.pending = ''
    this.lastFlush = this.nowMs()
    return this.append({ type: 'output', text, attempt: this.attempt() })
  }
}

export async function runInteractiveTask(
  task: Task,
  spec: InteractiveSpec,
  deps: RunnerDeps,
  signal: AbortSignal,
): Promise<RunnerResult> {
  const runId = task.id
  const now = deps.now ?? (() => new Date())
  const plan: TaskPlan = planFor(spec)
  const publish = deps.bus.publish.bind(deps.bus)

  let orderKey: string | null = null
  let committed = false
  let session: TaskContextSession | null = null
  let sink: RunSink | null = null
  // Usage honesty (05 §9): every attempt accumulates, failed/aborted streams included;
  // `estimated` goes true the moment ANY component was a chars/4 estimate.
  const usageTotal = { promptTokens: 0, completionTokens: 0, estimated: false }
  const addUsage = (u: { promptTokens: number; completionTokens: number; estimated: boolean }) => {
    usageTotal.promptTokens += u.promptTokens
    usageTotal.completionTokens += u.completionTokens
    usageTotal.estimated ||= u.estimated
  }
  // The FINAL attempt's partial composition text (§6.5) — abandoned attempts never fuse.
  let partial = ''
  // Un-awaited sink appends. Await-settled BEFORE plan.commit so a failing append can
  // fail the run while nothing has committed yet — and can never fail it afterwards.
  const sideEffects: Promise<void>[] = []
  const collectSideEffect = (p: Promise<void>): void => {
    // Pre-attach a no-op handler so a rejection landing before the pre-commit await is
    // never an unhandled rejection; the awaits below still observe the original promise.
    p.catch(() => {})
    sideEffects.push(p)
  }

  const checkAborted = (): void => {
    if (signal.aborted) throw new AbortedError()
  }

  try {
    if (plan.needsOrderKey) orderKey = await deps.handle.reserveOrderKey()
    await deps.handle.reconcile() // pre-run, 02 §reconciler
    session = await deps.engine.beginTask(spec)
    const assembled = session.assembleInitialPrompt()
    sink = await deps.handle.recordRun(runId, task.startedAt ?? now().toISOString())
    const append: SinkAppend = (event) => (sink as NonNullable<typeof sink>).append(event)

    await append({
      type: 'meta',
      runId,
      kind: spec.kind,
      lane: deps.client.lane,
      model: deps.client.endpoint.model,
      spec,
      params: {
        promptsHash: deps.templates.promptsHash,
        temperature: deps.client.endpoint.temperature,
        maxOutputTokens: deps.client.endpoint.maxOutputTokens,
      },
      contextSnapshot: assembled.snapshot,
      startedAt: task.startedAt ?? now().toISOString(),
    })
    for (const message of assembled.messages) {
      await append({ type: 'message', role: message.role, text: message.content })
    }

    // The conversation, strictly append-only; `tools` bytes identical on every call (§4.1).
    const messages: ChatMessage[] = assembled.messages.map((m) => ({
      role: m.role,
      content: m.content,
    }))
    const tools = assembled.tools

    let stagedWriting = false
    let stagedPlanning = false
    let round = 0
    // ONE attempt sequence for the whole run: every model call — first tries, the
    // client's pre-delivery retries, the runner's post-delivery replays, the repair turn
    // — takes the next index. Output events carry it (per-attempt segregation, §6.5) and
    // `task.retrying`/`attempt` numbering is collision-free by construction.
    let attemptSeq = 0

    const noteWriting = (): void => {
      if (stagedWriting) return
      stagedWriting = true
      collectSideEffect(append({ type: 'stage', stage: 'writing', round }))
      publish({ type: 'task.stage', taskId: runId, stage: 'writing' })
    }

    /**
     * One LOGICAL model call (§6.5) under one shared attempt budget: the client performs
     * pre-delivery retries against the budget's remainder (reporting each upward via
     * `onRetry`); the runner owns retry-after-deltas (overlay reset + task.retrying).
     * Total calls per logical turn ≤ `knobs.retry.maxAttempts` — never attempts².
     */
    const chatCall = async (req: { toolChoice?: 'none' }): Promise<ChatResult> => {
      let turnCalls = 0 // calls this logical turn — the budget the client shares
      for (;;) {
        turnCalls++
        attemptSeq++
        checkAborted()
        const tee = new OutputTee(
          (e) => append(e),
          () => now().getTime(),
          () => attemptSeq,
          collectSideEffect,
        )
        const gate = new BlockStreamGate(
          new Set(plan.expectedBlocks.map((b) => b.tag)),
          (text) => deps.bus.publishTaskDelta(runId, plan.deltaTarget, text),
          noteWriting,
        )
        let raw = ''
        try {
          const result = await deps.client.chat(
            {
              messages,
              tools,
              ...(req.toolChoice === undefined ? {} : { toolChoice: req.toolChoice }),
            },
            {
              signal,
              // Remaining budget INCLUDING the call the client is about to make.
              attemptBudget: deps.knobs.retry.maxAttempts - turnCalls + 1,
              onDelta: (delta) => {
                raw += delta
                tee.push(delta)
                gate.push(delta)
              },
              // Pre-delivery retries (429/5xx before any token) are the client's to
              // replay, but they draw on the SAME budget and sequence: the run records
              // the attempt and the streaming block shows the retrying badge (05 §6.4).
              onRetry: (retryErr) => {
                turnCalls++
                attemptSeq++
                collectSideEffect(append({ type: 'attempt', n: attemptSeq, reason: retryErr.code }))
                if (retryErr.usage !== null) addUsage(retryErr.usage)
                publish({
                  type: 'task.retrying',
                  taskId: runId,
                  attempt: attemptSeq,
                  reason: retryErr.message,
                })
              },
            },
          )
          gate.finish()
          await tee.flush()
          addUsage(result.usage)
          await append({
            type: 'usage',
            promptTokens: result.usage.promptTokens,
            completionTokens: result.usage.completionTokens,
            estimated: result.usage.estimated,
            // A tool-free response IS the composition (§4.1 rule 2), so an "auto" call
            // that came back as prose is a writing call for cost accounting.
            call: result.toolCalls.length > 0 && req.toolChoice !== 'none' ? 'planning' : 'writing',
          })
          return result
        } catch (err) {
          await tee.flush().catch(() => {})
          const failedText =
            err instanceof ModelClientError && err.partialText !== '' ? err.partialText : raw
          // The final attempt's text, not the longest: an abandoned longer attempt must
          // never be offered over what the last attempt actually produced (§6.5).
          if (failedText !== '') partial = failedText
          // A failed/aborted stream still billed its tokens (05 §9 usage honesty).
          if (err instanceof ModelClientError && err.usage !== null) addUsage(err.usage)
          if (
            err instanceof ModelClientError &&
            err.retryable &&
            !signal.aborted &&
            turnCalls < deps.knobs.retry.maxAttempts
          ) {
            // Mid-stream death after user-visible deltas: replay the call; the pending
            // overlay resets (§6.5). Planning tool results replay idempotently (06 §9.3).
            await append({ type: 'attempt', n: attemptSeq + 1, reason: err.code })
            deps.bus.resetTaskStream(runId)
            publish({
              type: 'task.retrying',
              taskId: runId,
              attempt: attemptSeq + 1,
              reason: err.message,
            })
            continue
          }
          throw err
        }
      }
    }

    // ---- the loop (§4.2) ---------------------------------------------------------
    let compositionText: string | null = null
    let result = await chatCall({})

    while (compositionText === null) {
      checkAborted()
      if (result.toolCalls.length === 0) {
        // Prose with no tool calls IS the composition (§4.1 rule 2).
        compositionText = result.text
        messages.push({ role: 'assistant', content: result.text })
        await append({ type: 'message', role: 'assistant', text: result.text })
        break
      }

      // Planning round: any streamed text was preamble, not composition — drop overlay.
      deps.bus.resetTaskStream(runId)
      if (!stagedPlanning) {
        stagedPlanning = true
        publish({ type: 'task.stage', taskId: runId, stage: 'planning' })
      }
      await append({ type: 'stage', stage: 'planning', round })
      if (result.text !== '')
        await append({ type: 'message', role: 'assistant', text: result.text })
      messages.push({ role: 'assistant', content: result.text, toolCalls: result.toolCalls })

      let mustCompose = false
      for (const call of result.toolCalls) {
        let args: unknown = {}
        try {
          args = call.argumentsJson === '' ? {} : JSON.parse(call.argumentsJson)
        } catch {
          // the engine's handlers answer malformed args with a corrective tool result
        }
        const t0 = now().getTime()
        const out = await session.handleToolCall({ id: call.id, name: call.name, args, round })
        await append({
          type: 'toolCall',
          name: call.name,
          input: args,
          output: out.output,
          durationMs: now().getTime() - t0,
        })
        publish({ type: 'task.tool', taskId: runId, name: call.name, label: out.label })
        messages.push({ role: 'tool', content: out.output, toolCallId: call.id })
        await append({ type: 'message', role: 'tool', text: out.output })
        if (out.finishedPlanning || out.planningCapReached) mustCompose = true
      }

      if (mustCompose) {
        const refresh = session.compositionRefreshTurn()
        if (refresh !== null) {
          messages.push({ role: 'user', content: refresh })
          await append({ type: 'message', role: 'user', text: refresh })
        }
        noteWriting()
        const composition = await chatCall({ toolChoice: 'none' })
        compositionText = composition.text
        messages.push({ role: 'assistant', content: composition.text })
        await append({ type: 'message', role: 'assistant', text: composition.text })
        break
      }

      round++
      result = await chatCall({})
    }

    partial = compositionText // the final attempt's text (§6.5)

    // ---- parse + one repair turn (§5.5) ------------------------------------------
    // Ambiguous output (multiple candidate blocks for one spec — including an injected
    // '</snippet>'/'<snippet …>' split smuggled inside prose) parses as repairNeeded:
    // the runner never guesses which block to commit.
    let parsed = parseTaskOutput(compositionText, plan.expectedBlocks)
    if (!parsed.ok) {
      deps.bus.resetTaskStream(runId) // the invalid attempt's overlay must not survive
      // Live clients drop the abandoned attempt's text exactly like reconnecting ones:
      // an empty snapshot resets the client-side buffer before the repair streams.
      publish({ type: 'task.snapshot', taskId: runId, target: plan.deltaTarget, text: '' })
      const cue = renderTemplate(deps.templates, 'repair', {
        blockList: formatBlockList(parsed.missing),
      })
      messages.push({ role: 'user', content: cue })
      await append({ type: 'message', role: 'user', text: cue })
      const repaired = await chatCall({ toolChoice: 'none' })
      compositionText = repaired.text
      partial = compositionText
      messages.push({ role: 'assistant', content: compositionText })
      await append({ type: 'message', role: 'assistant', text: compositionText })
      parsed = parseTaskOutput(compositionText, plan.expectedBlocks)
      if (!parsed.ok) {
        throw new RunFailureError(
          'output_invalid',
          describeParseFailure(parsed.missing, repaired.finishReason),
          false,
        )
      }
    }

    checkAborted()

    // Side effects settle BEFORE the commit: a failing append fails the run while
    // nothing is committed yet — and can never divert a committed run afterwards.
    await Promise.all(sideEffects)
    sideEffects.length = 0

    // ---- commit (§5.3–§5.4), atomic per target -----------------------------------
    const artifacts = await plan.commit({
      handle: deps.handle,
      blocks: parsed.blocks,
      runId,
      orderKey,
    })
    committed = true
    await session.finalize('completed') // citations → ledger, decay, evict, persist (06)

    deps.bus.endTaskStream(runId)
    // Post-commit appends are non-critical: their failure must never turn a committed
    // snippet into task.failed — warn-and-continue only.
    try {
      await append({
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
    publish({
      type: 'task.usage',
      taskId: runId,
      promptTokens: usageTotal.promptTokens,
      completionTokens: usageTotal.completionTokens,
      estimated: usageTotal.estimated,
      costUsd: deriveCostUsd(usageTotal, deps.client.endpoint),
    })
    publish({ type: 'task.completed', taskId: runId })
    return { status: 'ok', error: null, artifacts, partialText: null, usageTotal }
  } catch (err) {
    const cancelled = signal.aborted || err instanceof AbortedError
    session?.abort() // no ledger side effects (06); no-op after finalize
    if (orderKey !== null && !committed) deps.handle.releaseOrderKey(orderKey)
    const failure = cancelled ? null : classifyFailure(err)
    const partialText = cleanPartialText(partial, new Set(plan.expectedBlocks.map((b) => b.tag)))

    await Promise.allSettled(sideEffects)
    deps.bus.endTaskStream(runId)
    if (sink !== null && !sink.closed) {
      await sink
        .append({
          type: 'result',
          status: cancelled ? 'cancelled' : 'error',
          ...(failure === null ? {} : { error: { code: failure.code, message: failure.message } }),
          usageTotal,
          partialText,
          artifacts: [],
          endedAt: now().toISOString(),
        })
        .catch(() => {}) // a read-only/closing handle must not mask the real failure
    }
    publish({
      type: 'task.usage',
      taskId: runId,
      promptTokens: usageTotal.promptTokens,
      completionTokens: usageTotal.completionTokens,
      estimated: usageTotal.estimated,
      costUsd: deriveCostUsd(usageTotal, deps.client.endpoint),
    })
    if (cancelled) {
      publish({ type: 'task.cancelled', taskId: runId, partialText })
      return { status: 'cancelled', error: null, artifacts: [], partialText, usageTotal }
    }
    const error = failure as NonNullable<typeof failure>
    publish({
      type: 'task.failed',
      taskId: runId,
      code: error.code,
      message: error.message,
      // Edit tasks are all-or-nothing: partials live in the run file but are never
      // offered (§6.5). Continue kinds offer keep-partial-as-draft.
      partialText: plan.offersPartial ? partialText : null,
      retryable: error.retryable,
    })
    return { status: 'error', error, artifacts: [], partialText, usageTotal }
  }
}

/** Error → the 05 §11 taxonomy row (exported for the background runner). */
export function classifyFailure(err: unknown): {
  code: ErrorCode
  message: string
  retryable: boolean
} {
  if (err instanceof ModelClientError) {
    return { code: err.code, message: err.message, retryable: err.retryable }
  }
  if (err instanceof RunFailureError) {
    return { code: err.code, message: err.message, retryable: err.retryableFlag }
  }
  if (err instanceof EngineValidationError) {
    return { code: 'validation', message: err.message, retryable: false }
  }
  if (err instanceof SessionBusyError) {
    return { code: 'busy', message: err.message, retryable: true }
  }
  if (err instanceof ReadOnlyError) {
    return { code: 'readonly', message: err.message, retryable: false }
  }
  if (err instanceof StorageError && err.code === 'conflict') {
    return { code: 'conflict', message: err.message, retryable: false }
  }
  const message = err instanceof Error ? err.message : String(err)
  return { code: 'internal', message, retryable: false }
}
