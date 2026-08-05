import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { testids } from '../src/testids'

/**
 * Spec (d) — the `config_missing` path (docs/08-illustration.md §3, §8, §10; docs/04-frontend.md
 * §14): an unconfigured or broken ComfyUI setup must never even start a run — the harness
 * rejects the task at CREATE time (409 `config_missing`), which the UI turns into a blocking
 * toast naming the problem with an "Open Settings" link, and the settings health card names
 * the same problem in detail.
 *
 * This spec (like 60-restart.spec.ts) launches its OWN server process rather than the shared
 * webServer: the shared server always runs under `COWRITE_MOCK_LLM=1`, which boots a fully
 * working mock ComfyUI and overlays it onto EVERY `comfyui` config read — by design there is no
 * way to observe an unconfigured/broken ComfyUI while that flag is set. A standalone server with
 * the flag OFF gets a real (if deliberately unreachable/broken) `comfyui` block from its config
 * file, and `config_missing` is decided before any model or ComfyUI call, so the high/low
 * endpoints never need to be reachable either.
 */

const PORT = 2701
const URL_BASE = `http://127.0.0.1:${PORT}`
const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER_DIR = join(HERE, '..', '..', 'server')

const dataDir = mkdtempSync(join(tmpdir(), 'cowrite-e2e-configmissing-data-'))
const homeDir = mkdtempSync(join(tmpdir(), 'cowrite-e2e-configmissing-home-'))

function launchServer(): ChildProcess {
  return spawn(process.execPath, ['--import', 'tsx', join(SERVER_DIR, 'src', 'index.ts')], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      COWRITE_DATA_DIR: dataDir,
      COWRITE_HOME: homeDir,
      COWRITE_HOST: '127.0.0.1',
      COWRITE_PORT: String(PORT),
    },
    stdio: 'ignore',
  })
}

async function waitForHealth(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const res = await fetch(`${URL_BASE}/api/health`)
      if (res.ok) return
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`server on ${URL_BASE} never became healthy`)
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve()
    child.once('exit', () => resolve())
  })
}

let child: ChildProcess | null = null

test.afterAll(async () => {
  if (child !== null && child.exitCode === null) {
    child.kill()
    await waitForExit(child)
  }
})

test('config_missing: friendly toast + settings link, then the health card names the fault', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000)
  child = launchServer()
  await waitForHealth()

  // High/low configured with stub, deliberately unreachable endpoints — never called, since
  // config_missing on comfyui is decided before any model dispatch (05 §13, 08 §3).
  const configRes = await request.put(`${URL_BASE}/api/config`, {
    data: {
      models: {
        high: { baseUrl: 'http://127.0.0.1:9/v1', apiKey: '', model: 'stub-high' },
        low: { baseUrl: 'http://127.0.0.1:9/v1', apiKey: '', model: 'stub-low' },
      },
    },
  })
  expect(configRes.ok(), await configRes.text()).toBe(true)

  const workRes = await request.post(`${URL_BASE}/api/works`, { data: { title: 'Config Missing' } })
  expect(workRes.status()).toBe(201)
  const work = (await workRes.json()) as { id: string }

  // ---- scenario A: comfyui never configured (null) --------------------------------------
  await page.goto(`${URL_BASE}/w/${work.id}`)
  await page.getByTestId(testids.worldToggle).click()
  await page.getByTestId(testids.worldCreateName).fill('Storm Glass')
  await page.getByTestId(testids.worldCreateButton).click()
  await expect(page.getByTestId(testids.worldEntryDetail)).toBeVisible()

  await page.getByTestId(testids.worldImageGenerate).click()
  await page.getByTestId(testids.worldImageGuidanceSubmit).click()

  const toast = page.getByTestId(testids.toast).filter({ hasText: 'not configured' })
  await expect(toast).toBeVisible()
  const openSettings = toast.getByRole('button', { name: 'Open Settings' })
  await expect(openSettings).toBeVisible()

  // never even queued: no shimmer, no failure badge on the reserved slot
  await expect(page.getByTestId(testids.illustrationShimmer)).toHaveCount(0)

  await openSettings.click()
  await expect(page).toHaveURL(`${URL_BASE}/settings`)
  const healthA = page.getByTestId(testids.settingsComfyHealth)
  await expect(healthA).toContainText('not configured', { timeout: 10_000 })

  // the same rejection, asserted precisely at the API (409, code + message):
  const taskResA = await request.post(`${URL_BASE}/api/works/${work.id}/tasks`, {
    data: { kind: 'world-image', entryId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' },
  })
  expect(taskResA.status()).toBe(409)
  const bodyA = (await taskResA.json()) as { error: { code: string; message: string } }
  expect(bodyA.error.code).toBe('config_missing')
  expect(bodyA.error.message).toMatch(/comfyui/i)

  // ---- scenario B: comfyui configured, but the routed workflow is broken ----------------
  // PUT is a full-replace document (03 §9.5) — resend `models` alongside `comfyui`, or the
  // low lane would silently revert to unconfigured and mask the comfy-specific rejection.
  const comfyRes = await request.put(`${URL_BASE}/api/config`, {
    data: {
      models: {
        high: { baseUrl: 'http://127.0.0.1:9/v1', apiKey: '', model: 'stub-high' },
        low: { baseUrl: 'http://127.0.0.1:9/v1', apiKey: '', model: 'stub-low' },
      },
      comfyui: {
        baseUrl: 'http://127.0.0.1:9/',
        workflows: { default: { file: 'nonexistent.json', label: 'Default (broken)' } },
      },
    },
  })
  expect(comfyRes.ok(), await comfyRes.text()).toBe(true)

  const taskResB = await request.post(`${URL_BASE}/api/works/${work.id}/tasks`, {
    data: { kind: 'world-image', entryId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' },
  })
  expect(taskResB.status()).toBe(409)
  const bodyB = (await taskResB.json()) as { error: { code: string; message: string } }
  expect(bodyB.error.code).toBe('config_missing')
  expect(bodyB.error.message).toMatch(/workflow file not found/i)

  const healthResB = await request.get(`${URL_BASE}/api/illustration/health`)
  expect(healthResB.ok()).toBe(true)
  const healthBodyB = (await healthResB.json()) as {
    workflows: Array<{ name: string; ok: boolean; error?: string }>
    route: { section: { ok: boolean }; world: { ok: boolean } }
  }
  expect(healthBodyB.workflows).toContainEqual(
    expect.objectContaining({ name: 'default', ok: false }),
  )
  expect(healthBodyB.route.section.ok).toBe(false)
  expect(healthBodyB.route.world.ok).toBe(false)

  await page.reload()
  const healthB = page.getByTestId(testids.settingsComfyHealth)
  await expect(healthB).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId(testids.settingsComfyWorkflowRow)).toContainText(
    /not found|invalid/i,
  )
  await expect(healthB).toContainText('default')
})
