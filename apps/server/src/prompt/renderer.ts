import type { TaskSpec } from '@cowrite/shared'
import type { PromptRenderer, RegionContent, TaskRegionContent } from '../context/renderTypes.js'
import { closeTagLine, openTagLine, tagBlock } from './tags.js'
import {
  INTERACTIVE_TEMPLATES,
  renderTemplate,
  type TemplateName,
  type TemplateSet,
} from './templates/loader.js'

/**
 * The template-backed PromptRenderer (docs/07-prompting.md §6): the prompt/templates/*.md
 * files are the ONE wording source for every interactive prompt. The engine hands region
 * CONTENT (renderTypes.ts seam); this module fills the per-kind templates, splits their
 * self-carried region tags into (attrs, body) for the engine's region accounting, wraps
 * regions with the canonical tag grammar (tags.ts — attribute values sanitized), and
 * renders the refresh turn. `TemplateSet.promptsHash` therefore covers exactly the bytes
 * that reach the model — editing a template file changes both the rendered prompt and the
 * stamped hash.
 */

/** A template that carries its own region tags, split for the engine's region seam. */
export interface SplitRegion {
  name: string
  attrs: Record<string, string>
  body: string
}

const REGION_MARKUP_RE =
  /^<([a-z][a-z0-9-]*)((?:\s+[a-zA-Z_-][\w-]*="[^"]*")*)\s*>\n([\s\S]*)\n<\/\1>\s*$/
const ATTR_RE = /([a-zA-Z_-][\w-]*)="([^"]*)"/g

/** Parse `<name attr="v">\nbody\n</name>` template markup into its parts. */
export function splitRegionMarkup(markup: string): SplitRegion {
  const match = REGION_MARKUP_RE.exec(markup.trim())
  if (match === null) {
    throw new Error(
      `prompt template does not render a single tagged region: ${markup.slice(0, 80)}…`,
    )
  }
  const attrs: Record<string, string> = {}
  for (const attr of (match[2] ?? '').matchAll(ATTR_RE)) {
    attrs[attr[1] ?? ''] = attr[2] ?? ''
  }
  return { name: match[1] ?? '', attrs, body: match[3] ?? '' }
}

/** Strip framing newlines: template files end with `\n`, message content must not. */
function frame(text: string): string {
  return text.replace(/^\n+/, '').replace(/\n+$/, '')
}

function instructionSlots(spec: TaskSpec): { name: TemplateName; slots: Record<string, string> } {
  switch (spec.kind) {
    case 'continue':
    case 'instructed-continue':
      return { name: INTERACTIVE_TEMPLATES[spec.kind].instructions, slots: {} }
    case 'quick-edit': {
      if (spec.target.type !== 'snippet') {
        throw new Error('quick-edit section-span targets are M2; only snippet targets in M1')
      }
      return {
        name: INTERACTIVE_TEMPLATES['quick-edit'].instructions,
        slots: { targetId: spec.target.snippetId },
      }
    }
    case 'edit-task': {
      // M2 refines; the quick-edit wording is the safe superset for now (05 §2).
      const first = spec.targets[0]
      const targetId = first?.type === 'snippet' ? first.snippetId : '…the target id…'
      return { name: 'quick-edit', slots: { targetId } }
    }
    default:
      throw new Error(`background kind '${spec.kind}' has no engine-session instructions`)
  }
}

/** Build the renderer over a loaded template set (loader.ts owns hashing + hot-reload). */
export function templateRenderer(set: TemplateSet): PromptRenderer {
  const region = (name: TemplateName, slots: Record<string, string>): SplitRegion =>
    splitRegionMarkup(renderTemplate(set, name, slots))

  return {
    systemPrompt: () => frame(renderTemplate(set, 'system')),

    instructionsBody: (spec) => {
      const { name, slots } = instructionSlots(spec)
      const split = region(name, slots)
      if (split.name !== 'instructions') {
        throw new Error(`template '${name}' must render an <instructions> region`)
      }
      return split.body
    },

    taskRegion: (spec): TaskRegionContent => {
      switch (spec.kind) {
        case 'continue':
          return toTaskRegion(region('continue-task', {}))
        case 'instructed-continue':
          return toTaskRegion(region('instructed-continue-task', { instruction: spec.instruction }))
        case 'quick-edit': {
          if (spec.target.type !== 'snippet') {
            throw new Error('quick-edit section-span targets are M2; only snippet targets in M1')
          }
          return toTaskRegion(
            region('quick-edit-task', {
              targetId: spec.target.snippetId,
              instruction: spec.instruction,
              selectionText: spec.selection.text,
            }),
          )
        }
        case 'edit-task':
          // M2: multi-target editing; the seam exists, the wording ships with the edit pane.
          return {
            attrs: { kind: 'edit-task' },
            body: tagBlock('user-instructions', [], spec.instruction),
          }
        default:
          throw new Error(`background task kind '${spec.kind}' never opens an engine session`)
      }
    },

    // Region wrapping goes through tags.ts (ONE grammar: sanitized attrs, line-anchored
    // tags), one blank line between regions (07 §1.1).
    composeUserMessage: (regions: RegionContent[]) =>
      regions
        .map(
          (r) =>
            `${openTagLine(r.name, Object.entries(r.attrs ?? {}))}\n${r.body}\n${closeTagLine(r.name)}`,
        )
        .join('\n\n'),

    refreshTurn: (tail) => frame(renderTemplate(set, 'refresh', { refreshTail: tail })),
  }
}

function toTaskRegion(split: SplitRegion): TaskRegionContent {
  if (split.name !== 'task') {
    throw new Error(`task template must render a <task> region, got <${split.name}>`)
  }
  return { attrs: split.attrs, body: split.body }
}
