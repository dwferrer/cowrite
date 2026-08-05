import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { createMockComfy, createMockLlm, type MockComfy, type MockLlm } from '@cowrite/mock-llm'
import type { AppConfig, ComfyConfig } from '@cowrite/shared'
import { parseArgs } from './cli.js'
import { formatConfigIssues, resolveEffectiveConfig } from './config/effective.js'
import { ensureFirstRun } from './config/firstRun.js'
import type { CliFlags } from './config/load.js'
import { configRoutes } from './config/routes.js'
import { ConfigService } from './config/service.js'
import { buildMockComfyConfig, withMockComfy, withMockModels } from './harness/mockLlm.js'
import { AgentHarness } from './harness/service.js'
import { buildApp } from './http/app.js'
import { resourceRoutes } from './http/routes/index.js'
import { WorkRegistry } from './http/workRegistry.js'
import { createStorage } from './storage/service.js'

/**
 * The composition root (docs/03-api.md §5.1, §10.1): parse flags → `loadConfig` (env/flag
 * precedence, `${env:VAR}` interpolation, `~` expansion — config/load.ts owns all of it;
 * an invalid file is fatal with file-positioned issues, a missing file is the first-run
 * path) → `ensureFirstRun` (template + data dir) → `ConfigService` → `buildApp` with the
 * resource-route and config-route plugins → listen → banner → open browser → graceful
 * shutdown (SIGINT/SIGTERM; the Windows console close event raises SIGHUP the same way).
 *
 * The three restart-required fields (`server.host`, `server.port`, `storage.dataDir`) are
 * read once here at boot; everything else reads `service.get()` at point of use so PUT
 * /api/config hot-applies (§9.7).
 */

function readFlags(argv: string[]): CliFlags {
  const { flags } = parseArgs(argv)
  const str = (name: string): string | undefined =>
    typeof flags[name] === 'string' ? (flags[name] as string) : undefined
  const port = str('port')
  const parsedPort = port === undefined ? undefined : Number(port)
  if (parsedPort !== undefined && !Number.isInteger(parsedPort)) {
    console.error(`invalid --port '${port}'`)
    process.exit(1)
  }
  return {
    ...(str('home') === undefined ? {} : { home: str('home') }),
    ...(str('config') === undefined ? {} : { config: str('config') }),
    ...(str('data-dir') === undefined ? {} : { dataDir: str('data-dir') }),
    ...(str('host') === undefined ? {} : { host: str('host') }),
    ...(parsedPort === undefined ? {} : { port: parsedPort }),
    ...(flags['no-open'] === undefined ? {} : { noOpen: true }),
    ...(flags.mock === undefined ? {} : { mock: true }),
  }
}

// ---------------------------------------------------------------------------
// Banner + browser
// ---------------------------------------------------------------------------

async function dirSizeBytes(dir: string): Promise<number> {
  let total = 0
  let entries: fs.Dirent[]
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) total += await dirSizeBytes(full)
    else {
      try {
        total += (await fsp.stat(full)).size
      } catch {
        // raced deletion; a banner number need not be exact
      }
    }
  }
  return total
}

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 'B'
  for (const next of units) {
    if (value < 1024) break
    value /= 1024
    unit = next
  }
  return `${value.toFixed(1)} ${unit}`
}

function openBrowser(url: string): void {
  try {
    const [cmd, args]: [string, string[]] =
      process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : process.platform === 'darwin'
          ? ['open', [url]]
          : ['xdg-open', [url]]
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
    child.on('error', () => {
      console.log(`(could not open a browser — visit ${url} yourself)`)
    })
    child.unref()
  } catch {
    // a failed browser open is a logged shrug, never fatal (§10.1)
  }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const pkgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string }
  const version = pkg.version ?? '0.0.0'

  const flags = readFlags(process.argv.slice(2))
  // ONE effective-config resolution shared with the dev CLI (config/effective.ts):
  // invalid config is fatal — except under mock mode, where it warns and runs defaults.
  const resolved = await resolveEffectiveConfig({ flags })
  if (!resolved.ok) {
    console.error(
      `invalid config at ${resolved.configPath}:\n${formatConfigIssues(resolved.issues)}`,
    )
    process.exit(1)
  }
  for (const warning of resolved.warnings) console.warn(warning)

  const { config, mock, loaded } = resolved
  const { configPath, firstRun } = loaded

  // COWRITE_MOCK_LLM=1 / --mock (docs/09 §2.3): boot the scriptable mock in-process and
  // point both model lanes at it, so e2e and manual dev run without real endpoints.
  // MOCK_LLM_PORT / MOCK_COMFY_PORT pin the listen ports (0/unset = ephemeral) so
  // cross-process suites (Playwright) can script `POST /__mock/scenario` at a known
  // address for either mock.
  const pinnedPort = (envVar: string): number => {
    const raw = Number(process.env[envVar] ?? '0')
    return Number.isInteger(raw) && raw > 0 && raw <= 65535 ? raw : 0
  }
  let mockLlm: MockLlm | null = null
  let mockComfy: MockComfy | null = null
  let mockComfyConfig: ComfyConfig | null = null
  if (mock) {
    mockLlm = await createMockLlm({ port: pinnedPort('MOCK_LLM_PORT') })
    // The in-process mock ComfyUI (docs/08 §11, 09 §2.3): always-succeed so the whole app —
    // and e2e — illustrates offline. Its one `default` workflow lives in a hermetic dir the
    // harness seeds with the shipped sample.
    mockComfy = await createMockComfy({ autoSucceed: true, port: pinnedPort('MOCK_COMFY_PORT') })
    mockComfyConfig = buildMockComfyConfig(
      mockComfy.url,
      path.join(config.storage.dataDir, '.mock-comfy-workflows'),
    )
  }

  // Boot-pinned values (§9.7 restartRequired): host, port, dataDir.
  const dataDir = config.storage.dataDir
  try {
    const result = await ensureFirstRun({ configPath, dataDir })
    if (firstRun && result.wroteTemplate) console.log(`first run: wrote ${configPath}`)
  } catch (err) {
    console.error(
      `data dir ${dataDir} is not writable: ${err instanceof Error ? err.message : err}`,
    )
    process.exit(1)
  }

  const service = new ConfigService(loaded, { flags })
  const storage = createStorage(dataDir)
  const works = new WorkRegistry(storage)
  // The harness reads config live per task submit; in mock mode both lanes AND the comfyui
  // block point at the in-process mocks (config-pointing only — everything else is saved
  // config). The mock comfyui object is a stable reference so the harness's runtime cache
  // never rebuilds spuriously (§3 hot-apply).
  const effectiveConfig = (): AppConfig => {
    if (mockLlm === null) return service.get()
    const withModels = withMockModels(service.get(), mockLlm.url)
    return mockComfyConfig === null ? withModels : withMockComfy(withModels, mockComfyConfig)
  }
  const configDir = path.dirname(configPath)
  const harness = new AgentHarness({
    config: effectiveConfig,
    budgets: () => service.get().budgets,
    illustration: { configDir },
  })
  // Build the illustration registry + ComfyUI client now, and rebuild on every config
  // hot-apply / reload (§3): a broken/dangling workflow is per-workflow and task-time,
  // never a boot failure.
  harness.reloadIllustration()
  service.onChange(() => harness.reloadIllustration())
  // Work close cancels that work's lanes before the stream/handle tear down (05 §6.2).
  works.onClose((open) => harness.closeWork(open))
  const app = buildApp({
    config: { current: () => service.get() },
    works,
    version,
    plugins: [
      // budgets: the app-level layer of 06 §8.1's override chain (config.budgets).
      resourceRoutes({ works, storage, budgets: () => service.get().budgets, harness }),
      async (instance) => configRoutes(instance, { service }),
    ],
  })

  const { host, port } = config.server
  try {
    await app.listen({ host, port })
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code === 'EADDRINUSE') {
      console.error(`port ${port} is in use — pass --port or edit server.port in ${configPath}`)
    } else {
      console.error(err)
    }
    process.exit(1)
  }

  if (!LOOPBACK_HOSTS.has(host)) {
    console.error(
      '\n  WARNING: Cowrite has no authentication; anyone who can reach this port can read' +
        '\n  and edit your works. Binding beyond loopback is your explicit opt-in.\n',
    )
  }

  const laneStatus = (configured: boolean): string => (configured ? 'ok' : 'not configured')
  const workCount = (await storage.listWorks()).length
  const trashBytes = await dirSizeBytes(path.join(dataDir, '.trash'))
  const url = `http://${host.includes(':') ? `[${host}]` : host}:${port}`
  console.log(`cowrite v${version}`)
  console.log(
    `  config   ${configPath}  (high: ${laneStatus(config.models.high !== null)} · low: ${laneStatus(
      config.models.low !== null,
    )} · comfyui: ${laneStatus(config.comfyui !== null)})`,
  )
  console.log(
    `  data     ${dataDir}  (${workCount} work${workCount === 1 ? '' : 's'} · trash ${humanBytes(trashBytes)})`,
  )
  if (mockLlm !== null) {
    console.log(`  mock     in-process mock LLM at ${mockLlm.url} (both lanes; /__mock/* control)`)
  }
  if (mockComfy !== null) {
    console.log(`  mock     in-process mock ComfyUI at ${mockComfy.url} (always-succeed)`)
  }
  console.log(`  ➜ ${url}`)

  if (config.server.openBrowser && flags.noOpen !== true && process.stdout.isTTY) {
    openBrowser(url)
  }

  let shuttingDown = false
  const shutdown = (): void => {
    if (shuttingDown) return
    shuttingDown = true
    void (async () => {
      // §4.2: run the close path for every open work, then close the listener.
      await works.closeAll().catch(() => {})
      await app.close().catch(() => {})
      await mockLlm?.close().catch(() => {})
      await mockComfy?.close().catch(() => {})
      process.exit(0)
    })()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  // Windows console close delivers SIGHUP; run the same path (§10.3 signals row).
  process.on('SIGHUP', shutdown)
}

// Run only when invoked as a script (tsx src/index.ts) — importing this module must not
// boot a server.
const entry = process.argv[1]
if (entry !== undefined && path.resolve(entry) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
