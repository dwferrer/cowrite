import path from 'node:path'
import {
  AppConfig,
  type ConfigOverride,
  type ConfigUpdate,
  type ConfigWriteRes,
  type ModelEndpoint,
  type ModelEndpointUpdate,
  PublicConfig,
  type PublicModelEndpoint,
} from '@cowrite/shared'
import { AppError } from '../http/errors.js'
import { ensureDir, writeFileAtomic } from '../storage/lib/fsx.js'
import {
  type CliFlags,
  type Env,
  interpolateEnv,
  type LoadedConfig,
  loadConfig,
  mergeOverrides,
} from './load.js'

/**
 * In-memory config service (docs/03-api.md §9.5–§9.7).
 *
 * Holds two layers: `fileConfig` (defaults + file — what PUT persists and what apiKey
 * sentinels resolve against) and the effective snapshot (file < env < flags, tildes
 * expanded) that `get()` serves. Hot-apply is a snapshot swap — consumers read config at
 * point of use, and in-flight tasks capture their own copy at task start. The three
 * restart-required fields (`server.host`, `server.port`, `storage.dataDir`) are read only
 * at boot, so the snapshot still reflects the new values; `restartRequired` tells the UI
 * the live listener/data handles haven't moved.
 *
 * Errors are thrown as `AppError` (http/errors.ts — the one class the production error
 * handler instanceof-matches) and mapped to the §7 envelope.
 */

/** §9.7: persisted but not live until restart. */
export const RESTART_REQUIRED_PATHS = ['server.host', 'server.port', 'storage.dataDir'] as const

export interface ConfigServiceDeps {
  /** Injectable for tests. */
  env?: Env
  flags?: CliFlags
  homedir?: string
}

function getPath(config: AppConfig, dotted: string): unknown {
  let cursor: unknown = config
  for (const segment of dotted.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[segment]
  }
  return cursor
}

/** §9.5 sentinel: apiKey null = keep the stored key; '' = keyless. */
function resolveEndpoint(
  update: ModelEndpointUpdate | null,
  stored: ModelEndpoint | null,
): ModelEndpoint | null {
  if (update === null) return null
  const { apiKey, ...rest } = update
  return { ...rest, apiKey: apiKey ?? stored?.apiKey ?? '' }
}

function redactEndpoint(endpoint: ModelEndpoint | null): PublicModelEndpoint | null {
  if (endpoint === null) return null
  return { ...endpoint, apiKey: { set: endpoint.apiKey !== '' } }
}

export class ConfigService {
  private readonly configPath: string
  private readonly env: Env
  private readonly flags: CliFlags
  private readonly homedir: string | undefined
  private fileConfig: AppConfig
  private snapshot: AppConfig
  private overrides: ConfigOverride[]
  private readonly listeners = new Set<(config: AppConfig) => void>()

  constructor(loaded: LoadedConfig, deps: ConfigServiceDeps = {}) {
    this.configPath = loaded.configPath
    this.env = deps.env ?? process.env
    this.flags = deps.flags ?? {}
    this.homedir = deps.homedir
    this.fileConfig = loaded.fileConfig
    this.snapshot = loaded.config
    this.overrides = loaded.overrides
  }

  /** The effective config snapshot. Callers must not mutate it. */
  get(): AppConfig {
    return this.snapshot
  }

  /** Redacted view for GET/PUT responses: apiKey → {set}, setup flags, provenance (§9.6). */
  public(): PublicConfig {
    const snapshot = this.snapshot
    return PublicConfig.parse({
      ...structuredClone(snapshot),
      models: {
        high: redactEndpoint(snapshot.models.high),
        low: redactEndpoint(snapshot.models.low),
      },
      setup: {
        highConfigured: snapshot.models.high !== null,
        lowConfigured: snapshot.models.low !== null,
        comfyConfigured: snapshot.comfyui !== null,
      },
      overrides: this.overrides,
    })
  }

  /** Subscribe to hot-applied snapshots (update/reload). Returns the unsubscribe. */
  onChange(listener: (config: AppConfig) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * PUT /api/config (§9.5): full replace. Resolves the apiKey sentinels against the
   * stored file layer, validates, writes the file atomically, hot-applies, and reports
   * which persisted-but-not-live fields need a restart. Env/flag-overridden fields are
   * persisted too — they apply once the override is removed (§9.6).
   */
  async update(update: ConfigUpdate): Promise<ConfigWriteRes> {
    const document = {
      ...update,
      models: {
        high: resolveEndpoint(update.models.high, this.fileConfig.models.high),
        low: resolveEndpoint(update.models.low, this.fileConfig.models.low),
      },
      // Seed a `workflows.default` entry when the user first configures ComfyUI (§18): the
      // default `route.section`/`route.world` point at "default", so without this a bare
      // baseUrl save leaves the routes dangling (a permanent config_missing). The sample
      // default.json is copied to workflowsDir at runtime build.
      comfyui: seedDefaultWorkflow(update.comfyui),
    }
    const parsed = AppConfig.safeParse(document)
    if (!parsed.success) {
      throw new AppError('validation', 'invalid config document', { issues: parsed.error.issues })
    }
    await ensureDir(path.dirname(this.configPath))
    await writeFileAtomic(this.configPath, serializeConfig(parsed.data))
    // The written file may itself use ${env:VAR} keys the client echoed verbatim; the
    // stored layer is the interpolated view, same as a fresh load.
    const interpolated = AppConfig.parse(interpolateEnv(parsed.data, this.env))
    return this.apply(interpolated)
  }

  /** POST /api/config/reload (§9.7): re-read the file for hand-editors; no fs-watcher. */
  async reload(): Promise<ConfigWriteRes> {
    const result = await loadConfig({ flags: this.flags, env: this.env, homedir: this.homedir })
    if (!result.ok) {
      throw new AppError('validation', `config file is invalid: ${result.configPath}`, {
        issues: result.issues,
      })
    }
    return this.apply(result.fileConfig)
  }

  private apply(fileConfig: AppConfig): ConfigWriteRes {
    const merged = mergeOverrides(fileConfig, this.env, this.flags, this.homedir)
    if (!merged.ok) {
      throw new AppError('validation', 'config is invalid after env/flag overrides', {
        issues: merged.issues,
      })
    }
    const previous = this.snapshot
    const restartRequired = RESTART_REQUIRED_PATHS.filter(
      (p) => getPath(previous, p) !== getPath(merged.config, p),
    )
    this.fileConfig = fileConfig
    this.snapshot = merged.config
    this.overrides = merged.overrides
    for (const listener of this.listeners) listener(this.snapshot)
    return { config: this.public(), restartRequired }
  }
}

/** The default workflow name — matches `route.*`'s default and the copied sample filename. */
const DEFAULT_WORKFLOW_NAME = 'default'

/** Ensure `comfyui.workflows.default` exists so the default routes resolve (§18). Leaves an
 *  already-configured `default` (or a null comfyui) untouched. */
function seedDefaultWorkflow(comfy: ConfigUpdate['comfyui']): ConfigUpdate['comfyui'] {
  if (comfy === null) return null
  if (Object.hasOwn(comfy.workflows, DEFAULT_WORKFLOW_NAME)) return comfy
  return {
    ...comfy,
    workflows: {
      ...comfy.workflows,
      [DEFAULT_WORKFLOW_NAME]: { file: 'default.json', label: 'Default' },
    },
  }
}

/**
 * PUT rewrites the file as plain JSON (valid JSONC) with a pointer comment — hand-written
 * comments do not survive a settings-screen save; hand-editors use reload instead.
 */
function serializeConfig(config: AppConfig): string {
  return `// Cowrite configuration — see docs/03-api.md §9. Rewritten by the settings screen;\n// comments are not preserved across saves.\n${JSON.stringify(config, null, 2)}\n`
}
