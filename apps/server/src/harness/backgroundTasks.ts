import type {
  BoundaryProposal as BoundaryProposalType,
  ErrorCode,
  HarnessKnobs,
  RunArtifact,
  Task,
  TaskSpec,
  WorkEventOf,
} from '@cowrite/shared'
import { BoundaryProposal } from '@cowrite/shared'
import type { WorkEventBus } from '../events/bus.js'
import type { ChatMessage, ChatResult, OpenAiCompatClient } from '../models/client.js'
import { ModelClientError } from '../models/client.js'
import { deriveCostUsd } from '../models/usage.js'
import {
  describeParseFailure,
  type ExpectedBlockSpec,
  formatBlockList,
  type ParsedBlock,
  parseTaskOutput,
} from '../prompt/outputParser.js'
import {
  renderEntryItem,
  renderSectionItem,
  renderSnippetItem,
  type SectionItem,
} from '../prompt/regions.js'
import { sanitizeAttributeValue } from '../prompt/tags.js'
import { renderTemplate, type TemplateSet } from '../prompt/templates/loader.js'
import { StorageError } from '../storage/errors.js'
import type { SectionRow } from '../storage/index/db.js'
import type { RunSink } from '../storage/runStore.js'
import { SectionNotFoundError } from '../storage/sectionStore.js'
import type { WorkHandle } from '../storage/service.js'
import {
  AbortedError,
  BlockStreamGate,
  classifyFailure,
  OutputTee,
  RunFailureError,
} from './runner.js'

/**
 * The Stage-4 background task handlers (docs/05-agents.md §2, §4.4): `enrich-section`
 * and `propose-boundaries`. Background kinds never open a context-engine session — the
 * ledger, decay, and anchors are untouched by background work. Each handler owns a
 * simple, stateless prompt assembly from storage reads, ONE low-lane model call with no
 * tools, one repair turn (§5.5), and its commit:
 *
 * - `enrich-section` → THREE commits from one run: a section title (unless the user
 *   pinned one — then the `<title>` instruction line is dropped and an emitted block is
 *   unexpected, 07 §6.5), `summary-short.md`, and `summary-long.md`.
 * - `propose-boundaries` → commits nothing; its Zod-validated `BoundaryProposal` is
 *   returned to the consolidation scheduler (scheduler.ts). Invalid JSON fails the run
 *   `output_invalid` and the scheduler defers (02 §6.3).
 *
 * Both record full run files (meta with `contextSnapshot: null` → messages → output →
 * usage → result with artifacts) through the same sink as interactive runs, and publish
 * the same `task.*` SSE family on the background queue lane. Failures are quiet by
 * policy (05 §6.5): no post-delivery replays — staleness persists and the sweep retries.
 */

export type BackgroundKind = 'enrich-section' | 'propose-boundaries'
export type BackgroundSpec = Extract<TaskSpec, { kind: BackgroundKind }>

const BACKGROUND_KINDS: ReadonlySet<TaskSpec['kind']> = new Set([
  'enrich-section',
  'propose-boundaries',
])

export function isBackgroundSpec(spec: TaskSpec): spec is BackgroundSpec {
  return BACKGROUND_KINDS.has(spec.kind)
}

/** The `task.started` target for a background kind (03 §8.2). */
export function backgroundStartTarget(spec: BackgroundSpec): WorkEventOf<'task.started'>['target'] {
  return spec.kind === 'enrich-section'
    ? { kind: 'section', id: spec.sectionId }
    : { kind: 'frontier' }
}

/** Live target ids for the §5.6 consolidation guard / cancel-by-target. */
export function backgroundTargetIds(spec: BackgroundSpec): string[] {
  return spec.kind === 'enrich-section' ? [spec.sectionId] : [...spec.eligibleSnippetIds]
}

/** The 05 §6.1 `(kind, targetId)` dedupe key; null for non-background specs. */
export function backgroundDedupeKey(spec: TaskSpec): string | null {
  if (!isBackgroundSpec(spec)) return null
  // Only one boundary evaluation makes sense at a time — the kind alone is the key.
  return spec.kind === 'enrich-section' ? `enrich-section:${spec.sectionId}` : 'propose-boundaries'
}

/**
 * Three tagged blocks under the low lane's 1,024-token default is truncation bait, and
 * a truncated block triggers the repair turn — doubling the cost the single-run design
 * saves. The ceiling is generous because reasoning models spend hidden reasoning tokens
 * against this budget before the title+summaries are emitted (05 §4.4).
 */
export const ENRICH_MAX_OUTPUT_TOKENS = 16_384

/** §4.4 world-entry cap: ≤ 8 matched entries at name+summary fidelity. */
export const ENRICH_WORLD_ENTRY_CAP = 8

/**
 * v0 chapter-size hints for boundaries.md's {{minWords}}/{{maxWords}} (07 §6.6 leaves
 * them as slots; M1.5 real-model tuning owns the values).
 */
export const BOUNDARY_MIN_WORDS = 1500
export const BOUNDARY_MAX_WORDS = 5000

// ---------------------------------------------------------------------------
// Stateless assembly + per-kind commit plans (05 §4.4)
// ---------------------------------------------------------------------------

export interface AssembledBackground {
  /** The one user message (the templates are full prompts — no system region). */
  prompt: string
  expectedBlocks: ExpectedBlockSpec[]
  /** `task.delta`/`task.snapshot` target string. */
  deltaTarget: string
  /** Per-call raise over the endpoint default (enrich only). */
  maxOutputTokens?: number
  commit(
    blocks: ParsedBlock[],
    runId: string,
  ): Promise<{ artifacts: RunArtifact[]; proposal: BoundaryProposalType | null }>
}

/** Leaf sections (contentHash ≠ null) in document order, as listSections returns them. */
function leafSections(handle: WorkHandle): SectionRow[] {
  return handle.listSections().filter((row) => row.contentHash !== null)
}

function shortSummaryItem(row: SectionRow): SectionItem | null {
  if (row.shortSummary === null) return null
  return {
    id: row.id,
    level: row.kind,
    ...(row.title === null ? {} : { name: row.title }),
    fidelity: 'short',
    content: row.shortSummary.replace(/\n+$/, ''),
  }
}

/** 05 §4.4 `enrich-section`: content + ≤2 preceding sibling shorts + ≤8 world entries. */
export async function assembleEnrich(
  handle: WorkHandle,
  templates: TemplateSet,
  sectionId: string,
): Promise<AssembledBackground> {
  const row = handle.getSection(sectionId)
  if (row === null) throw new SectionNotFoundError(sectionId)
  // The assembly-time hash travels to putSummary as the summaries' sourceHash (02
  // §6.5: the hash of the prose the summary was derived FROM): if the content changes
  // while the run is in flight, the commit still lands but correctly reads stale.
  const { text: content, contentHash } = await handle.getSectionContent(sectionId)

  // Up to two preceding sibling sections' short summaries ("previously on").
  const siblings = leafSections(handle)
    .filter((r) => r.parentId === row.parentId && r.orderKey < row.orderKey)
    .sort((a, b) => (a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : 0))
  const precedingShorts = siblings
    .map(shortSummaryItem)
    .filter((item): item is SectionItem => item !== null)
    .slice(-2)

  // Matched world entries, capped, at name+summary fidelity (05 §4.4: a deliberate,
  // scoped exception to "keys never choose model context" — low-lane chores only).
  const matched = (await handle.matchWorldEntries(content)).slice(0, ENRICH_WORLD_ENTRY_CAP)
  const matchedItems = matched.map((entry) =>
    entry.meta.shortSummary === null
      ? renderEntryItem({ id: entry.meta.id, name: entry.meta.name, fidelity: 'name' })
      : renderEntryItem({
          id: entry.meta.id,
          name: entry.meta.name,
          fidelity: 'short',
          content: entry.meta.shortSummary,
        }),
  )

  const pinned = row.titleSource === 'user'
  let prompt = renderTemplate(templates, 'enrich', {
    matchedEntries: matchedItems.join('\n'),
    precedingSiblingShorts: precedingShorts.map(renderSectionItem).join('\n'),
    sectionId,
    sectionName: sanitizeAttributeValue(row.title ?? ''),
    content: content.replace(/\n+$/, ''),
  })
  if (pinned) {
    // 07 §6.5: a user title is never overwritten — the <title> instruction line is
    // dropped, and an emitted <title> block is unexpected (not in the expected set).
    prompt = prompt
      .split('\n')
      .filter((line) => !line.startsWith('<title> —'))
      .join('\n')
  }

  const expectedBlocks: ExpectedBlockSpec[] = [
    ...(pinned ? [] : [{ tag: 'title' } satisfies ExpectedBlockSpec]),
    { tag: 'summary-short' },
    { tag: 'summary-long' },
  ]

  return {
    prompt,
    expectedBlocks,
    deltaTarget: sectionId,
    maxOutputTokens: ENRICH_MAX_OUTPUT_TOKENS,
    commit: async (blocks, runId) => {
      const artifacts: RunArtifact[] = []
      const title = blocks.find((b) => b.tag === 'title')
      if (!pinned && title !== undefined) {
        // setSectionTitle re-checks the pin server-side (belt and braces): a user title
        // set while the run was in flight reads back `applied: false` → skipped.
        const res = await handle.setSectionTitle(sectionId, singleLine(title.content), {
          source: 'agent',
        })
        artifacts.push({
          kind: 'section-title',
          sectionId,
          state: res.applied ? 'committed' : 'skipped',
        })
      }
      for (const [tag, kind] of [
        ['summary-short', 'short'],
        ['summary-long', 'long'],
      ] as const) {
        const block = blocks.find((b) => b.tag === tag)
        if (block === undefined) continue // optional-miss is impossible; parse enforced
        await handle.putSummary(sectionId, kind, `${block.content.replace(/\n+$/, '')}\n`, {
          source: 'agent',
          runId,
          sourceHash: contentHash,
        })
        artifacts.push({ kind: tag, sectionId, state: 'committed' })
      }
      return { artifacts, proposal: null }
    },
  }
}

/** 05 §4.4 `propose-boundaries`: eligible snippet texts + last two frozen shorts. */
export async function assembleBoundaries(
  handle: WorkHandle,
  templates: TemplateSet,
  eligibleSnippetIds: readonly string[],
): Promise<AssembledBackground> {
  const snippetItems: string[] = []
  for (const id of eligibleSnippetIds) {
    const snippet = await handle.getSnippet(id)
    snippetItems.push(renderSnippetItem({ id, text: snippet.text.replace(/\n+$/, '') }))
  }

  const frozenShorts = leafSections(handle)
    .filter((r) => r.frozenAt !== null)
    .map(shortSummaryItem)
    .filter((item): item is SectionItem => item !== null)
    .slice(-2)

  const prompt = renderTemplate(templates, 'boundaries', {
    minWords: String(BOUNDARY_MIN_WORDS),
    maxWords: String(BOUNDARY_MAX_WORDS),
    lastTwoFrozenShorts: frozenShorts.map(renderSectionItem).join('\n'),
    eligibleSnippets: snippetItems.join('\n'),
  })

  return {
    prompt,
    expectedBlocks: [{ tag: 'boundaries' }],
    // A reasoning model deliberating N snippets can spend heavily before the (small) JSON
    // block; give it the same headroom enrichment gets so the decision isn't truncated.
    maxOutputTokens: ENRICH_MAX_OUTPUT_TOKENS,
    deltaTarget: 'frontier',
    commit: async (blocks) => {
      const block = blocks.find((b) => b.tag === 'boundaries')
      if (block === undefined) {
        throw new RunFailureError('output_invalid', 'no <boundaries> block arrived', false)
      }
      // §2: Zod-invalid boundary output is NOT repaired a second time — the run fails
      // `output_invalid` cleanly and the consolidation scheduler defers (02 §6.3).
      let raw: unknown
      try {
        raw = JSON.parse(block.content)
      } catch {
        throw new RunFailureError(
          'output_invalid',
          'the <boundaries> block did not contain valid JSON',
          false,
        )
      }
      const parsed = BoundaryProposal.safeParse(raw)
      if (!parsed.success) {
        throw new RunFailureError(
          'output_invalid',
          `the <boundaries> JSON did not match BoundaryProposal: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
          false,
        )
      }
      return { artifacts: [{ kind: 'boundary', state: 'committed' }], proposal: parsed.data }
    },
  }
}

function singleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function assembleBackground(
  handle: WorkHandle,
  templates: TemplateSet,
  spec: BackgroundSpec,
): Promise<AssembledBackground> {
  return spec.kind === 'enrich-section'
    ? assembleEnrich(handle, templates, spec.sectionId)
    : assembleBoundaries(handle, templates, spec.eligibleSnippetIds)
}

// ---------------------------------------------------------------------------
// The background runner: one stateless call, no tools, one repair turn
// ---------------------------------------------------------------------------

export interface BackgroundDeps {
  handle: WorkHandle
  bus: WorkEventBus
  client: OpenAiCompatClient
  templates: TemplateSet
  knobs: HarnessKnobs
  now?: () => Date
  /** Non-fatal diagnostics (post-commit append failures); defaults to console.warn. */
  warn?: (message: string) => void
}

export interface BackgroundResult {
  status: 'ok' | 'error' | 'cancelled'
  error: { code: ErrorCode; message: string; retryable: boolean } | null
  artifacts: RunArtifact[]
  /** propose-boundaries only: the parsed, Zod-valid proposal on the ok path. */
  proposal: BoundaryProposalType | null
  usageTotal: { promptTokens: number; completionTokens: number; estimated: boolean }
}

/**
 * What a background submission resolves with once its task reaches a terminal status —
 * the slice of `BackgroundResult` the consolidation scheduler consumes (scheduler.ts).
 * The promise NEVER rejects; queued tasks cancelled by removal resolve `cancelled`.
 */
export interface BackgroundOutcome {
  status: 'ok' | 'error' | 'cancelled'
  errorCode: string | null
  proposal: BoundaryProposalType | null
}

export async function runBackgroundTask(
  task: Task,
  spec: BackgroundSpec,
  deps: BackgroundDeps,
  signal: AbortSignal,
): Promise<BackgroundResult> {
  const runId = task.id
  const now = deps.now ?? (() => new Date())
  const publish = deps.bus.publish.bind(deps.bus)
  const usageTotal = { promptTokens: 0, completionTokens: 0, estimated: false }
  const addUsage = (u: { promptTokens: number; completionTokens: number; estimated: boolean }) => {
    usageTotal.promptTokens += u.promptTokens
    usageTotal.completionTokens += u.completionTokens
    usageTotal.estimated ||= u.estimated
  }
  let sink: RunSink | null = null
  // Un-awaited sink appends, settled BEFORE commit (same rule as the interactive runner).
  const sideEffects: Promise<void>[] = []
  const collect = (p: Promise<void>): void => {
    p.catch(() => {})
    sideEffects.push(p)
  }
  const checkAborted = (): void => {
    if (signal.aborted) throw new AbortedError()
  }

  try {
    checkAborted()
    await deps.handle.reconcile() // pre-run, 02 §reconciler / 03 §4.1 cadence
    const assembled = await assembleBackground(deps.handle, deps.templates, spec)
    sink = await deps.handle.recordRun(runId, task.startedAt ?? now().toISOString())
    const append: RunSink['append'] = (event) => (sink as NonNullable<typeof sink>).append(event)

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
        maxOutputTokens: assembled.maxOutputTokens ?? deps.client.endpoint.maxOutputTokens,
      },
      contextSnapshot: null, // no engine assembly to snapshot (05 §4.4)
      startedAt: task.startedAt ?? now().toISOString(),
    })
    const messages: ChatMessage[] = [{ role: 'user', content: assembled.prompt }]
    await append({ type: 'message', role: 'user', text: assembled.prompt })

    let attemptSeq = 0
    let stagedWriting = false
    const expectedTags = new Set(assembled.expectedBlocks.map((b) => b.tag))

    const chatCall = async (): Promise<ChatResult> => {
      attemptSeq++
      checkAborted()
      const tee = new OutputTee(
        (e) => append(e),
        () => now().getTime(),
        () => attemptSeq,
        collect,
      )
      const gate = new BlockStreamGate(
        expectedTags,
        (text) => deps.bus.publishTaskDelta(runId, assembled.deltaTarget, text),
        () => {
          if (stagedWriting) return
          stagedWriting = true
          collect(append({ type: 'stage', stage: 'writing', round: 0 }))
          publish({ type: 'task.stage', taskId: runId, stage: 'writing' })
        },
      )
      try {
        const result = await deps.client.chat(
          {
            messages,
            ...(assembled.maxOutputTokens === undefined
              ? {}
              : { maxOutputTokens: assembled.maxOutputTokens }),
          },
          {
            signal,
            attemptBudget: deps.knobs.retry.maxAttempts,
            onDelta: (delta) => {
              tee.push(delta)
              gate.push(delta)
            },
            // Pre-delivery retries (429/5xx before any token) are the client's; the run
            // records each attempt. Post-delivery (mid-stream) death is NOT replayed —
            // background failures are quiet and the sweep retries later (05 §6.5).
            onRetry: (retryErr) => {
              attemptSeq++
              collect(append({ type: 'attempt', n: attemptSeq, reason: retryErr.code }))
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
          call: 'writing',
        })
        return result
      } catch (err) {
        await tee.flush().catch(() => {})
        if (err instanceof ModelClientError && err.usage !== null) addUsage(err.usage)
        throw err
      }
    }

    // ---- one call + at most one repair turn (§5.5) -------------------------------
    let result = await chatCall()
    let text = result.text
    await append({ type: 'message', role: 'assistant', text })
    let parsed = parseTaskOutput(text, assembled.expectedBlocks)
    if (!parsed.ok) {
      deps.bus.resetTaskStream(runId)
      publish({ type: 'task.snapshot', taskId: runId, target: assembled.deltaTarget, text: '' })
      const cue = renderTemplate(deps.templates, 'repair', {
        blockList: formatBlockList(parsed.missing),
      })
      messages.push({ role: 'assistant', content: text }, { role: 'user', content: cue })
      await append({ type: 'message', role: 'user', text: cue })
      result = await chatCall()
      text = result.text
      await append({ type: 'message', role: 'assistant', text })
      parsed = parseTaskOutput(text, assembled.expectedBlocks)
      if (!parsed.ok) {
        throw new RunFailureError(
          'output_invalid',
          describeParseFailure(parsed.missing, result.finishReason),
          false,
        )
      }
    }

    checkAborted()
    await Promise.all(sideEffects)
    sideEffects.length = 0

    // ---- commit ------------------------------------------------------------------
    const { artifacts, proposal } = await assembled.commit(parsed.blocks, runId)
    deps.bus.endTaskStream(runId)
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
    if (spec.kind === 'enrich-section') {
      // The harness's explicit completion signal — the engine's anchor refresh listens
      // on this in-process channel alongside storage's summary commits (03 §8.5).
      deps.bus.publishLocal({ type: 'enrichment.completed', sectionId: spec.sectionId })
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
    return { status: 'ok', error: null, artifacts, proposal, usageTotal }
  } catch (err) {
    const cancelled = signal.aborted || err instanceof AbortedError
    const failure = cancelled ? null : classifyBackgroundFailure(err)
    await Promise.allSettled(sideEffects)
    deps.bus.endTaskStream(runId)
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
    publish({
      type: 'task.usage',
      taskId: runId,
      promptTokens: usageTotal.promptTokens,
      completionTokens: usageTotal.completionTokens,
      estimated: usageTotal.estimated,
      costUsd: deriveCostUsd(usageTotal, deps.client.endpoint),
    })
    if (cancelled) {
      publish({ type: 'task.cancelled', taskId: runId, partialText: null })
      return { status: 'cancelled', error: null, artifacts: [], proposal: null, usageTotal }
    }
    const error = failure as NonNullable<typeof failure>
    // Quiet by policy (05 §11): the event carries the taxonomy; the UI shows a
    // staleness badge + activity-log detail, never a toast.
    publish({
      type: 'task.failed',
      taskId: runId,
      code: error.code,
      message: error.message,
      partialText: null,
      retryable: error.retryable,
    })
    return { status: 'error', error, artifacts: [], proposal: null, usageTotal }
  }
}

function classifyBackgroundFailure(err: unknown): {
  code: ErrorCode
  message: string
  retryable: boolean
} {
  // A vanished target (the section was un-frozen by a consolidation undo, or a snippet
  // was consolidated away mid-run) is a quiet terminal miss, not an internal error.
  if (err instanceof StorageError && err.code === 'not_found') {
    return { code: 'not_found', message: err.message, retryable: false }
  }
  return classifyFailure(err)
}
