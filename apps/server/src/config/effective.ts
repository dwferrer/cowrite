import { AppConfig } from '@cowrite/shared'
import { isMockLlmRequested } from '../harness/mockLlm.js'
import {
  type CliFlags,
  type ConfigIssue,
  type Env,
  type LoadedConfig,
  loadConfig,
  resolveConfigPaths,
} from './load.js'

/**
 * ONE effective-config resolution shared by BOTH composition roots — the server
 * (src/index.ts) and the dev CLI (cliAgents.ts) — so mock-mode semantics can never
 * drift between them (docs/09 §2.3):
 *
 * - Normal mode: `loadConfig` as-is; an invalid file is a fatal, file-positioned error.
 * - Mock mode (`--mock` / `COWRITE_MOCK_LLM=1`): the OVERLAY semantic — the user's
 *   config is loaded tolerantly and the mock model lanes are overlaid on top of it by
 *   the caller (`withMockModels` after booting the in-process mock). An INVALID config
 *   under mock mode falls back to schema defaults with a printed warning — never fatal,
 *   because mock runs must always be reachable for dev/e2e regardless of config rot.
 */

export interface EffectiveConfigOk {
  ok: true
  /** Effective config, WITHOUT the mock lane overlay (the caller boots the mock and
   *  applies `withMockModels(config, mock.url)` — it owns the mock's lifecycle). */
  config: AppConfig
  /** Whether mock mode was requested (flag or env) — overlay the lanes when true. */
  mock: boolean
  /** The full load result — synthesized from defaults when the tolerant fallback ran. */
  loaded: LoadedConfig
  /** True when an invalid file was tolerated under mock mode (defaults in effect). */
  fellBack: boolean
  /** Human-readable notices the caller should print (fallback warnings). */
  warnings: string[]
}

export interface EffectiveConfigError {
  ok: false
  configPath: string
  issues: ConfigIssue[]
}

export type EffectiveConfigResult = EffectiveConfigOk | EffectiveConfigError

export function formatConfigIssues(issues: ConfigIssue[]): string {
  return issues
    .map((issue) => {
      const where = issue.line === null ? '' : ` (line ${issue.line}, col ${issue.column})`
      return `  - ${issue.path === '' ? '(file)' : issue.path}: ${issue.message}${where}`
    })
    .join('\n')
}

export interface EffectiveConfigOptions {
  env?: Env
  flags?: CliFlags
  homedir?: string
}

export async function resolveEffectiveConfig(
  opts: EffectiveConfigOptions = {},
): Promise<EffectiveConfigResult> {
  const env = opts.env ?? process.env
  const flags = opts.flags ?? {}
  const mock = isMockLlmRequested(env, flags.mock === true)

  const loadOpts = {
    env,
    flags,
    ...(opts.homedir === undefined ? {} : { homedir: opts.homedir }),
  }
  const loaded = await loadConfig(loadOpts)
  if (loaded.ok) {
    return {
      ok: true,
      config: loaded.config,
      mock: mock || loaded.mock,
      loaded,
      fellBack: false,
      warnings: [],
    }
  }
  if (!mock) return { ok: false, configPath: loaded.configPath, issues: loaded.issues }

  // Tolerant mock-mode fallback: defaults + warning, never fatal.
  const { configDir, configPath } = resolveConfigPaths(flags, env, opts.homedir)
  const defaults = AppConfig.parse({})
  const synthesized: LoadedConfig = {
    ok: true,
    config: defaults,
    fileConfig: defaults,
    overrides: [],
    configPath,
    configDir,
    firstRun: false,
    mock: true,
  }
  return {
    ok: true,
    config: defaults,
    mock: true,
    loaded: synthesized,
    fellBack: true,
    warnings: [
      `[cowrite] config at ${loaded.configPath} is invalid — running on defaults under mock mode:\n` +
        formatConfigIssues(loaded.issues),
    ],
  }
}
