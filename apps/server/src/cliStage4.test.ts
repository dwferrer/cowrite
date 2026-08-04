import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type CliRuntime,
  consolidateCommand,
  createCliRuntime,
  enrichCommand,
  undoConsolidationCommand,
} from './cliAgents.js'
import { consolidation, PAGE, settingsWith } from './harness/stage4Fixtures.js'
import { createStorage } from './storage/service.js'

/**
 * The Stage-4 CLI commands against the in-process mock LLM (docs/10 §Stage 1 dev-CLI
 * note): `consolidate` (evaluate and force), `undo-consolidation`, and `enrich`, driven
 * through the exported command functions with a captured `out` writer — the same code
 * the `pnpm cli` entry dispatches to. Mock mode scripts one deterministic mid-prefix
 * boundary cut and canned enrich blocks; the scenario queue is strict throughout.
 */

function capture(): { out: (text: string) => void; text: () => string } {
  const chunks: string[] = []
  return { out: (text) => chunks.push(text), text: () => chunks.join('') }
}

const TIGHT_SETTINGS = settingsWith(
  consolidation({
    maxFrontierSnippets: 4,
    activeWindowSnippets: 1,
    debounceMs: 600_000, // manual paths only — the auto debounce stays cold
  }),
)

describe('Stage-4 CLI commands (mock-llm end to end)', () => {
  let dataDir: string
  let slug: string
  let rt: CliRuntime
  let undoToken: string
  let snippetCount: number

  beforeAll(async () => {
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cowrite-cli-stage4-'))
    const storage = createStorage(dataDir)
    const created = await storage.createWork('Ferry Crossing')
    slug = created.slug
    const handle = await storage.openWork(slug)
    for (let i = 0; i < 8; i++) {
      await handle.appendSnippet(`${PAGE} (leg ${i + 1})`, { author: 'user' })
    }
    snippetCount = 8
    await handle.close() // release the lock before the runtime's registry opens it

    rt = await createCliRuntime({
      dataDir,
      env: { COWRITE_MOCK_LLM: '1', COWRITE_CONFIG: path.join(dataDir, 'config.jsonc') },
      laneDeps: { sleepImpl: async () => {} },
    })
  })

  afterAll(async () => {
    await rt.close()
    await fsp.rm(dataDir, { recursive: true, force: true })
  })

  it('consolidate reports idle below the default thresholds', async () => {
    const { out, text } = capture()
    const result = await consolidateCommand(rt, slug, { now: false, out })
    expect(result.status).toBe('idle')
    expect(text()).toContain('idle: below thresholds')
    expect(text()).toContain(`${snippetCount} snippet(s)`)
  })

  it('consolidate reports the eligible prefix once over thresholds', async () => {
    const open = await rt.openBySlug(slug)
    await open.handle.updateWork({ settings: TIGHT_SETTINGS })

    const { out, text } = capture()
    const result = await consolidateCommand(rt, slug, { now: false, out })
    expect(result.status).toBe('needs-boundaries')
    // 8 snippets − active window (1) = 7 eligible.
    expect(text()).toContain('7 snippet(s) eligible')
    expect(text()).toContain('--now')
  })

  it('consolidate --now runs the scripted boundary agent, applies, and reports enrichment', async () => {
    const { out, text } = capture()
    const result = await consolidateCommand(rt, slug, { now: true, out })
    expect(result.status, text()).toBe('applied')
    expect(result.sectionIds).toHaveLength(1)
    expect(result.undoToken).not.toBeNull()
    undoToken = result.undoToken as string
    expect(text()).toContain('boundary agent running over 7 eligible snippet(s)')
    expect(text()).toContain('applied (boundary proposal): 1 section(s) frozen')
    expect(text()).toContain(`undo-consolidation ${slug} ${undoToken}`)
    // The scripted enrich landed: title + both summaries current.
    expect(text()).toContain('"Mock Chapter"')
    expect(text()).toContain('short ok, long ok')

    // The mid-prefix cut (after eligible index 3) consumed 4 snippets.
    const open = await rt.openBySlug(slug)
    expect(open.handle.listSnippets()).toHaveLength(4)
    expect(open.handle.listSections()).toHaveLength(1)
  })

  it('undo-consolidation restores the frontier inside the grace window', async () => {
    const { out, text } = capture()
    await undoConsolidationCommand(rt, slug, undoToken, out)
    expect(text()).toContain('undone: 1 section(s) removed, 4 snippet(s) restored')

    const open = await rt.openBySlug(slug)
    expect(open.handle.listSnippets()).toHaveLength(8)
    expect(open.handle.listSections()).toHaveLength(0)

    // A second undo of the consumed token is the storage layer's typed conflict.
    await expect(
      undoConsolidationCommand(rt, slug, undoToken, capture().out),
    ).rejects.toMatchObject({ code: 'conflict' })
  })

  it('enrich forces one section, and reports nothing stale when all is current', async () => {
    // Re-freeze a chapter to have an enrichment target again.
    const again = await consolidateCommand(rt, slug, { now: true, out: capture().out })
    expect(again.status).toBe('applied')
    const sectionId = again.sectionIds[0] as string

    // Everything is freshly enriched: the bulk form has nothing to do.
    const bulk = capture()
    const none = await enrichCommand(rt, slug, { out: bulk.out })
    expect(none.results).toHaveLength(0)
    expect(bulk.text()).toContain('nothing stale')

    // --section forces a re-run regardless of staleness.
    const forced = capture()
    const one = await enrichCommand(rt, slug, { sectionId, out: forced.out })
    expect(one.results).toEqual([{ sectionId, status: 'done' }])
    expect(forced.text()).toContain('enrich queued')
    expect(forced.text()).toContain('short ok, long ok')
  })
})
