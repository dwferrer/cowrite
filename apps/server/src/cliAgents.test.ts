import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ContextSnapshot } from '@cowrite/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type CliRuntime,
  createCliRuntime,
  formatRunEvent,
  listRunIds,
  promptRenderCommand,
  runsListCommand,
  runsShowCommand,
  runTaskCommand,
  type TaskCommandResult,
} from './cliAgents.js'
import { createStorage } from './storage/service.js'

/**
 * The Stage-3 agent CLI against the in-process mock LLM (docs/09 §2.3): one fixture work
 * in a temp data dir, one runtime whose lanes point at `@cowrite/mock-llm`, and the
 * exported command functions driven directly with a captured `out` writer — the same
 * code the `pnpm cli` entry dispatches to.
 */

function capture(): { out: (text: string) => void; text: () => string } {
  const chunks: string[] = []
  return { out: (text) => chunks.push(text), text: () => chunks.join('') }
}

describe('agent CLI commands (mock-llm end to end)', () => {
  let dataDir: string
  let slug: string
  let rt: CliRuntime
  let firstSnippetId: string

  beforeAll(async () => {
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cowrite-cli-agents-'))
    const storage = createStorage(dataDir)
    const created = await storage.createWork('Mock Voyage')
    slug = created.slug
    const handle = await storage.openWork(slug)
    const situation = await handle.getSituation()
    await handle.putSituation('Mara sails the glass sea toward the dark lighthouse.', {
      baseHash: situation.hash,
    })
    const first = await handle.appendSnippet(
      'Mara pressed her palm against the hull and listened to the sea breathe.',
      { author: 'user' },
    )
    firstSnippetId = first.id
    await handle.appendSnippet('The lighthouse blinked twice, then went dark.', {
      author: 'user',
    })
    await handle.close() // release the work lock before the runtime's registry opens it

    rt = await createCliRuntime({
      dataDir,
      // Point config at a nonexistent file inside the temp dir: mock mode tolerantly
      // loads (missing file ⇒ defaults) without ever touching a developer's real config.
      env: { COWRITE_MOCK_LLM: '1', COWRITE_CONFIG: path.join(dataDir, 'config.jsonc') },
      laneDeps: { sleepImpl: async () => {} },
    })
  })

  afterAll(async () => {
    await rt.close()
    await fsp.rm(dataDir, { recursive: true, force: true })
  })

  // -- prompt render (golden-ish: region ordering, no model call) -------------------

  it('prompt render prints system + user messages with regions in order, without any model call', async () => {
    const requestsBefore = rt.mockLlm?.requests.length ?? 0
    const cap = capture()
    await promptRenderCommand(rt, slug, { kind: 'continue', json: false, out: cap.out })
    const text = cap.text()

    // Both chat messages, system first.
    const systemAt = text.indexOf('──── system')
    const userAt = text.indexOf('──── user')
    expect(systemAt).toBeGreaterThanOrEqual(0)
    expect(userAt).toBeGreaterThan(systemAt)

    // Region markup present and in the 06 §5.1 stability order. Match line-anchored
    // opening tags only — the system prompt and the instructions body name-drop the
    // region tags mid-sentence.
    const instructionsAt = text.indexOf('<instructions>\n', userAt)
    const situationAt = text.indexOf('\n<situation>\n', userAt)
    const localAt = text.indexOf('\n<local-context>\n', userAt)
    expect(instructionsAt).toBeGreaterThan(userAt)
    expect(situationAt).toBeGreaterThan(instructionsAt)
    expect(localAt).toBeGreaterThan(situationAt)

    // The frontier prose is in the prompt; the mock never saw a request.
    expect(text).toContain('Mara pressed her palm against the hull')
    expect(rt.mockLlm?.requests.length ?? 0).toBe(requestsBefore)
    expect(rt.mockLlm?.scenario.pending).toBe(0)
  })

  it('prompt render --json prints the ContextSnapshot (regions + per-item fidelity/tokens)', async () => {
    const requestsBefore = rt.mockLlm?.requests.length ?? 0
    const cap = capture()
    await promptRenderCommand(rt, slug, { kind: 'continue', json: true, out: cap.out })
    const snapshot = ContextSnapshot.parse(JSON.parse(cap.text()))
    const names = snapshot.regions.map((r) => r.name)
    expect(names.indexOf('instructions')).toBeGreaterThanOrEqual(0)
    expect(names.indexOf('local-context')).toBeGreaterThan(names.indexOf('instructions'))
    for (const item of snapshot.items) {
      expect(item.tokens).toBeGreaterThan(0)
      expect(['name', 'short', 'long', 'full']).toContain(item.fidelity)
    }
    expect(rt.mockLlm?.requests.length ?? 0).toBe(requestsBefore)
  })

  // -- continue: the real harness path, stdout stream captured ----------------------

  let continueResult: TaskCommandResult
  let continueOutput: string

  it('continue streams the composition to stdout and commits the snippet', async () => {
    const cap = capture()
    continueResult = await runTaskCommand(rt, slug, { kind: 'continue' }, { out: cap.out })
    continueOutput = cap.text()

    expect(continueResult.status).toBe('done')
    // The block interior streamed; the tag markup never reached stdout.
    expect(continueOutput).toContain('The mock model continues the story')
    expect(continueOutput).not.toContain('<snippet')
    // Summary: committed artifact + usage + runId.
    expect(continueOutput).toMatch(/committed snippet 01[0-9A-HJKMNP-TV-Z]{24}/)
    expect(continueOutput).toMatch(/usage: \d+ prompt \+ \d+ completion tok/)
    expect(continueOutput).toContain(`run ${continueResult.runId}`)

    // Storage really committed it, with agent authorship + run provenance.
    const open = await rt.openBySlug(slug)
    const committed = open.handle
      .listSnippets()
      .find((row) => row.originRunId === continueResult.runId)
    expect(committed).toBeDefined()
    expect(committed?.authorship).toBe('agent')
    // The scripted scenario was consumed exactly.
    rt.mockLlm?.scenario.assertDrained()
  })

  it('quick-edit reports before/after word counts and the committed revision', async () => {
    const cap = capture()
    const result = await runTaskCommand(
      rt,
      slug,
      { kind: 'quick-edit', snippetId: firstSnippetId, instruction: 'make it terser' },
      { out: cap.out },
    )
    const text = cap.text()
    expect(result.status).toBe('done')
    expect(text).toContain(`committed snippet-revision ${firstSnippetId} rev 2`)
    expect(text).toMatch(/words: \d+ -> \d+/)

    const open = await rt.openBySlug(slug)
    const after = await open.handle.getSnippet(firstSnippetId)
    expect(after.rev).toBe(2)
    expect(after.text).toContain('The mock model rewrites the target snippet')
  })

  // -- runs list / runs show --------------------------------------------------------

  it('runs list summarizes from boundary lines only — no full-transcript reads', async () => {
    const open = await rt.openBySlug(slug)
    // A post-result proposal-resolution line (the 02 §write-once carve-out): the result
    // is then NOT the final line, and the listing must still find it in the tail window.
    const events = await open.handle.readRun(continueResult.runId)
    const meta = events.find((e) => e.type === 'meta')
    if (meta?.type !== 'meta') throw new Error('run lost its meta line')
    const sink = await open.handle.recordRun(continueResult.runId, meta.startedAt)
    await sink.append({ type: 'proposal', resolution: 'discarded', at: new Date().toISOString() })

    const realReadRun = open.handle.readRun
    let readRunCalls = 0
    ;(open.handle as { readRun: typeof realReadRun }).readRun = async (runId) => {
      readRunCalls += 1
      return realReadRun.call(open.handle, runId)
    }
    const cap = capture()
    try {
      await runsListCommand(rt, slug, cap.out)
    } finally {
      ;(open.handle as { readRun: typeof realReadRun }).readRun = realReadRun
    }
    expect(readRunCalls).toBe(0) // boundary + tail reads, never the whole file

    const text = cap.text()
    expect(text).toContain(continueResult.runId)
    expect(text).toContain('continue')
    expect(text).toContain('ok') // the result was found behind the proposal line

    const ids = await listRunIds(open.handle.workDir)
    expect(ids).toContain(continueResult.runId)
  })

  it('runs show prints the summarized transcript; --full prints message texts', async () => {
    const summary = capture()
    await runsShowCommand(rt, slug, continueResult.runId, { full: false, out: summary.out })
    const text = summary.text()
    expect(text).toContain(`run ${continueResult.runId}`)
    expect(text).toMatch(/meta {6}continue {2}lane high {2}model mock-high/)
    expect(text).toContain('context:')
    expect(text).toMatch(/message {3}system \(\d+ chars\)/)
    expect(text).toMatch(/result {4}ok/)
    expect(text).toMatch(/artifacts: snippet 01[0-9A-HJKMNP-TV-Z]{24} rev \d+ \(committed\)/)
    // Summarized mode previews, never dumps, the prompt.
    expect(text).not.toContain('## Reading the prompt')

    const full = capture()
    await runsShowCommand(rt, slug, continueResult.runId, { full: true, out: full.out })
    expect(full.text()).toContain('## Reading the prompt') // the system prompt, verbatim
  })
})

describe('formatRunEvent', () => {
  it('formats usage, stage, and attempt lines', () => {
    expect(
      formatRunEvent(
        {
          type: 'usage',
          promptTokens: 120,
          completionTokens: 34,
          estimated: false,
          call: 'writing',
        },
        { full: false },
      ),
    ).toBe('usage     writing  120+34 tok')
    expect(formatRunEvent({ type: 'stage', stage: 'writing', round: 0 }, { full: false })).toBe(
      'stage     writing (round 0)',
    )
    expect(formatRunEvent({ type: 'attempt', n: 2, reason: 'timeout' }, { full: false })).toBe(
      'attempt   #2 (timeout)',
    )
  })

  it('previews message text in summary mode and indents it in --full mode', () => {
    const event = { type: 'message', role: 'user', text: 'line one\nline two' } as const
    expect(formatRunEvent(event, { full: false })).toBe(
      'message   user (17 chars): "line one line two"',
    )
    expect(formatRunEvent(event, { full: true })).toBe(
      'message   user (17 chars)\n    | line one\n    | line two',
    )
  })

  it('formats an error result with its artifacts and partial text', () => {
    const line = formatRunEvent(
      {
        type: 'result',
        status: 'error',
        error: { code: 'timeout', message: 'the model went away' },
        usageTotal: { promptTokens: 10, completionTokens: 5, estimated: false },
        partialText: 'half a sentence',
        artifacts: [],
        endedAt: '2026-08-03T00:00:00.000Z',
      },
      { full: false },
    )
    expect(line).toContain('result    error  [timeout] the model went away')
    expect(line).toContain('10+5 tok')
    expect(line).toContain('artifacts: none')
    expect(line).toContain('partial: "half a sentence"')
  })
})

describe('mock-mode config fallback at the CLI root (docs/09 §2.3 overlay semantic)', () => {
  it('an invalid config under mock mode warns and runs on defaults; without mock it is fatal', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cowrite-cli-fallback-'))
    const configPath = path.join(dir, 'config.jsonc')
    await fsp.writeFile(configPath, '{ "server": { "port": "definitely-not-a-port" } }')
    const warned: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warned.push(args.map(String).join(' '))
    }
    try {
      const runtime = await createCliRuntime({
        dataDir: dir,
        env: { COWRITE_MOCK_LLM: '1', COWRITE_CONFIG: configPath },
        laneDeps: { sleepImpl: async () => {} },
      })
      try {
        expect(runtime.mockLlm).not.toBeNull() // mock booted despite the broken file
        expect(runtime.config.models.high?.model).toBe('mock-high') // lanes overlaid
        expect(runtime.config.server.port).toBe(2697) // schema default, not the junk value
        expect(warned.join('\n')).toContain('running on defaults under mock mode')
      } finally {
        await runtime.close()
      }

      // The SAME file without mock mode stays fatal (config rot must not hide).
      await expect(
        createCliRuntime({ dataDir: dir, env: { COWRITE_CONFIG: configPath } }),
      ).rejects.toThrow(/invalid config/)
    } finally {
      console.warn = originalWarn
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })
})
