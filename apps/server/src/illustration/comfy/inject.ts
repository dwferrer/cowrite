/**
 * Marker scan + pure injection (docs/08-illustration.md §2.2).
 *
 * The user marks injection points by renaming nodes in the ComfyUI GUI so a node's
 * title carries a `%marker%` token, then exports "Save (API format)" — the title
 * survives as `_meta.title`. The marker scan IS the injection mapping: it is derived
 * from the file, never hand-written (§2.2, "Why node-title markers").
 *
 * This module is pure and HTTP-free: `deriveInjectionMap` validates a parsed
 * API-format graph and produces the mapping (or a per-workflow validation error the
 * registry records — never thrown), and `inject` returns a deep-cloned graph with the
 * mapped fields set. The template is never mutated.
 */

/** Recognized injection markers (§2.2 table). Unknown `%tokens%` (e.g. `%refimage%`) pass through. */
export const KNOWN_MARKERS = ['prompt', 'seed', 'width', 'height', 'output'] as const
export type Marker = (typeof KNOWN_MARKERS)[number]

/** Built-in output-node class whitelist used when `%output%` is absent (§2.2 output-node rule). */
export const OUTPUT_CLASS_WHITELIST = ['SaveImage', 'PreviewImage'] as const

const MARKER_RE = /%([a-z]+)%/g

/** A single API-format node; only the fields the scan/injection touch are typed. */
interface GraphNode {
  class_type?: unknown
  _meta?: { title?: unknown } | undefined
  inputs?: Record<string, unknown> | undefined
}

/** The injection mapping derived from a graph's markers (frozen into `ResolvedWorkflow`). */
export interface InjectionMap {
  /** The `%prompt%` node — `inputs.text` is overwritten with the composed prompt. */
  promptNodeId: string
  /** Every `%seed%` node — each gets the same fresh seed on `inputs.seed` (else `noise_seed`). */
  seedNodeIds: string[]
  /** `%width%` node — mapped but NOT varied in MVP (the workflow's own value passes through). */
  widthNodeId?: string
  /** `%height%` node — mapped but NOT varied in MVP. */
  heightNodeId?: string
  /** `%output%`, or the unique whitelisted class node — whose images are collected. */
  outputNodeId: string
}

/** Result of `deriveInjectionMap`: the mapping, or a user-facing validation message. */
export type DeriveResult = { ok: true; injections: InjectionMap } | { ok: false; error: string }

/** Minimal shape `inject` needs — `ResolvedWorkflow` satisfies it structurally. */
export interface InjectableWorkflow {
  json: Record<string, unknown>
  injections: InjectionMap
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function nodeTitle(node: GraphNode): string {
  const title = node._meta?.title
  return typeof title === 'string' ? title : ''
}

/** All `%marker%` tokens in a title, de-duplicated (a title may carry several, e.g. `%width% %height%`). */
function markersIn(title: string): Set<string> {
  const found = new Set<string>()
  for (const m of title.matchAll(MARKER_RE)) {
    if (m[1] !== undefined) found.add(m[1])
  }
  return found
}

interface MarkerScan {
  prompt: string[]
  seed: string[]
  width: string[]
  height: string[]
  output: string[]
}

/**
 * Scan every node's `_meta.title` for markers, collecting the node ids that carry each.
 * Iteration is over the raw graph map in insertion order; non-object entries are skipped.
 */
export function scanMarkers(graph: Record<string, unknown>): MarkerScan {
  const scan: MarkerScan = { prompt: [], seed: [], width: [], height: [], output: [] }
  for (const [id, raw] of Object.entries(graph)) {
    if (!isObject(raw)) continue
    for (const marker of markersIn(nodeTitle(raw as GraphNode))) {
      if (marker in scan) scan[marker as Marker].push(id)
    }
  }
  return scan
}

function nodeInputs(
  graph: Record<string, unknown>,
  id: string,
): Record<string, unknown> | undefined {
  const node = graph[id]
  if (!isObject(node)) return undefined
  const inputs = (node as GraphNode).inputs
  return isObject(inputs) ? inputs : undefined
}

/**
 * The seed field a `%seed%` node injects into (§2.2): whichever of `seed` / `noise_seed` holds a
 * plain integer, preferring `seed` when both do. Returns null when neither is a plain integer —
 * e.g. a *linked* input (an array like `['12', 0]`), which validation must reject and inject must
 * never write. Validation and injection call THIS so they always agree on the field; picking the
 * field by `Object.hasOwn` diverges from validation and can silently freeze the seed (§17).
 */
export function chooseSeedField(
  inputs: Record<string, unknown> | undefined,
): 'seed' | 'noise_seed' | null {
  if (inputs === undefined) return null
  if (Number.isInteger(inputs.seed)) return 'seed'
  if (Number.isInteger(inputs.noise_seed)) return 'noise_seed'
  return null
}

function classType(graph: Record<string, unknown>, id: string): string | undefined {
  const node = graph[id]
  if (!isObject(node)) return undefined
  const ct = (node as GraphNode).class_type
  return typeof ct === 'string' ? ct : undefined
}

/**
 * Resolve the output node (§2.2 output-node rule): `%output%` always wins; absent it, the
 * unique node whose `class_type` is whitelisted. Zero or multiple ⇒ a validation error
 * telling the user to add `%output%`.
 */
function resolveOutputNode(graph: Record<string, unknown>, output: string[]): DeriveResult {
  if (output.length > 1) {
    return {
      ok: false,
      error: `Multiple %output% markers found (nodes ${output.join(', ')}) — mark exactly one node with %output%.`,
    }
  }
  const marked = output[0]
  if (marked !== undefined) {
    return { ok: true, injections: { promptNodeId: '', seedNodeIds: [], outputNodeId: marked } }
  }

  const whitelisted = Object.keys(graph).filter((id) => {
    const ct = classType(graph, id)
    return ct !== undefined && (OUTPUT_CLASS_WHITELIST as readonly string[]).includes(ct)
  })
  const only = whitelisted[0]
  if (whitelisted.length === 1 && only !== undefined) {
    return { ok: true, injections: { promptNodeId: '', seedNodeIds: [], outputNodeId: only } }
  }
  const detail =
    whitelisted.length === 0
      ? 'no SaveImage/PreviewImage node found'
      : `multiple output-capable nodes (${whitelisted.join(', ')})`
  return {
    ok: false,
    error: `Cannot resolve the output node — ${detail}. Mark the node whose image to keep with %output%.`,
  }
}

/**
 * Derive the injection mapping from a parsed API-format graph, running the §2.2 validation:
 * exactly one `%prompt%` node with a string `text` input; ≥ 1 `%seed%` node with an integer
 * `seed`/`noise_seed` input; a resolvable output node. Returns the mapping or a user-facing
 * error string — this function NEVER throws (the registry records the error per workflow).
 */
export function deriveInjectionMap(graph: Record<string, unknown>): DeriveResult {
  if (!isObject(graph) || Object.keys(graph).length === 0) {
    return { ok: false, error: 'Not an API-format workflow: expected a JSON object of nodes.' }
  }
  const scan = scanMarkers(graph)

  // %prompt%: exactly one, with a string `text` input.
  if (scan.prompt.length > 1) {
    return {
      ok: false,
      error: `Multiple %prompt% markers found (nodes ${scan.prompt.join(', ')}) — mark exactly one text-encode node with %prompt%.`,
    }
  }
  const promptNodeId = scan.prompt[0]
  if (promptNodeId === undefined) {
    return {
      ok: false,
      error: 'No %prompt% marker found — mark exactly one text-encode node with %prompt%.',
    }
  }
  const promptInputs = nodeInputs(graph, promptNodeId)
  if (promptInputs === undefined || typeof promptInputs.text !== 'string') {
    return {
      ok: false,
      error: `The %prompt% node (id ${promptNodeId}) has no string "text" input — mark a text-encode node with %prompt%.`,
    }
  }

  // %seed%: at least one, each with an integer `seed` or `noise_seed` input.
  if (scan.seed.length === 0) {
    return {
      ok: false,
      error: 'No %seed% marker found — mark at least one sampler node with %seed%.',
    }
  }
  for (const id of scan.seed) {
    // Reject unless the SAME field inject() will write holds a plain integer (§17): a node whose
    // `seed` is a link but whose `noise_seed` is a valid integer is accepted (inject targets
    // noise_seed), but a node with no plain-integer seed field at all is rejected.
    if (chooseSeedField(nodeInputs(graph, id)) === null) {
      return {
        ok: false,
        error: `The %seed% node (id ${id}) has no integer "seed" or "noise_seed" input.`,
      }
    }
  }

  // Output node.
  const output = resolveOutputNode(graph, scan.output)
  if (!output.ok) return output

  const injections: InjectionMap = {
    promptNodeId,
    seedNodeIds: scan.seed,
    outputNodeId: output.injections.outputNodeId,
  }
  const [widthNodeId] = scan.width
  if (widthNodeId !== undefined) injections.widthNodeId = widthNodeId
  const [heightNodeId] = scan.height
  if (heightNodeId !== undefined) injections.heightNodeId = heightNodeId
  return { ok: true, injections }
}

/**
 * Pure injection (§2.2): return a DEEP-CLONED graph with `inputs.text` set on the prompt node
 * and the same `seed` written to every `%seed%` node (`inputs.seed` when present, else
 * `inputs.noise_seed`). The template is never mutated. Width/height markers are mapped but
 * NOT varied in MVP, so nothing is written for them.
 */
export function inject(
  workflow: InjectableWorkflow,
  values: { prompt: string; seed: number },
): Record<string, unknown> {
  const clone = structuredClone(workflow.json) as Record<string, unknown>
  const { promptNodeId, seedNodeIds } = workflow.injections

  const promptInputs = nodeInputs(clone, promptNodeId)
  if (promptInputs !== undefined) promptInputs.text = values.prompt

  for (const id of seedNodeIds) {
    const inputs = nodeInputs(clone, id)
    if (inputs === undefined) continue
    // Write the SAME field validation accepted (§17): the one holding a valid integer, so a
    // node whose real seed lives in `noise_seed` isn't frozen by writing an unused `seed`.
    const field = chooseSeedField(inputs)
    if (field !== null) inputs[field] = values.seed
  }
  return clone
}

/**
 * Runtime output-node backstop (§2.2), documented here for `ComfyClient` (client.ts) to use
 * against a `/history` record: if the chosen output node produced no images but exactly one
 * other node did, collect from it and warn — a user's custom save node then works instead of
 * failing, while the warning points at the missing `%output%` marker. Returns the node id to
 * collect from plus an optional warning, or `null` when no node produced images.
 */
export function resolveOutputImages(
  outputNodeId: string,
  outputs: Record<string, { images?: unknown[] } | undefined>,
): { nodeId: string; warn?: string } | null {
  const chosen = outputs[outputNodeId]
  if (chosen?.images !== undefined && chosen.images.length > 0) return { nodeId: outputNodeId }

  const producers = Object.keys(outputs).filter((id) => {
    const imgs = outputs[id]?.images
    return imgs !== undefined && imgs.length > 0
  })
  const only = producers[0]
  if (producers.length === 1 && only !== undefined) {
    return {
      nodeId: only,
      warn: `output node ${outputNodeId} produced no images; using node ${only} instead — add %output% to its title`,
    }
  }
  return null
}
