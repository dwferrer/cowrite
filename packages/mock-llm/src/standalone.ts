/**
 * Standalone entry: boots the mock LLM and/or mock ComfyUI as real processes so e2e suites
 * (and manual poking) can spawn them: `pnpm --filter @cowrite/mock-llm standalone`, or from
 * the repo root `pnpm mock:llm` / `pnpm mock:comfy`.
 *
 * Flags: `--only llm|comfy`, `--llm-port N`, `--comfy-port N` (0 = ephemeral, the default;
 * env fallbacks MOCK_LLM_PORT / MOCK_COMFY_PORT). Prints exactly one JSON line to stdout —
 * `{"llm":{"url","port"},"comfy":{"url","port"}}` — so a spawner can parse the addresses,
 * then serves until SIGINT/SIGTERM. Scripting happens over `POST /__mock/scenario`.
 */
import process from 'node:process'
import { createMockComfy } from './comfy.js'
import { createMockLlm } from './server.js'

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  if (index === -1 || index + 1 >= process.argv.length) return undefined
  return process.argv[index + 1]
}

function portFrom(flag: string, envName: string): number {
  const raw = argValue(flag) ?? process.env[envName] ?? '0'
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write(`${flag}/${envName}: invalid port ${JSON.stringify(raw)}\n`)
    process.exit(2)
  }
  return port
}

async function main(): Promise<void> {
  const only = argValue('--only')
  if (only !== undefined && only !== 'llm' && only !== 'comfy') {
    process.stderr.write(`unknown --only value ${JSON.stringify(only)}; expected llm or comfy\n`)
    process.exit(2)
  }

  const llm =
    only === 'comfy'
      ? undefined
      : await createMockLlm({ port: portFrom('--llm-port', 'MOCK_LLM_PORT') })
  const comfy =
    only === 'llm'
      ? undefined
      : await createMockComfy({
          port: portFrom('--comfy-port', 'MOCK_COMFY_PORT'),
          autoSucceed: true,
        })

  const announce: Record<string, { url: string; port: number }> = {}
  if (llm) announce.llm = { url: llm.url, port: llm.port }
  if (comfy) announce.comfy = { url: comfy.url, port: comfy.port }
  process.stdout.write(`${JSON.stringify(announce)}\n`)

  let closing = false
  const shutdown = (): void => {
    if (closing) return
    closing = true
    Promise.all([llm?.close(), comfy?.close()]).then(
      () => process.exit(0),
      () => process.exit(1),
    )
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
  process.exit(1)
})
