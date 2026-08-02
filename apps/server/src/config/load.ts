import os from 'node:os'
import path from 'node:path'
import { AppConfig, type ConfigOverride } from '@cowrite/shared'
import {
  findNodeAtLocation,
  type ParseError,
  parse as parseJsonc,
  parseTree,
  printParseErrorCode,
} from 'jsonc-parser'
import { readIfExists } from '../storage/lib/fsx.js'

/**
 * Config loading (docs/03-api.md §9.1–§9.3).
 *
 * Locates `~/.cowrite/config.jsonc` (COWRITE_HOME / COWRITE_CONFIG / --home / --config
 * override the location), parses JSONC, applies `${env:VAR}` interpolation, then layers
 * precedence lowest→highest: schema defaults → file → environment variables → CLI flags,
 * tracking override provenance per §9.6.
 *
 * An INVALID file is a fatal load error (Zod issues with jsonc line/column hints); a
 * MISSING file is the first-run path and never fatal (§9.7).
 */

export interface CliFlags {
  home?: string
  config?: string
  dataDir?: string
  host?: string
  port?: number
  mock?: boolean
  noOpen?: boolean
}

export type Env = Record<string, string | undefined>

export interface LoadOptions {
  flags?: CliFlags
  env?: Env
  /** Injectable for tests; defaults to `os.homedir()`. */
  homedir?: string
}

export interface ConfigIssue {
  /** Dotted config path ('' for whole-file syntax errors). */
  path: string
  message: string
  /** 1-based position in the config file, when the issue maps to file text. */
  line: number | null
  column: number | null
}

export interface LoadedConfig {
  ok: true
  /** Effective config: defaults < file < env < flags, tildes expanded. */
  config: AppConfig
  /** The file layer alone (defaults + file, no env/flags) — what PUT sentinels resolve against. */
  fileConfig: AppConfig
  overrides: ConfigOverride[]
  configPath: string
  configDir: string
  firstRun: boolean
  /** COWRITE_MOCK_LLM=1 / --mock — not an AppConfig field; index.ts boots the mocks. */
  mock: boolean
}

export interface ConfigLoadError {
  ok: false
  configPath: string
  issues: ConfigIssue[]
}

export type LoadResult = LoadedConfig | ConfigLoadError

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/** Cross-platform `~` expansion — shells don't expand it inside JSONC (docs/03 §10.3). */
export function expandTilde(p: string, homedir = os.homedir()): string {
  if (p === '~') return homedir
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(homedir, p.slice(2))
  return p
}

export interface ConfigPaths {
  configDir: string
  configPath: string
}

export function resolveConfigPaths(
  flags: CliFlags = {},
  env: Env = process.env,
  homedir = os.homedir(),
): ConfigPaths {
  const configDir = path.resolve(
    expandTilde(flags.home ?? env.COWRITE_HOME ?? '~/.cowrite', homedir),
  )
  const configPath = path.resolve(
    expandTilde(
      flags.config ?? env.COWRITE_CONFIG ?? path.join(configDir, 'config.jsonc'),
      homedir,
    ),
  )
  return { configDir, configPath }
}

// ---------------------------------------------------------------------------
// ${env:VAR} interpolation (§9.1) — applied to every string in the parsed file,
// before validation. An unset variable interpolates to '' (keyless semantics).
// ---------------------------------------------------------------------------

const ENV_PATTERN = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g

export function interpolateEnv(value: unknown, env: Env): unknown {
  if (typeof value === 'string') {
    return value.replace(ENV_PATTERN, (_match, name: string) => env[name] ?? '')
  }
  if (Array.isArray(value)) return value.map((item) => interpolateEnv(item, env))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, interpolateEnv(item, env)]),
    )
  }
  return value
}

// ---------------------------------------------------------------------------
// jsonc offset → line/column
// ---------------------------------------------------------------------------

function offsetToLineCol(text: string, offset: number): { line: number; column: number } {
  let line = 1
  let lineStart = 0
  const end = Math.min(offset, text.length)
  for (let i = 0; i < end; i++) {
    if (text[i] === '\n') {
      line++
      lineStart = i + 1
    }
  }
  return { line, column: end - lineStart + 1 }
}

function syntaxIssues(text: string, errors: ParseError[]): ConfigIssue[] {
  return errors.map((err) => {
    const { line, column } = offsetToLineCol(text, err.offset)
    return { path: '', message: printParseErrorCode(err.error), line, column }
  })
}

/** Map Zod issues onto file positions via the jsonc parse tree (deepest existing node wins). */
function zodIssuesWithOffsets(
  text: string | null,
  issues: { path: PropertyKey[]; message: string }[],
): ConfigIssue[] {
  const tree = text === null ? undefined : parseTree(text)
  return issues.map((issue) => {
    const segments = issue.path.filter(
      (seg): seg is string | number => typeof seg === 'string' || typeof seg === 'number',
    )
    let line: number | null = null
    let column: number | null = null
    if (tree && text !== null) {
      for (let len = segments.length; len >= 0; len--) {
        const node = len === 0 ? tree : findNodeAtLocation(tree, segments.slice(0, len))
        if (node) {
          const pos = offsetToLineCol(text, node.offset)
          line = pos.line
          column = pos.column
          break
        }
      }
    }
    return { path: segments.join('.'), message: issue.message, line, column }
  })
}

// ---------------------------------------------------------------------------
// Env/flag overlay (§9.3) with provenance (§9.6)
// ---------------------------------------------------------------------------

function setPath(doc: Record<string, unknown>, dotted: string, value: unknown): void {
  const segments = dotted.split('.')
  const last = segments.pop()
  if (last === undefined) return
  let cursor = doc
  for (const segment of segments) {
    const next = cursor[segment]
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      const created: Record<string, unknown> = {}
      cursor[segment] = created
      cursor = created
    } else {
      cursor = next as Record<string, unknown>
    }
  }
  cursor[last] = value
}

function envNumber(raw: string): unknown {
  const n = Number(raw)
  return Number.isFinite(n) ? n : raw // let Zod report the type error with the raw value
}

export interface MergeOk {
  ok: true
  config: AppConfig
  overrides: ConfigOverride[]
}

export interface MergeError {
  ok: false
  issues: ConfigIssue[]
}

/**
 * Layer env vars then CLI flags over the validated file config, re-validate, and expand
 * tildes in path fields. Shared by startup load and ConfigService hot-apply so both
 * compute identical effective configs and provenance.
 */
export function mergeOverrides(
  fileConfig: AppConfig,
  env: Env = {},
  flags: CliFlags = {},
  homedir = os.homedir(),
): MergeOk | MergeError {
  const doc = structuredClone(fileConfig) as unknown as Record<string, unknown>
  const provenance = new Map<string, 'env' | 'flag'>()

  const applyEnv = (name: string, dotted: string, transform?: (raw: string) => unknown): void => {
    const raw = env[name]
    if (raw === undefined || raw === '') return
    setPath(doc, dotted, transform ? transform(raw) : raw)
    provenance.set(dotted, 'env')
  }

  applyEnv('COWRITE_DATA_DIR', 'storage.dataDir')
  applyEnv('COWRITE_HOST', 'server.host')
  applyEnv('COWRITE_PORT', 'server.port', envNumber)
  for (const lane of ['high', 'low'] as const) {
    const prefix = `COWRITE_LLM_${lane.toUpperCase()}`
    applyEnv(`${prefix}_BASE_URL`, `models.${lane}.baseUrl`)
    applyEnv(`${prefix}_API_KEY`, `models.${lane}.apiKey`)
    applyEnv(`${prefix}_MODEL`, `models.${lane}.model`)
  }
  applyEnv('COWRITE_COMFYUI_BASE_URL', 'comfyui.baseUrl')

  const applyFlag = (dotted: string, value: unknown): void => {
    if (value === undefined) return
    setPath(doc, dotted, value)
    provenance.set(dotted, 'flag')
  }

  applyFlag('storage.dataDir', flags.dataDir)
  applyFlag('server.host', flags.host)
  applyFlag('server.port', flags.port)
  if (flags.noOpen === true) applyFlag('server.openBrowser', false)

  const parsed = AppConfig.safeParse(doc)
  if (!parsed.success) {
    // No file offsets here — the offending values came from the environment/flags.
    return {
      ok: false,
      issues: zodIssuesWithOffsets(null, parsed.error.issues).map((issue) => ({
        ...issue,
        message: `${issue.message} (check env vars / CLI flags overriding this field)`,
      })),
    }
  }

  const config = parsed.data
  config.storage.dataDir = path.resolve(expandTilde(config.storage.dataDir, homedir))
  if (config.comfyui?.workflowsDir !== undefined) {
    config.comfyui.workflowsDir = path.resolve(expandTilde(config.comfyui.workflowsDir, homedir))
  }

  const overrides: ConfigOverride[] = [...provenance.entries()].map(([p, by]) => ({ path: p, by }))
  return { ok: true, config, overrides }
}

// ---------------------------------------------------------------------------
// The loader
// ---------------------------------------------------------------------------

export async function loadConfig(opts: LoadOptions = {}): Promise<LoadResult> {
  const flags = opts.flags ?? {}
  const env = opts.env ?? process.env
  const homedir = opts.homedir ?? os.homedir()
  const { configDir, configPath } = resolveConfigPaths(flags, env, homedir)

  const raw = await readIfExists(configPath)
  const firstRun = raw === null

  let fileValue: unknown = {}
  if (raw !== null) {
    const errors: ParseError[] = []
    fileValue = parseJsonc(raw, errors, { allowTrailingComma: true }) ?? {}
    if (errors.length > 0) {
      return { ok: false, configPath, issues: syntaxIssues(raw, errors) }
    }
  }

  const interpolated = interpolateEnv(fileValue, env)
  const fileParse = AppConfig.safeParse(interpolated)
  if (!fileParse.success) {
    return { ok: false, configPath, issues: zodIssuesWithOffsets(raw, fileParse.error.issues) }
  }

  const merged = mergeOverrides(fileParse.data, env, flags, homedir)
  if (!merged.ok) return { ok: false, configPath, issues: merged.issues }

  const mockEnv = env.COWRITE_MOCK_LLM
  const mock = flags.mock === true || mockEnv === '1' || mockEnv === 'true'

  return {
    ok: true,
    config: merged.config,
    fileConfig: fileParse.data,
    overrides: merged.overrides,
    configPath,
    configDir,
    firstRun,
    mock,
  }
}
