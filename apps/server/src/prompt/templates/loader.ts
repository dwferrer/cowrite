import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { xxh64OfString } from '../../storage/lib/hash.js'

/**
 * The v0 prompt template set (docs/07-prompting.md §6): Markdown files with `{{slot}}`
 * substitution, loaded from disk so dev edits are picked up by re-loading (hot-reload is the
 * caller's loop; prod loads once). The concatenated set is content-hashed into `promptsHash`,
 * which 05 stamps into every run's `meta.params` — any wording edit is attributable.
 *
 * Wording is transcribed from 07 §6 verbatim and is deliberately v0: the grammar is the
 * contract, the prose is not. Doc file names are kept; the `-task` files split out the `<task>`
 * regions 07 §6.2–§6.3 define alongside their `<instructions>` so each fill is one file.
 */

export const TEMPLATE_NAMES = [
  'system', // §6.1 — per-work system message, byte-identical for every interactive task
  'continue', // §6.2/§4 — <instructions> shared by continue + instructed-continue
  'continue-task', // §6.2 — the byte-constant plain-continue <task> region
  'instructed-continue-task', // §6.2 — <task> with {{instruction}}
  'quick-edit', // §6.3 — <instructions> with {{targetId}}
  'quick-edit-task', // §6.3 — <task> with {{targetId}} {{instruction}} {{selectionText}}
  'enrich', // §6.5 — full background prompt (Stage 4 fills it)
  'boundaries', // §6.6 — full background prompt (Stage 4 fills it)
  'refresh', // §6.7 — the refresh turn with {{refreshTail}}
  'repair', // §6.8 — the one corrective turn with {{blockList}}
] as const
export type TemplateName = (typeof TEMPLATE_NAMES)[number]

/**
 * The templates whose bytes actually drive run prompts — exactly what `promptsHash`
 * covers. `enrich`/`boundaries` joined the set with the Stage-4 background handlers
 * (backgroundTasks.ts): their bytes now reach the low model, so wording edits must be
 * attributable in run meta like every other template.
 */
export const PROMPT_DRIVING_TEMPLATES = [
  'system',
  'continue',
  'continue-task',
  'instructed-continue-task',
  'quick-edit',
  'quick-edit-task',
  'enrich',
  'boundaries',
  'refresh',
  'repair',
] as const satisfies readonly TemplateName[]

/** Which templates each interactive Stage-3 kind fills (05 handlers consume this seam). */
export const INTERACTIVE_TEMPLATES = {
  continue: { instructions: 'continue', task: 'continue-task' },
  'instructed-continue': { instructions: 'continue', task: 'instructed-continue-task' },
  'quick-edit': { instructions: 'quick-edit', task: 'quick-edit-task' },
} as const satisfies Record<string, { instructions: TemplateName; task: TemplateName }>

export interface TemplateSet {
  /** absolute directory the set was loaded from */
  readonly dir: string
  /** `xxh64:<hex>` over the canonicalized template set — recorded in run meta (05 §7.1) */
  readonly promptsHash: string
  readonly templates: ReadonlyMap<TemplateName, string>
}

export class TemplateSlotError extends Error {}

const SLOT_RE = /\{\{([a-zA-Z][a-zA-Z0-9-]*)\}\}/g

/**
 * Fills every `{{slot}}` in `template` from `slots`. Strict both ways: a slot the caller did
 * not provide and a provided value no slot consumes are both errors — silent drift between a
 * template's slots and its call site is exactly what promptsHash exists to catch.
 * Values are inserted verbatim (no re-scanning, no `$`-pattern semantics).
 */
export function fillTemplate(template: string, slots: Record<string, string> = {}): string {
  const unfilled: string[] = []
  const used = new Set<string>()
  const filled = template.replace(SLOT_RE, (whole, name: string) => {
    const value = slots[name]
    if (value === undefined) {
      unfilled.push(name)
      return whole
    }
    used.add(name)
    return value
  })
  if (unfilled.length > 0) {
    throw new TemplateSlotError(`unfilled template slot(s): ${unfilled.join(', ')}`)
  }
  const unknown = Object.keys(slots).filter((name) => !used.has(name))
  if (unknown.length > 0) {
    throw new TemplateSlotError(`unknown template slot(s): ${unknown.join(', ')}`)
  }
  return filled
}

export function renderTemplate(
  set: TemplateSet,
  name: TemplateName,
  slots: Record<string, string> = {},
): string {
  const template = set.templates.get(name)
  if (template === undefined) throw new Error(`template not loaded: ${name}`)
  return fillTemplate(template, slots)
}

/** The checked-in template directory (next to this module). */
export function defaultTemplatesDir(): string {
  return path.dirname(fileURLToPath(import.meta.url))
}

/**
 * Loads the full template set and computes `promptsHash` — xxh64 over a canonical
 * name-ordered serialization, so the hash is a pure function of the set's contents.
 */
export async function loadTemplates(dir = defaultTemplatesDir()): Promise<TemplateSet> {
  const templates = new Map<TemplateName, string>()
  for (const name of TEMPLATE_NAMES) {
    const filePath = path.join(dir, `${name}.md`)
    let raw: string
    try {
      raw = await readFile(filePath, 'utf8')
    } catch (cause) {
      throw new Error(`prompt template missing: ${filePath}`, { cause })
    }
    // Defensive: the repo enforces LF, but a stray CRLF checkout must not change promptsHash
    // or emit \r into prompts.
    templates.set(name, raw.replace(/\r\n/g, '\n'))
  }
  // promptsHash covers exactly the bytes-driving set (PROMPT_DRIVING_TEMPLATES): editing
  // any of those files changes the hash (and thus run attribution); editing a not-yet-wired
  // background template changes nothing a model ever saw, so the hash stays put.
  const canonical = JSON.stringify(
    [...PROMPT_DRIVING_TEMPLATES].sort().map((name) => [name, templates.get(name)]),
  )
  const promptsHash = await xxh64OfString(canonical)
  return { dir, promptsHash, templates }
}
