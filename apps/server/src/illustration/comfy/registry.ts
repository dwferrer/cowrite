import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ComfyConfig } from '@cowrite/shared'
import { xxh64OfString } from '../../storage/lib/hash.js'
import { deriveInjectionMap, type InjectionMap } from './inject.js'

/**
 * Workflow registry (docs/08-illustration.md §3). Named workflows live in the `comfyui` block
 * of app config; their JSON files live in `workflowsDir` (default `<configDir>/workflows`).
 *
 * The load NEVER throws: a broken or dangling workflow is recorded per-entry and surfaced as a
 * task-time `config_missing` when routed to (§3, "Registry errors are per-workflow and
 * task-time"), never as a failed boot. `loadWorkflowRegistry` returns a report structure plus a
 * `resolve(routeKind)` lookup.
 */

/** A validated, frozen workflow template + its derived injection mapping (§3). */
export interface ResolvedWorkflow {
  /** Registry key, e.g. "default". */
  name: string
  label: string
  /** Parsed API-format graph — the frozen (deep-frozen) template; `inject` deep-clones it. */
  json: Record<string, unknown>
  /** Derived from the markers, never hand-written (§2.2). */
  injections: InjectionMap
  /** Entry `execTimeoutMs` override, else the `timeouts.execTimeoutMs` default (§2.4/§3). */
  execTimeoutMs: number
  /** xxh64 over the canonical graph JSON — for run metadata / change detection. */
  contentHash: string
}

/** Per-workflow validation record (surfaced via GET /api/illustration/health, §8). */
export interface WorkflowRecord {
  name: string
  label: string
  ok: boolean
  error?: string
}

/** Per-route validation record: whether `route.*` names an existing, valid workflow. */
export interface RouteRecord {
  name: string
  ok: boolean
}

/** The health/validation report (§8 `IllustrationHealthRes.workflows` + `.route`). */
export interface RegistryReport {
  workflows: WorkflowRecord[]
  route: { section: RouteRecord; world: RouteRecord }
}

/** A resolve miss: the routed workflow is broken or dangling ⇒ task-time `config_missing`. */
export interface ConfigMissing {
  configMissing: string
}

export interface WorkflowRegistry {
  /** The per-workflow + per-route validation report. */
  report: RegistryReport
  /** Resolve a route kind to its workflow, or a `config_missing` reason (§3). */
  resolve(kind: 'section' | 'world'): ResolvedWorkflow | ConfigMissing
}

// The shipped sample lives next to this module; the harness-wiring task copies it into the
// user's workflowsDir on first run if absent (§3, "Cowrite ships a sample default.json").
/** Filename the sample is copied to in the user's workflowsDir (matches the default route name). */
export const SAMPLE_WORKFLOW_FILENAME = 'default.json'

/** Absolute path to the shipped sample workflow (a plain SDXL txt2img graph with markers). */
export function sampleWorkflowPath(): string {
  return fileURLToPath(new URL('./sample-default.json', import.meta.url))
}

/** Recursively freeze a parsed graph so the template can never be mutated in place. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const v of Object.values(value)) deepFreeze(v)
    Object.freeze(value)
  }
  return value
}

/** Canonical, key-sorted JSON serialization so the content hash is stable across key order. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
      )
    }
    return v
  })
}

/** Resolve, parse, and validate a single workflow entry. Never throws — errors become records. */
async function resolveEntry(
  name: string,
  entry: { file: string; label: string; execTimeoutMs?: number },
  workflowsDir: string,
  defaultExecTimeoutMs: number,
): Promise<{ record: WorkflowRecord; resolved?: ResolvedWorkflow }> {
  const filePath = path.join(workflowsDir, entry.file)

  let raw: string
  try {
    raw = await fsp.readFile(filePath, 'utf8')
  } catch {
    return {
      record: {
        name,
        label: entry.label,
        ok: false,
        error: `Workflow file not found: ${entry.file}`,
      },
    }
  }

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return {
      record: {
        name,
        label: entry.label,
        ok: false,
        error: `Workflow file is not valid JSON: ${detail}`,
      },
    }
  }

  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    return {
      record: {
        name,
        label: entry.label,
        ok: false,
        error: 'Not an API-format workflow: expected a JSON object of nodes.',
      },
    }
  }

  const graph = json as Record<string, unknown>
  const derived = deriveInjectionMap(graph)
  if (!derived.ok) {
    return { record: { name, label: entry.label, ok: false, error: derived.error } }
  }

  const resolved: ResolvedWorkflow = {
    name,
    label: entry.label,
    json: deepFreeze(graph),
    injections: derived.injections,
    execTimeoutMs: entry.execTimeoutMs ?? defaultExecTimeoutMs,
    contentHash: await xxh64OfString(canonicalJson(graph)),
  }
  return { record: { name, label: entry.label, ok: true }, resolved: Object.freeze(resolved) }
}

/**
 * Load the registry from a parsed `ComfyConfig` and a resolved `workflowsDir` (the caller
 * resolves the default `<configDir>/workflows`). Reads and validates every `workflows.*` entry,
 * then checks each `route.*` names an existing, valid workflow. Returns the report + a resolver.
 */
export async function loadWorkflowRegistry(
  comfy: ComfyConfig,
  opts: { workflowsDir: string },
): Promise<WorkflowRegistry> {
  const defaultExecTimeoutMs = comfy.timeouts.execTimeoutMs ?? 300_000
  const byName = new Map<string, ResolvedWorkflow>()
  const workflows: WorkflowRecord[] = []

  for (const [name, entry] of Object.entries(comfy.workflows)) {
    const { record, resolved } = await resolveEntry(
      name,
      entry,
      opts.workflowsDir,
      defaultExecTimeoutMs,
    )
    workflows.push(record)
    if (resolved !== undefined) byName.set(name, resolved)
  }

  const routeRecord = (routeName: string): RouteRecord => ({
    name: routeName,
    ok: byName.has(routeName),
  })
  const report: RegistryReport = {
    workflows,
    route: {
      section: routeRecord(comfy.route.section),
      world: routeRecord(comfy.route.world),
    },
  }

  const missingReason = (routeName: string): string => {
    if (!(routeName in comfy.workflows)) {
      return `route points at workflow "${routeName}", which is not defined in comfyui.workflows`
    }
    const rec = workflows.find((w) => w.name === routeName)
    return `workflow "${routeName}" is invalid: ${rec?.error ?? 'unknown error'}`
  }

  return {
    report,
    resolve: (kind) => {
      const routeName = comfy.route[kind]
      const resolved = byName.get(routeName)
      return resolved ?? { configMissing: missingReason(routeName) }
    },
  }
}
