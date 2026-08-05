import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { type AppConfig, ComfyConfig, ConfigUpdate, type PublicConfig } from '@cowrite/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppError } from '../http/errors.js'
import { type CliFlags, type Env, loadConfig } from './load.js'
import { ConfigService } from './service.js'

let dir: string
let home: string
let configPath: string

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cowrite-svc-'))
  home = path.join(dir, 'home')
  await fsp.mkdir(home, { recursive: true })
  configPath = path.join(dir, 'config.jsonc')
})

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true })
})

const FILE_WITH_HIGH = `{
  "models": {
    "high": { "baseUrl": "http://h.example/v1", "apiKey": "sk-stored", "model": "big" }
  }
}`

async function makeService(
  fileText: string | null,
  env: Env = {},
  flags: CliFlags = {},
): Promise<ConfigService> {
  if (fileText !== null) await fsp.writeFile(configPath, fileText, 'utf8')
  const fullEnv = { COWRITE_CONFIG: configPath, ...env }
  const loaded = await loadConfig({ env: fullEnv, flags, homedir: home })
  if (!loaded.ok) throw new Error(`load failed: ${JSON.stringify(loaded.issues)}`)
  return new ConfigService(loaded, { env: fullEnv, flags, homedir: home })
}

/** What a well-behaved client PUTs back: the GET body with redacted keys nulled. */
function updateFromPublic(pub: PublicConfig): ConfigUpdate {
  const doc = structuredClone(pub) as unknown as Record<string, unknown>
  const models = doc.models as { high: unknown; low: unknown }
  for (const lane of ['high', 'low'] as const) {
    const endpoint = models[lane] as Record<string, unknown> | null
    if (endpoint !== null) endpoint.apiKey = null
  }
  return ConfigUpdate.parse(doc) // setup/overrides are stripped by the schema
}

describe('public()', () => {
  it('redacts apiKey and reports setup flags + overrides', async () => {
    const service = await makeService(FILE_WITH_HIGH, { COWRITE_HOST: '0.0.0.0' })
    const pub = service.public()
    expect(pub.models.high?.apiKey).toEqual({ set: true })
    expect(pub.models.low).toBeNull()
    expect(pub.setup).toEqual({
      highConfigured: true,
      lowConfigured: false,
      comfyConfigured: false,
    })
    expect(pub.overrides).toEqual([{ path: 'server.host', by: 'env' }])
    expect(JSON.stringify(pub)).not.toContain('sk-stored')
  })

  it('a keyless endpoint reports {set: false}', async () => {
    const service = await makeService(
      '{ "models": { "low": { "baseUrl": "http://l.example/v1", "apiKey": "", "model": "s" } } }',
    )
    expect(service.public().models.low?.apiKey).toEqual({ set: false })
  })
})

describe('update() — §9.5 PUT semantics', () => {
  it('redaction round-trip: PUT of a redacted GET is a no-op', async () => {
    const service = await makeService(FILE_WITH_HIGH)
    const before = structuredClone(service.get())
    const res = await service.update(updateFromPublic(service.public()))
    expect(service.get()).toEqual(before) // effective config unchanged
    expect(res.restartRequired).toEqual([])
    // the stored key survives the null sentinel and lands back in the file
    expect(await fsp.readFile(configPath, 'utf8')).toContain('sk-stored')
    expect(service.get().models.high?.apiKey).toBe('sk-stored')
  })

  it('apiKey "" clears the stored key; a new literal replaces it', async () => {
    const service = await makeService(FILE_WITH_HIGH)
    const update = updateFromPublic(service.public())
    if (update.models.high === null) throw new Error('expected high endpoint')
    update.models.high.apiKey = ''
    await service.update(update)
    expect(service.get().models.high?.apiKey).toBe('')
    expect(await fsp.readFile(configPath, 'utf8')).not.toContain('sk-stored')

    update.models.high.apiKey = 'sk-new'
    await service.update(update)
    expect(service.get().models.high?.apiKey).toBe('sk-new')
  })

  it('models.high: null clears the endpoint (full-replace, not merge)', async () => {
    const service = await makeService(FILE_WITH_HIGH)
    const update = updateFromPublic(service.public())
    update.models.high = null
    await service.update(update)
    expect(service.get().models.high).toBeNull()
    expect(service.public().setup.highConfigured).toBe(false)
  })

  it('seeds workflows.default when the user first configures a ComfyUI baseUrl (§18)', async () => {
    const service = await makeService(FILE_WITH_HIGH)
    const update = updateFromPublic(service.public())
    update.comfyui = ComfyConfig.parse({ baseUrl: 'http://127.0.0.1:8188' })
    expect(update.comfyui.workflows).toEqual({}) // the client sent no workflows

    await service.update(update)
    // The default routes now resolve: a `default` workflow entry was seeded so a bare-baseUrl
    // save yields a working (green) health report instead of a permanent config_missing.
    expect(service.get().comfyui?.workflows.default).toEqual({
      file: 'default.json',
      label: 'Default',
    })
    expect(service.get().comfyui?.route.section).toBe('default')
    // and it persisted to the file.
    expect(await fsp.readFile(configPath, 'utf8')).toContain('default.json')
  })

  it('leaves an existing default workflow untouched (§18)', async () => {
    const service = await makeService(FILE_WITH_HIGH)
    const update = updateFromPublic(service.public())
    update.comfyui = ComfyConfig.parse({
      baseUrl: 'http://127.0.0.1:8188',
      workflows: { default: { file: 'my-sdxl.json', label: 'My SDXL' } },
    })
    await service.update(update)
    expect(service.get().comfyui?.workflows.default).toEqual({
      file: 'my-sdxl.json',
      label: 'My SDXL',
    })
  })

  it('hot-applies everything else and notifies onChange subscribers', async () => {
    const service = await makeService(FILE_WITH_HIGH)
    const seen: AppConfig[] = []
    const unsubscribe = service.onChange((config) => {
      seen.push(config)
    })
    const update = updateFromPublic(service.public())
    update.routing = { continue: 'high' }
    const res = await service.update(update)
    expect(res.restartRequired).toEqual([])
    expect(service.get().routing).toEqual({ continue: 'high' })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.routing).toEqual({ continue: 'high' })

    unsubscribe()
    await service.update(update)
    expect(seen).toHaveLength(1)
  })

  it('reports restartRequired for host/port/dataDir changes', async () => {
    const service = await makeService(FILE_WITH_HIGH)
    const update = updateFromPublic(service.public())
    update.server.port = 4100
    update.storage.dataDir = path.join(dir, 'moved-data')
    const res = await service.update(update)
    expect(res.restartRequired.sort()).toEqual(['server.port', 'storage.dataDir'])
    // persisted AND reflected in the snapshot — only the live listener/handles lag
    expect(service.get().server.port).toBe(4100)
  })

  it('an env-overridden field is persisted but the effective value does not move', async () => {
    const service = await makeService(FILE_WITH_HIGH, { COWRITE_PORT: '9999' })
    expect(service.get().server.port).toBe(9999)
    const update = updateFromPublic(service.public())
    update.server.port = 4200
    const res = await service.update(update)
    expect(res.restartRequired).toEqual([]) // effective port never changed
    expect(service.get().server.port).toBe(9999)
    expect(await fsp.readFile(configPath, 'utf8')).toContain('4200')
    expect(res.config.overrides).toContainEqual({ path: 'server.port', by: 'env' })
  })

  it('rejects an invalid document with AppError(validation)', async () => {
    const service = await makeService(FILE_WITH_HIGH)
    const update = updateFromPublic(service.public())
    if (update.models.high === null) throw new Error('expected high endpoint')
    update.models.high.baseUrl = 'not a url'
    // ConfigUpdate itself would catch this at the route; service re-validates regardless
    await expect(service.update(update)).rejects.toMatchObject({
      name: 'AppError',
      code: 'validation',
    })
  })
})

describe('reload() — §9.7', () => {
  it('picks up hand-edits from disk and hot-applies them', async () => {
    const service = await makeService(FILE_WITH_HIGH)
    await fsp.writeFile(
      configPath,
      '{ "routing": { "quick-edit": "low" }, "server": { "port": 4300 } }',
      'utf8',
    )
    const res = await service.reload()
    expect(service.get().routing).toEqual({ 'quick-edit': 'low' })
    expect(service.get().models.high).toBeNull() // reload is a full re-read, not a merge
    expect(res.restartRequired).toEqual(['server.port'])
  })

  it('throws AppError(validation) on an invalid file, keeping the old snapshot', async () => {
    const service = await makeService(FILE_WITH_HIGH)
    const before = structuredClone(service.get())
    await fsp.writeFile(configPath, '{ "server": { "port": "nope" } }', 'utf8')
    await expect(service.reload()).rejects.toBeInstanceOf(AppError)
    expect(service.get()).toEqual(before)
  })
})
