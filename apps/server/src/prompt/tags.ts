/**
 * Canonical tag vocabulary and formatting rules (docs/07-prompting.md §1–§3).
 *
 * The format is deliberately NOT XML: a closed, line-oriented vocabulary of tags blended with
 * Markdown. Structural tags start at column 0 on their own line; content between tags passes
 * through byte-for-byte — **never escaped, never transformed** (§1 rule 3, §3.2). Safety comes
 * from the closed vocabulary plus attribute sanitization (§1 rule 4): prose never appears in
 * attributes, and attribute *display* values get `"` → `'`, newlines → single space, and a
 * 120-char truncation before quoting. The underlying stored data is untouched.
 */

// ---------------------------------------------------------------------------
// Vocabulary (§2 — exhaustive; the renderer emits nothing else, the output
// parser recognizes nothing else, anything tag-shaped outside it is plain text)
// ---------------------------------------------------------------------------

/** Region tags — top level of a user message (§2.1). */
export const REGION_TAG_NAMES = [
  'instructions',
  'world-info',
  'global-context',
  'voice-anchors',
  'expanded-context',
  'situation',
  'task',
  'local-context',
  'target',
  'local-context-refresh',
  'established-imagery',
  'guidance',
] as const
export type RegionTagName = (typeof REGION_TAG_NAMES)[number]

/**
 * Canonical region-name strings (§2.1) — the tag names without brackets, used verbatim in
 * `ContextSnapshot.regions`, `usage.jsonl` per-region counts, and the provenance viewer.
 */
export const CANONICAL_REGION_NAMES = [
  'instructions',
  'world-info',
  'global-context',
  'voice-anchors',
  'expanded-context',
  'situation',
  'task',
  'local-context',
  'target',
] as const
export type CanonicalRegionName = (typeof CANONICAL_REGION_NAMES)[number]

/** Item tags — one level inside a region (§2.2). */
export const ITEM_TAG_NAMES = ['section', 'entry', 'excerpt', 'snippet', 'imagery'] as const
export type ItemTagName = (typeof ITEM_TAG_NAMES)[number]

/** `<task>` internals — user-supplied material is always wrapped (§2.3). */
export const TASK_INTERNAL_TAG_NAMES = [
  'user-instructions',
  'selection-excerpt',
  'edit-target',
] as const
export type TaskInternalTagName = (typeof TASK_INTERNAL_TAG_NAMES)[number]

/** Marker tags — inside `<local-context>` / `<target>` only (§2.4). */
export const MARKER_TAG_NAMES = ['selection', 'p', 'before', 'span', 'after'] as const
export type MarkerTagName = (typeof MARKER_TAG_NAMES)[number]

/** Output-block tags — model → harness (§2.5); 05 owns which blocks each kind expects. */
export const OUTPUT_BLOCK_TAG_NAMES = [
  'snippet',
  'span',
  'title',
  'summary-short',
  'summary-long',
  'boundaries',
  'image-prompt',
] as const
export type OutputBlockTagName = (typeof OUTPUT_BLOCK_TAG_NAMES)[number]

// ---------------------------------------------------------------------------
// Attribute sanitization (§1 rule 4)
// ---------------------------------------------------------------------------

export const ATTRIBUTE_VALUE_MAX_CHARS = 120

/**
 * Display transform for attribute values: `"` → `'`, each newline → a single space, truncated
 * to 120 chars (by code point). Ids, numbers, and fidelity levels pass through unchanged —
 * the transform is only observable on human-readable names.
 */
export function sanitizeAttributeValue(value: string): string {
  const flat = value.replace(/\r\n|[\r\n]/g, ' ').replace(/"/g, "'")
  const points = Array.from(flat)
  return points.length > ATTRIBUTE_VALUE_MAX_CHARS
    ? points.slice(0, ATTRIBUTE_VALUE_MAX_CHARS).join('')
    : flat
}

/** Ordered attribute list — emission order is the caller's order, for byte-determinism. */
export type TagAttrs = ReadonlyArray<readonly [name: string, value: string]>

function formatAttrs(attrs: TagAttrs): string {
  let out = ''
  for (const [name, value] of attrs) out += ` ${name}="${sanitizeAttributeValue(value)}"`
  return out
}

// ---------------------------------------------------------------------------
// Line-anchored emission (§1 rules 1–2): a structural tag is a whole line at
// column 0. These helpers return single lines / blocks without trailing newline.
// ---------------------------------------------------------------------------

export function openTagLine(name: string, attrs: TagAttrs = []): string {
  return `<${name}${formatAttrs(attrs)}>`
}

export function closeTagLine(name: string): string {
  return `</${name}>`
}

export function selfClosingTagLine(name: string, attrs: TagAttrs = []): string {
  return `<${name}${formatAttrs(attrs)}/>`
}

/**
 * A block: opening tag line, content verbatim, closing tag line. Content bytes are never
 * altered; only the framing newlines are added (a single trailing newline on the content is
 * absorbed rather than doubled, so callers may pass content with or without one).
 */
export function tagBlock(name: string, attrs: TagAttrs, content: string): string {
  const body = content.endsWith('\n') ? content.slice(0, -1) : content
  return `${openTagLine(name, attrs)}\n${body}\n${closeTagLine(name)}`
}
