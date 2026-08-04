import type { BudgetKnobs, Fidelity, ItemRef } from '@cowrite/shared'
import { ContextExpandArgs, ContextSearchArgs, FinishPlanningArgs } from '@cowrite/shared'
import { renderSectionSnapshotItem, renderWorldSnapshotItem } from './assemble.js'
import { fidelityRank } from './decay.js'
import type { SyncHasher, TokenEstimator } from './estimate.js'
import type { ToolDef } from './renderTypes.js'
import { renderSearchResults, searchSnapshot } from './search.js'
import type { SnapshotSection, WorkSnapshot } from './snapshot.js'

/**
 * Planning-stage tools (docs/06-context-engine.md §6): local, synchronous, read-only,
 * idempotent. Definitions are byte-identical on every request of a run (05 §4.1); the
 * handlers here are pure over the session's frozen snapshot — session.ts owns the
 * stateful wrapper (caps, replay cache, open recording).
 */

export const UNENRICHED_FULL_TOKEN_CAP = 1500

/** The run-stable `tools` array (OpenAI function-tool JSON schemas, hand-pinned bytes). */
export function toolDefs(): ToolDef[] {
  return [
    {
      type: 'function',
      function: {
        name: 'context_expand',
        description:
          'Open a section or world entry at more detail. Levels: short (summary), long ' +
          '(detailed summary; sections only), full (the complete text). Omit level to go ' +
          'one step above what you currently see.',
        parameters: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['section', 'world'] },
            id: { type: 'string', description: 'the item id shown in its tag' },
            level: { type: 'string', enum: ['short', 'long', 'full'] },
          },
          required: ['kind', 'id'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'context_search',
        description:
          'Find an exact phrase across the manuscript, recent snippets, and world notes. ' +
          'Case-insensitive literal search; returns up to 20 matches with context.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', minLength: 1 },
            wholeWord: { type: 'boolean' },
            scope: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['section'] },
                id: { type: 'string' },
              },
              required: ['kind', 'id'],
              additionalProperties: false,
            },
          },
          required: ['query'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'finish_planning',
        description:
          'End planning and begin writing. Cite the items you opened or relied on so they ' +
          'stay available for the next few tasks.',
        parameters: {
          type: 'object',
          properties: {
            cite: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  kind: { type: 'string', enum: ['section', 'snippet', 'world'] },
                  id: { type: 'string' },
                },
                required: ['kind', 'id'],
                additionalProperties: false,
              },
            },
            notes: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
    },
  ]
}

export function formatTokens(n: number): string {
  return n.toLocaleString('en-US')
}

/** The budget feedback line every context_expand result ends with (06 §6). */
export function budgetStatusLine(assembledTokens: number, knobs: BudgetKnobs): string {
  const suffix =
    assembledTokens > knobs.softBudget
      ? 'over budget — older items will be evicted'
      : 'opening more will evict older items'
  return `-- context: ${formatTokens(assembledTokens)} / ${formatTokens(knobs.softBudget)} soft budget; ${suffix} --`
}

// ---------------------------------------------------------------------------
// context_expand
// ---------------------------------------------------------------------------

export interface ExpandOutcome {
  output: string
  label: string
  /** The elevation to record, when the expand actually served content. */
  opened: {
    kind: 'section' | 'world'
    id: string
    fidelity: Fidelity
    tokens: number
    sourceHash: string
  } | null
  /** The section to nudge the enrichment scheduler about (06 §6 un-enriched case). */
  enrichmentWanted: string | null
  item: ItemRef | null
  resultTokens: number
}

export interface ExpandContext {
  snapshot: WorkSnapshot
  knobs: BudgetKnobs
  est: TokenEstimator
  hasher: SyncHasher
  /** Running assembled-token estimate incl. transcript growth (session-owned). */
  assembledTokens: number
  /** The item's current fidelity (session overlay > ledger > default map). */
  currentFidelity: (kind: 'section' | 'world', id: string) => Fidelity
}

function nextLevel(kind: 'section' | 'world', current: Fidelity): Fidelity {
  if (kind === 'world') return current === 'name' ? 'short' : 'full' // no `long` for entries
  const rank = fidelityRank(current)
  return rank >= 3 ? 'full' : ((['name', 'short', 'long', 'full'] as const)[rank + 1] as Fidelity)
}

/** A polite unknown-id error listing the nearest valid items — never an exception (§6). */
function unknownIdError(kind: 'section' | 'world', id: string, snapshot: WorkSnapshot): string {
  const names =
    kind === 'section'
      ? snapshot.sections.slice(0, 8).map((s) => `- ${s.id} — ${s.name}`)
      : snapshot.worldEntries.slice(0, 8).map((e) => `- ${e.id} — ${e.name}`)
  const listing = names.length === 0 ? '(none exist yet)' : names.join('\n')
  return `No ${kind} with id '${id}'. Valid ${kind}s include:\n${listing}`
}

function childIndex(section: SnapshotSection, ctx: ExpandContext): string {
  const children = ctx.snapshot.sections.filter((s) => s.parentId === section.id)
  if (children.length === 0) return ''
  const lines = children.map((c) => {
    const tokens =
      c.content !== null
        ? ctx.est.count(c.content, c.contentHash ?? undefined)
        : ctx.est.count(c.shortSummary ?? '')
    return `- ${c.id} — ${c.name} (${formatTokens(tokens)} tok)`
  })
  return `\nChildren:\n${lines.join('\n')}`
}

export function handleExpand(rawArgs: unknown, ctx: ExpandContext): ExpandOutcome {
  const parsed = ContextExpandArgs.safeParse(rawArgs)
  if (!parsed.success) {
    return errorOutcome(
      `context_expand arguments were invalid: ${parsed.error.issues[0]?.message ?? 'malformed'}. ` +
        `Expected { kind: "section"|"world", id, level?: "short"|"long"|"full" }.`,
      ctx,
    )
  }
  const args = parsed.data
  if (args.kind === 'world') return expandWorld(args.id, args.level ?? null, ctx)
  return expandSection(args.id, args.level ?? null, ctx)
}

function errorOutcome(message: string, ctx: ExpandContext): ExpandOutcome {
  return {
    output: message,
    label: 'context_expand failed',
    opened: null,
    enrichmentWanted: null,
    item: null,
    resultTokens: ctx.est.count(message),
  }
}

function refusalOutcome(
  name: string,
  fullTokens: number,
  alternatives: string,
  ctx: ExpandContext,
): ExpandOutcome {
  const message =
    `Too large to open in full (${formatTokens(fullTokens)} tokens). ${alternatives}` +
    `\n${budgetStatusLine(ctx.assembledTokens, ctx.knobs)}`
  return {
    output: message,
    label: `refused to open ${name} (too large)`,
    opened: null,
    enrichmentWanted: null,
    item: null,
    resultTokens: ctx.est.count(message),
  }
}

function finishOutcome(
  kind: 'section' | 'world',
  id: string,
  name: string,
  fidelity: Fidelity,
  body: string,
  sourceText: string,
  extra: { enrichmentWanted?: string | null },
  ctx: ExpandContext,
): ExpandOutcome {
  const sourceTokens = ctx.est.count(sourceText)
  let rendered = body
  // Result cap (06 §6): larger content is truncated with a note naming what was cut.
  const cap = ctx.knobs.maxToolResultTokens
  if (ctx.est.count(rendered) > cap) {
    const head = ctx.est.headByTokens(rendered, Math.max(1, cap - 60))
    rendered =
      `${head}\n…\n[truncated at ${formatTokens(cap)} tokens of ${formatTokens(ctx.est.count(body))}; ` +
      `narrow with context_search or request a lower level]`
  }
  const output = `${rendered}\n${budgetStatusLine(ctx.assembledTokens + sourceTokens, ctx.knobs)}`
  return {
    output,
    label: `opened ${name} — ${fidelity}, ${formatTokens(sourceTokens)} tok`,
    opened: {
      kind,
      id,
      fidelity,
      tokens: sourceTokens,
      sourceHash: ctx.hasher.hash(sourceText),
    },
    enrichmentWanted: extra.enrichmentWanted ?? null,
    item: { kind, id },
    resultTokens: ctx.est.count(output),
  }
}

function expandSection(id: string, level: Fidelity | null, ctx: ExpandContext): ExpandOutcome {
  const section = ctx.snapshot.sectionById.get(id)
  if (section === undefined) return errorOutcome(unknownIdError('section', id, ctx.snapshot), ctx)

  const current = ctx.currentFidelity('section', id)
  let wanted: Fidelity = level ?? nextLevel('section', current)

  // Interior sections have no prose of their own: `full` means long + the child index.
  const interior = !section.leaf
  if (interior && wanted === 'full') wanted = 'long'

  // Un-enriched section requested at short/long (no summary exists yet): serve the full
  // text ≤ 1,500 tokens (else head + note) and nudge the enrichment scheduler (§6).
  if (
    section.leaf &&
    (wanted === 'short' || wanted === 'long') &&
    (wanted === 'short' ? section.shortSummary : (section.longSummary ?? section.shortSummary)) ===
      null
  ) {
    const content = section.content ?? ''
    const contentTokens = ctx.est.count(content, section.contentHash ?? undefined)
    let body = content
    let note = ''
    if (contentTokens > UNENRICHED_FULL_TOKEN_CAP) {
      body = ctx.est.headByTokens(content, UNENRICHED_FULL_TOKEN_CAP)
      note = `\n[no summary exists yet; showing the first ${formatTokens(UNENRICHED_FULL_TOKEN_CAP)} tokens of ${formatTokens(contentTokens)}]`
    } else {
      note = '\n[no summary exists yet; showing the full text]'
    }
    const block = renderSectionSnapshotItem({ ...section, content: body }, 'full', { path: true })
    return finishOutcome(
      'section',
      id,
      section.name,
      'full',
      block + note,
      body,
      {
        enrichmentWanted: id,
      },
      ctx,
    )
  }

  // The refusal line: an expansion may not push the assembly past 0.9 × hardCap (§6).
  const sourceText =
    wanted === 'full'
      ? (section.content ?? '')
      : wanted === 'long'
        ? (section.longSummary ?? section.shortSummary ?? '')
        : wanted === 'short'
          ? (section.shortSummary ?? '')
          : section.name
  const sourceTokens = ctx.est.count(sourceText)
  if (ctx.assembledTokens + sourceTokens > 0.9 * ctx.knobs.hardCap) {
    const longTokens = section.longSummary === null ? null : ctx.est.count(section.longSummary)
    const alternatives =
      longTokens !== null && wanted === 'full'
        ? `Try level:'long' (${formatTokens(longTokens)} tokens), one of the children listed, or narrow with context_search.`
        : 'Try a lower level, one of the children listed, or narrow with context_search.'
    return refusalOutcome(section.name, sourceTokens, alternatives, ctx)
  }

  let block = renderSectionSnapshotItem(section, wanted, { path: true })
  if (interior) block += childIndex(section, ctx)
  return finishOutcome('section', id, section.name, wanted, block, sourceText, {}, ctx)
}

function expandWorld(id: string, level: Fidelity | null, ctx: ExpandContext): ExpandOutcome {
  const entry = ctx.snapshot.worldById.get(id)
  if (entry === undefined) return errorOutcome(unknownIdError('world', id, ctx.snapshot), ctx)

  const current = ctx.currentFidelity('world', id)
  let wanted: Fidelity = level ?? nextLevel('world', current)
  if (wanted === 'long') wanted = 'full' // `long` is not defined for entries (06 §2.1)

  const sourceText = wanted === 'full' ? entry.body : (entry.shortSummary ?? '')
  const sourceTokens = ctx.est.count(sourceText)
  if (ctx.assembledTokens + sourceTokens > 0.9 * ctx.knobs.hardCap) {
    return refusalOutcome(
      entry.name,
      sourceTokens,
      "Try level:'short' or narrow with context_search.",
      ctx,
    )
  }
  const fidelity: 'short' | 'full' = wanted === 'full' ? 'full' : 'short'
  const block = renderWorldSnapshotItem(entry, fidelity)
  return finishOutcome('world', id, entry.name, fidelity, block, sourceText, {}, ctx)
}

// ---------------------------------------------------------------------------
// context_search / finish_planning
// ---------------------------------------------------------------------------

export interface SearchOutcome {
  output: string
  label: string
  resultTokens: number
}

export function handleSearch(
  rawArgs: unknown,
  snapshot: WorkSnapshot,
  est: TokenEstimator,
  maxResultTokens: number,
): SearchOutcome {
  const parsed = ContextSearchArgs.safeParse(rawArgs)
  if (!parsed.success) {
    const output = 'context_search arguments were invalid. Expected { query, wholeWord?, scope? }.'
    return { output, label: 'context_search failed', resultTokens: est.count(output) }
  }
  const matches = searchSnapshot(snapshot, parsed.data)
  let output = renderSearchResults(parsed.data.query, matches)
  if (est.count(output) > maxResultTokens) {
    output = `${est.headByTokens(output, Math.max(1, maxResultTokens - 30))}\n…\n[truncated; narrow the query]`
  }
  return {
    output,
    label: `searched "${parsed.data.query}" — ${matches.length} match${matches.length === 1 ? '' : 'es'}`,
    resultTokens: est.count(output),
  }
}

export interface FinishOutcome {
  output: string
  label: string
  /** null ⇒ the model gave no cite list (load-bearing for §7.1 rule 4). */
  citations: ItemRef[] | null
  resultTokens: number
}

export function handleFinishPlanning(rawArgs: unknown): FinishOutcome {
  const parsed = FinishPlanningArgs.safeParse(rawArgs ?? {})
  const cite = parsed.success ? (parsed.data.cite ?? null) : null
  const output = 'Planning complete. Begin writing now.'
  return {
    output,
    label:
      cite === null || cite.length === 0
        ? 'finished planning'
        : `finished planning — cited ${cite.length} item${cite.length === 1 ? '' : 's'}`,
    citations: cite,
    resultTokens: 8,
  }
}
