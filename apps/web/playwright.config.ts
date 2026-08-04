import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig, devices } from '@playwright/test'
import { E2E_MOCK_LLM_PORT, E2E_PORT, E2E_URL } from './e2e/util'

/**
 * Playwright e2e config (docs/09-testing.md §6.1) — Windows-portable by construction:
 * env vars live in the `env` object (never inline `FOO=1 cmd`), temp dirs come from
 * `mkdtempSync` + `os.tmpdir()` (never `mktemp`/`/tmp`), URLs use `127.0.0.1` (never
 * `localhost`). The webServer is the REAL server (`pnpm --filter @cowrite/server start`)
 * serving the BUILT web app (`apps/web/dist`) — run `pnpm build` first.
 *
 * This file is evaluated once in the runner process and again in each worker; stashing
 * the freshly-minted temp dirs in `process.env` (inherited by workers) keeps every
 * process pointed at the SAME directories as the webServer.
 */

const dataDir = process.env.COWRITE_E2E_DATA_DIR ?? mkdtempSync(join(tmpdir(), 'cowrite-e2e-data-'))
process.env.COWRITE_E2E_DATA_DIR = dataDir
const homeDir = process.env.COWRITE_E2E_HOME ?? mkdtempSync(join(tmpdir(), 'cowrite-e2e-home-'))
process.env.COWRITE_E2E_HOME = homeDir

export default defineConfig({
  testDir: 'e2e',
  // One server, one shared data dir, spec 00 owns the first-run flow: strictly serial.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  reporter: [['list']],
  use: {
    baseURL: E2E_URL,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm --filter @cowrite/server start',
    env: {
      COWRITE_DATA_DIR: dataDir,
      COWRITE_HOME: homeDir,
      COWRITE_HOST: '127.0.0.1',
      COWRITE_PORT: String(E2E_PORT),
      // Stage 3 (docs/09 §2.3): the server boots @cowrite/mock-llm in-process and points
      // both lanes at it; the fixed port lets specs script POST /__mock/scenario.
      COWRITE_MOCK_LLM: '1',
      MOCK_LLM_PORT: String(E2E_MOCK_LLM_PORT),
    },
    url: `${E2E_URL}/api/health`, // readiness probe (docs/03-api.md §3.12)
    reuseExistingServer: false,
    timeout: 60_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
