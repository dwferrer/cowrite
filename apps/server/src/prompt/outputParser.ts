import { OUTPUT_BLOCK_TAG_NAMES, type OutputBlockTagName, openTagLine } from './tags.js'

/**
 * The writing-stage output contract (docs/07-prompting.md §2.5, §3.2, §7; docs/05-agents.md
 * §5.2): the model's final answer is one or more tag blocks, each the complete replacement
 * text for a harness-designated target. This parser extracts those blocks from a *complete*
 * response text; the Stage-3 runner's streaming extractor wraps the same rules.
 *
 * Rules enforced here (07 §3.2 — "where parsing is real"):
 * - only the task's expected tag set is recognized; anything else tag-shaped is ordinary text;
 * - an opening tag counts only at line start (the whole line); a closing tag counts only when
 *   alone on a line;
 * - a block closes **greedily at the last matching line-anchored close tag** before the next
 *   expected opening tag or end of output — prose containing `</snippet>` mid-line never
 *   terminates a block, and a line-alone stray close is survived unless it is genuinely final;
 * - chatter outside blocks is tolerated and discarded; blocks whose ids match nothing declared
 *   are dropped with a warning; a missing mandatory block is the repair-turn trigger (§6.8).
 */

export interface ExpectedBlockSpec {
  tag: OutputBlockTagName
  /** attributes the block must echo verbatim (e.g. `{ id: 'new' }`, span offsets) */
  attrs?: Record<string, string>
  /** optional blocks never trigger the repair turn (e.g. `<title>` when user-pinned) */
  optional?: boolean
}

export interface ParsedBlock {
  tag: OutputBlockTagName
  attrs: Record<string, string>
  content: string
}

export type OutputWarning =
  /** a block of an expected tag whose attributes match no declared target — dropped (05 §5.2) */
  | { kind: 'unmatched-block'; block: ParsedBlock }
  /** a second block matching an already-satisfied spec — handlers reject per 05 §5.3 */
  | { kind: 'duplicate-block'; block: ParsedBlock }
  /** an expected opening tag with no line-anchored close before the next opening / end */
  | { kind: 'unclosed-block'; tag: OutputBlockTagName; attrs: Record<string, string> }

export interface OutputParseSuccess {
  ok: true
  /** blocks matched to declared specs, in output order */
  blocks: ParsedBlock[]
  warnings: OutputWarning[]
}

/**
 * Failure — the repair-turn trigger signal (05 §5.5): mandatory block(s) absent, OR more
 * than one candidate block matched a single spec (ambiguous output — the harness never
 * guesses which one to commit; `missing` then lists the ambiguous spec(s) to re-produce).
 * The ambiguity rule also closes the prompt-injection block-splitting hazard: injected
 * `</snippet>` + `<snippet …>` lines inside prose yield two candidates → a repair turn,
 * never a silent commit of the injected split.
 */
export interface OutputParseFailure {
  ok: false
  repairNeeded: true
  missing: ExpectedBlockSpec[]
  blocks: ParsedBlock[]
  warnings: OutputWarning[]
}

export type OutputParseResult = OutputParseSuccess | OutputParseFailure

const OUTPUT_TAG_SET: ReadonlySet<string> = new Set(OUTPUT_BLOCK_TAG_NAMES)

// Whole-line opening tag: `<tag>` or `<tag attr="v" …>`; tolerant of extra whitespace.
const OPEN_LINE_RE = /^<([a-z][a-z0-9-]*)((?:\s+[a-zA-Z-][\w-]*="[^"]*")*)\s*>\s*$/
const ATTR_RE = /([a-zA-Z-][\w-]*)="([^"]*)"/g

export interface Opening {
  tag: OutputBlockTagName
  attrs: Record<string, string>
}

/** Whole-line opening-tag match against the task's expected tag set (exported for the
 *  Stage-3 runner's streaming delta gate, which wraps the same line rules). */
export function parseOpeningLine(line: string, expectedTags: ReadonlySet<string>): Opening | null {
  const match = OPEN_LINE_RE.exec(line)
  if (match === null) return null
  const tag = match[1] ?? ''
  const attrText = match[2] ?? ''
  if (!OUTPUT_TAG_SET.has(tag) || !expectedTags.has(tag)) return null
  const attrs: Record<string, string> = {}
  for (const attr of attrText.matchAll(ATTR_RE)) {
    attrs[attr[1] ?? ''] = attr[2] ?? ''
  }
  return { tag: tag as OutputBlockTagName, attrs }
}

/** Whole-line closing-tag match (exported for the streaming delta gate). */
export function isCloseLine(line: string, tag: string): boolean {
  return new RegExp(`^</${tag}>\\s*$`).test(line)
}

function attrsSatisfy(spec: ExpectedBlockSpec, block: ParsedBlock): boolean {
  if (spec.tag !== block.tag) return false
  for (const [name, value] of Object.entries(spec.attrs ?? {})) {
    if (block.attrs[name] !== value) return false
  }
  return true
}

/** Renders a spec as its opening tag, e.g. for repair.md's `{{blockList}}` (05 §5.5). */
export function formatBlockList(specs: readonly ExpectedBlockSpec[]): string {
  return specs.map((spec) => openTagLine(spec.tag, Object.entries(spec.attrs ?? {}))).join(', ')
}

/**
 * Parses a complete model response against the task's declared block set. Leading, trailing,
 * and between-block chatter is discarded. CRLF is normalized to LF once on entry.
 */
export function parseTaskOutput(
  raw: string,
  expected: readonly ExpectedBlockSpec[],
): OutputParseResult {
  const expectedTags = new Set(expected.map((spec) => spec.tag))
  const lines = raw.replace(/\r\n/g, '\n').split('\n')

  // Pass 1: extract raw blocks (greedy last-close, line-anchored — §3.2).
  const parsed: ParsedBlock[] = []
  const warnings: OutputWarning[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] as string
    const opening = parseOpeningLine(line, expectedTags)
    if (opening === null) {
      i += 1
      continue
    }
    // The block's scan window ends at the next expected opening tag or end of output.
    let windowEnd = lines.length
    for (let j = i + 1; j < lines.length; j++) {
      if (parseOpeningLine(lines[j] as string, expectedTags) !== null) {
        windowEnd = j
        break
      }
    }
    // Greedy: the LAST line-anchored close inside the window wins.
    let closeAt = -1
    for (let j = windowEnd - 1; j > i; j--) {
      if (isCloseLine(lines[j] as string, opening.tag)) {
        closeAt = j
        break
      }
    }
    if (closeAt === -1) {
      warnings.push({ kind: 'unclosed-block', tag: opening.tag, attrs: opening.attrs })
      i = windowEnd
      continue
    }
    parsed.push({
      tag: opening.tag,
      attrs: opening.attrs,
      content: lines.slice(i + 1, closeAt).join('\n'),
    })
    i = closeAt + 1
  }

  // Pass 2: match blocks against declared specs; ids echoed verbatim or dropped.
  const satisfied = new Array<boolean>(expected.length).fill(false)
  const ambiguous = new Array<boolean>(expected.length).fill(false)
  const blocks: ParsedBlock[] = []
  for (const block of parsed) {
    const openIndex = expected.findIndex(
      (spec, index) => !satisfied[index] && attrsSatisfy(spec, block),
    )
    if (openIndex !== -1) {
      satisfied[openIndex] = true
      blocks.push(block)
      continue
    }
    const duplicateIndex = expected.findIndex(
      (spec, index) => satisfied[index] === true && attrsSatisfy(spec, block),
    )
    if (duplicateIndex !== -1) {
      // A SECOND candidate for an already-satisfied spec: the output is ambiguous.
      // Never guess (first-block-wins would commit an attacker-chosen or stale split) —
      // mark the spec for the repair turn instead (05 §5.5).
      ambiguous[duplicateIndex] = true
      warnings.push({ kind: 'duplicate-block', block })
      continue
    }
    warnings.push({ kind: 'unmatched-block', block })
  }

  const missing = expected.filter(
    (spec, index) => (!satisfied[index] || ambiguous[index] === true) && spec.optional !== true,
  )
  if (missing.length > 0) return { ok: false, repairNeeded: true, missing, blocks, warnings }
  return { ok: true, blocks, warnings }
}
