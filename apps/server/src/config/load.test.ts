import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type CliFlags,
  expandTilde,
  interpolateEnv,
  type LoadedConfig,
  loadConfig,
  mergeOverrides,
  resolveConfigPaths,
} from './load.js'

let dir: string
let home: string
let configPath: string

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cowrite-config-'))
  home = path.join(dir, 'home')
  await fsp.mkdir(home, { recursive: true })
  configPath = path.join(dir, 'config.jsonc')
})

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true })
})

async function loadOk(opts: {
  file?: string
  env?: Record<string, string | undefined>
  flags?: CliFlags
}): Promise<LoadedConfig> {
  if (opts.file !== undefined) await fsp.writeFile(configPath, opts.file, 'utf8')
  const result = await loadConfig({
    flags: opts.flags,
    env: { COWRITE_CONFIG: configPath, ...opts.env },
    homedir: home,
  })
  if (!result.ok) throw new Error(`expected ok load, got: ${JSON.stringify(result.issues)}`)
  return result
}

describe('expandTilde', () => {
  it('expands ~ and ~/ against the given homedir', () => {
    expect(expandTilde('~', home)).toBe(home)
    expect(expandTilde('~/data/x', home)).toBe(path.join(home, 'data/x'))
  })

  it('leaves other paths untouched', () => {
    expect(expandTilde(path.join(dir, 'abs'), home)).toBe(path.join(dir, 'abs'))
    expect(expandTilde('relative/x', home)).toBe('relative/x')
  })
})

describe('resolveConfigPaths', () => {
  it('defaults to ~/.cowrite/config.jsonc', () => {
    const paths = resolveConfigPaths({}, {}, home)
    expect(paths.configDir).toBe(path.join(home, '.cowrite'))
    expect(paths.configPath).toBe(path.join(home, '.cowrite', 'config.jsonc'))
  })

  it('COWRITE_HOME moves the directory; --home beats it', () => {
    const envOnly = resolveConfigPaths({}, { COWRITE_HOME: path.join(dir, 'envhome') }, home)
    expect(envOnly.configPath).toBe(path.join(dir, 'envhome', 'config.jsonc'))
    const withFlag = resolveConfigPaths(
      { home: path.join(dir, 'flaghome') },
      { COWRITE_HOME: path.join(dir, 'envhome') },
      home,
    )
    expect(withFlag.configPath).toBe(path.join(dir, 'flaghome', 'config.jsonc'))
  })

  it('COWRITE_CONFIG / --config pin the exact file path', () => {
    const envOnly = resolveConfigPaths({}, { COWRITE_CONFIG: configPath }, home)
    expect(envOnly.configPath).toBe(configPath)
    const flagPath = path.join(dir, 'other.jsonc')
    const withFlag = resolveConfigPaths({ config: flagPath }, { COWRITE_CONFIG: configPath }, home)
    expect(withFlag.configPath).toBe(flagPath)
  })
})

/** Builds a literal "${env:NAME}" reference without tripping noTemplateCurlyInString. */
const envRef = (name: string): string => `\${env:${name}}`

describe('interpolateEnv', () => {
  it('replaces env references everywhere in the tree, missing vars become empty', () => {
    const input = {
      a: envRef('ONE'),
      nested: { b: `x-${envRef('ONE')}-${envRef('TWO')}` },
      list: [envRef('MISSING'), 42, null],
    }
    expect(interpolateEnv(input, { ONE: '1', TWO: '2' })).toEqual({
      a: '1',
      nested: { b: 'x-1-2' },
      list: ['', 42, null],
    })
  })
})

describe('precedence: defaults < file < env < flags', () => {
  it('missing file yields pure schema defaults and firstRun', async () => {
    const result = await loadOk({})
    expect(result.firstRun).toBe(true)
    expect(result.config.server.port).toBe(2697)
    expect(result.config.server.host).toBe('127.0.0.1')
    expect(result.config.models.high).toBeNull()
    expect(result.config.storage.dataDir).toBe(path.resolve(path.join(home, '.cowrite/data')))
    expect(result.overrides).toEqual([])
    expect(result.mock).toBe(false)
  })

  it('file beats defaults', async () => {
    const result = await loadOk({ file: '{ "server": { "port": 4000 } }' })
    expect(result.firstRun).toBe(false)
    expect(result.config.server.port).toBe(4000)
  })

  it('env beats file, flags beat env — with provenance', async () => {
    const result = await loadOk({
      file: '{ "server": { "port": 4000, "host": "file-host" }, "storage": { "dataDir": "~/file-data" } }',
      env: {
        COWRITE_PORT: '5000',
        COWRITE_HOST: 'env-host',
        COWRITE_DATA_DIR: path.join(dir, 'env-data'),
      },
      flags: { port: 6000 },
    })
    expect(result.config.server.port).toBe(6000)
    expect(result.config.server.host).toBe('env-host')
    expect(result.config.storage.dataDir).toBe(path.resolve(path.join(dir, 'env-data')))
    const byPath = new Map(result.overrides.map((o) => [o.path, o.by]))
    expect(byPath.get('server.port')).toBe('flag')
    expect(byPath.get('server.host')).toBe('env')
    expect(byPath.get('storage.dataDir')).toBe('env')
  })

  it('COWRITE_LLM_* builds a model endpoint over a null file value', async () => {
    const result = await loadOk({
      env: {
        COWRITE_LLM_HIGH_BASE_URL: 'http://llm.example/v1',
        COWRITE_LLM_HIGH_API_KEY: 'sk-env',
        COWRITE_LLM_HIGH_MODEL: 'big-model',
      },
    })
    expect(result.config.models.high).toMatchObject({
      baseUrl: 'http://llm.example/v1',
      apiKey: 'sk-env',
      model: 'big-model',
      maxOutputTokens: 2048, // schema default fills the rest
    })
    expect(result.config.models.low).toBeNull()
    const paths = result.overrides.map((o) => o.path).sort()
    expect(paths).toEqual(['models.high.apiKey', 'models.high.baseUrl', 'models.high.model'])
  })

  it('COWRITE_COMFYUI_BASE_URL builds a comfy config over null', async () => {
    const result = await loadOk({ env: { COWRITE_COMFYUI_BASE_URL: 'http://comfy.example' } })
    expect(result.config.comfyui?.baseUrl).toBe('http://comfy.example')
    expect(result.overrides).toEqual([{ path: 'comfyui.baseUrl', by: 'env' }])
  })

  it('--no-open and mock signals', async () => {
    const flagged = await loadOk({ flags: { noOpen: true, mock: true } })
    expect(flagged.config.server.openBrowser).toBe(false)
    expect(flagged.overrides).toContainEqual({ path: 'server.openBrowser', by: 'flag' })
    expect(flagged.mock).toBe(true)

    const viaEnv = await loadOk({ env: { COWRITE_MOCK_LLM: '1' } })
    expect(viaEnv.mock).toBe(true)
  })
})

describe('env-reference interpolation in the file', () => {
  it('resolves secrets from the environment before validation', async () => {
    const result = await loadOk({
      file: `{
        "models": {
          "high": { "baseUrl": "http://h.example/v1", "apiKey": "\${env:MY_KEY}", "model": "m" }
        }
      }`,
      env: { MY_KEY: 'sk-secret' },
    })
    expect(result.config.models.high?.apiKey).toBe('sk-secret')
    // interpolation is not an override — no provenance entry
    expect(result.overrides).toEqual([])
  })

  it('an unset variable interpolates to "" (keyless)', async () => {
    const result = await loadOk({
      file: `{
        "models": {
          "high": { "baseUrl": "http://h.example/v1", "apiKey": "\${env:NOPE}", "model": "m" }
        }
      }`,
    })
    expect(result.config.models.high?.apiKey).toBe('')
  })
})

describe('fatal load errors', () => {
  it('syntax errors carry line/column from jsonc offsets', async () => {
    await fsp.writeFile(configPath, '{\n  "server": { "port": }\n}\n', 'utf8')
    const result = await loadConfig({ env: { COWRITE_CONFIG: configPath }, homedir: home })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.length).toBeGreaterThan(0)
    expect(result.issues[0]?.line).toBe(2)
    expect(result.issues[0]?.message).toBeTruthy()
  })

  it('Zod issues carry the dotted path and the offending line', async () => {
    await fsp.writeFile(configPath, '{\n  "server": {\n    "port": "not-a-port"\n  }\n}\n', 'utf8')
    const result = await loadConfig({ env: { COWRITE_CONFIG: configPath }, homedir: home })
    expect(result.ok).toBe(false)
    if (result.ok) return
    const issue = result.issues.find((i) => i.path === 'server.port')
    expect(issue).toBeDefined()
    expect(issue?.line).toBe(3)
  })

  it('a bad env override is fatal with an env-pointing message, not a file offset', async () => {
    const result = await loadConfig({
      env: { COWRITE_CONFIG: configPath, COWRITE_PORT: 'abc' },
      homedir: home,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    const issue = result.issues.find((i) => i.path === 'server.port')
    expect(issue?.message).toContain('env vars')
    expect(issue?.line).toBeNull()
  })

  it('a missing file is never fatal (first-run path)', async () => {
    const result = await loadConfig({ env: { COWRITE_CONFIG: configPath }, homedir: home })
    expect(result.ok).toBe(true)
  })
})

describe('mergeOverrides', () => {
  it('is a no-op with empty env and flags', async () => {
    const loaded = await loadOk({ file: '{ "server": { "port": 4001 } }' })
    const merged = mergeOverrides(loaded.fileConfig, {}, {}, home)
    expect(merged.ok).toBe(true)
    if (!merged.ok) return
    expect(merged.config.server.port).toBe(4001)
    expect(merged.overrides).toEqual([])
  })

  it('expands tildes in dataDir and comfy workflowsDir', async () => {
    const loaded = await loadOk({
      file: '{ "comfyui": { "baseUrl": "http://c.example", "workflowsDir": "~/wf" } }',
    })
    expect(loaded.config.comfyui?.workflowsDir).toBe(path.resolve(path.join(home, 'wf')))
    expect(loaded.config.storage.dataDir).toBe(path.resolve(path.join(home, '.cowrite/data')))
    // the file layer keeps the unexpanded spelling — PUT round-trips it
    expect(loaded.fileConfig.storage.dataDir).toBe('~/.cowrite/data')
  })
})
