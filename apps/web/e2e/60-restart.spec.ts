import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'

/**
 * Spec (f) — server-restart survival (docs/09-testing.md §6.2 "the resilience spec is the
 * exception"): the shared Playwright webServer cannot be bounced mid-run, so this spec
 * launches its OWN server process (no shell, own temp dirs, own port), writes through the
 * API, kills the process hard, restarts it on the same data dir, and asserts everything
 * came back from disk.
 */

const PORT = 2699
const URL_BASE = `http://127.0.0.1:${PORT}`
const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER_DIR = join(HERE, '..', '..', 'server')

const dataDir = mkdtempSync(join(tmpdir(), 'cowrite-e2e-restart-data-'))
const homeDir = mkdtempSync(join(tmpdir(), 'cowrite-e2e-restart-home-'))

function launchServer(): ChildProcess {
  // node --import tsx <entry> — one process, no pnpm/shell wrapper, so kill() reaches
  // the actual server (a wrapper would orphan it on Windows).
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

test('a hard-killed server comes back with every write intact', async () => {
  test.setTimeout(120_000)
  child = launchServer()
  await waitForHealth()

  // write through the real API
  const createRes = await fetch(`${URL_BASE}/api/works`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Restart Survivor' }),
  })
  expect(createRes.status).toBe(201)
  const work = (await createRes.json()) as { id: string; slug: string }
  const text = 'Written moments before the crash, read moments after.'
  const snippetRes = await fetch(`${URL_BASE}/api/works/${work.id}/snippets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  })
  expect(snippetRes.status).toBe(201)

  // hard kill (TerminateProcess on Windows — no graceful shutdown path runs)
  child.kill()
  await waitForExit(child)

  // restart on the same data dir; lock staleness (dead pid) must clear on open
  child = launchServer()
  await waitForHealth()

  const listRes = await fetch(`${URL_BASE}/api/works`)
  expect(listRes.ok).toBe(true)
  const works = (await listRes.json()) as Array<{ id: string; title: string }>
  expect(works.some((w) => w.id === work.id && w.title === 'Restart Survivor')).toBe(true)

  const snippetsRes = await fetch(`${URL_BASE}/api/works/${work.id}/snippets`)
  expect(snippetsRes.ok).toBe(true)
  const snippets = (await snippetsRes.json()) as Array<{ text: string }>
  expect(snippets.length).toBe(1)
  expect(snippets[0]?.text).toBe(text)

  // writes are still editable after recovery (the lock was reacquired, not read-only)
  const situationRes = await fetch(`${URL_BASE}/api/works/${work.id}/situation`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'post-restart note', baseHash: null }),
  })
  expect(situationRes.ok).toBe(true)
  expect(readFileSync(join(dataDir, 'works', work.slug, 'situation.md'), 'utf8')).toBe(
    'post-restart note',
  )
})
