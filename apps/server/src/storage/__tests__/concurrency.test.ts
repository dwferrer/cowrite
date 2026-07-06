import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ulid } from 'ulid'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { readIfExists, sweepTmpFiles, writeFileAtomic } from '../lib/fsx.js'
import { frontierRevisionsDir, frontierSnippetsDir } from '../lib/paths.js'
import { createStorage, type StorageService, type WorkHandle } from '../service.js'
import { readSnippet } from '../snippetStore.js'

/**
 * Concurrency & crash-safety hardening (spec 02 §6.6, §9.1, §12): interleaved
 * reviseSnippet calls through the service mutex (no revision ever lost, conflicts
 * surface as typed results, never thrown), crash-mid-atomic-write with an injected
 * failure between tmp-write and rename (target intact, sweepTmpFiles clears the
 * orphan), and torn JSONL tails (readers drop them; the snippet .md stays
 * authoritative).
 */

describe('interleaved reviseSnippet through the service mutex (§6.6)', () => {
  let dataDir: string
  let storage: StorageService
  let handle: WorkHandle

  beforeAll(async () => {
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cowrite-conc-'))
    storage = createStorage(dataDir)
    const created = await storage.createWork('Concurrency Probe')
    handle = await storage.openWork(created.slug)
  })

  afterAll(async () => {
    await handle.close().catch(() => {})
    await fsp.rm(dataDir, { recursive: true, force: true })
  })

  it('same-baseRev racers: exactly one wins, the rest get the typed conflict', async () => {
    const meta = await handle.appendSnippet('Race target, original text.', { author: 'user' })

    const texts = [0, 1, 2, 3, 4].map((i) => `Racer ${i} text.`)
    const results = await Promise.all(
      texts.map((text, i) =>
        handle.reviseSnippet(meta.id, text, {
          author: i % 2 === 0 ? 'user' : 'agent',
          ...(i % 2 === 0 ? {} : { runId: ulid() }),
          baseRev: 1, // everyone raced from the same base
        }),
      ),
    )

    const wins = results.filter((r) => r.ok)
    const losses = results.filter((r) => !r.ok)
    expect(wins).toHaveLength(1)
    expect(wins[0]).toEqual({ ok: true, rev: 2, filePath: expect.any(String) })
    const winnerText = texts[results.findIndex((r) => r.ok)]
    expect(losses).toHaveLength(4)
    for (const loss of losses) {
      // typed result, never a throw: the §6.6 conflict carries the current state
      expect(loss).toEqual({
        ok: false,
        conflict: { currentRev: 2, currentText: winnerText },
      })
    }

    const revisions = await handle.getRevisions(meta.id)
    expect(revisions).toHaveLength(2) // losers appended nothing
    expect(revisions[1]?.text).toBe(winnerText)
    expect(handle.listSnippets().find((r) => r.id === meta.id)?.rev).toBe(2)
  })

  it('conflict-retry writers all land: no revision is ever lost', async () => {
    const meta = await handle.appendSnippet('Retry target, original text.', { author: 'user' })

    const writers = [0, 1, 2, 3, 4, 5].map((i) => `Writer ${i} contribution.`)
    const write = async (text: string): Promise<number> => {
      let baseRev = 1
      for (let attempt = 0; attempt < 20; attempt++) {
        const res = await handle.reviseSnippet(meta.id, text, { author: 'user', baseRev })
        if (res.ok) return res.rev
        baseRev = res.conflict.currentRev // observe, rebase, retry
      }
      throw new Error('retry budget exhausted')
    }
    const finalRevs = await Promise.all(writers.map((text) => write(text)))

    // every writer landed on a distinct revision; nothing was silently merged or lost
    expect([...finalRevs].sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7])
    const revisions = await handle.getRevisions(meta.id)
    expect(revisions.map((e) => e.rev)).toEqual([1, 2, 3, 4, 5, 6, 7])
    const logged = revisions.slice(1).map((e) => e.text)
    expect([...logged].sort()).toEqual([...writers].sort())

    // file, index, and log tip all agree
    const row = handle.listSnippets().find((r) => r.id === meta.id)
    expect(row?.rev).toBe(7)
    expect(row?.revisionCount).toBe(7)
    const file = await readSnippet(handle.workDir, meta.id)
    expect(file.meta.rev).toBe(7)
    expect(file.text).toBe(revisions[6]?.text)
  })

  it('concurrent appends and revises settle with rev == log length for every snippet', async () => {
    const a = await handle.appendSnippet('Mixed-load snippet A.', { author: 'user' })
    const results = await Promise.all([
      handle.reviseSnippet(a.id, 'A revised once.', { author: 'user', baseRev: 1 }),
      handle.appendSnippet('Mixed-load snippet B.', { author: 'user' }),
      handle.reviseSnippet(a.id, 'A revised twice.', { author: 'user', baseRev: 2 }),
      handle.appendSnippet('Mixed-load snippet C.', { author: 'agent', runId: ulid() }),
    ])
    expect(results[0]).toEqual({ ok: true, rev: 2, filePath: expect.any(String) })
    // FIFO mutex: the second revise queued behind the first and saw its bump
    expect(results[2]).toEqual({ ok: true, rev: 3, filePath: expect.any(String) })

    for (const row of handle.listSnippets()) {
      const revisions = await handle.getRevisions(row.id)
      expect(row.rev).toBe(revisions.length)
      expect(row.revisionCount).toBe(revisions.length)
    }
  })
})

describe('crash mid atomic write (§9.1)', () => {
  let dir: string

  beforeAll(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cowrite-crash-'))
  })

  afterAll(async () => {
    await fsp.rm(dir, { recursive: true, force: true })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('injected failure between tmp-write and rename leaves the target intact; sweep clears the orphan', async () => {
    const target = path.join(dir, 'note.md')
    await writeFileAtomic(target, 'the original, durable text')

    // Simulate a hard crash in the §9.1 window: the tmp file is fully written but the
    // rename never happens — and neither does any in-process cleanup (unlink also dies).
    vi.spyOn(fsp, 'rename').mockRejectedValueOnce(new Error('injected crash before rename'))
    vi.spyOn(fsp, 'unlink').mockRejectedValueOnce(new Error('injected crash before cleanup'))
    await expect(writeFileAtomic(target, 'the write that never lands')).rejects.toThrow(
      'injected crash before rename',
    )
    vi.restoreAllMocks()

    // target untouched, orphan tmp left behind — exactly what a kill would leave
    expect(await readIfExists(target)).toBe('the original, durable text')
    const orphans = (await fsp.readdir(dir)).filter((n) => n.includes('.tmp-'))
    expect(orphans).toHaveLength(1)
    expect(await readIfExists(path.join(dir, orphans[0] ?? ''))).toBe('the write that never lands')

    // the startup sweep (§9.1) removes the orphan and only the orphan
    const removed = await sweepTmpFiles(dir)
    expect(removed).toEqual([path.join(dir, orphans[0] ?? '')])
    expect((await fsp.readdir(dir)).sort()).toEqual(['note.md'])
    expect(await readIfExists(target)).toBe('the original, durable text')
  })

  it('openWork sweeps crash-orphaned tmp files across the whole tree', async () => {
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cowrite-sweep-'))
    try {
      const storage = createStorage(dataDir)
      const created = await storage.createWork('Sweep Probe')
      let handle = await storage.openWork(created.slug)
      const meta = await handle.appendSnippet('Survivor snippet.', { author: 'user' })
      await handle.close()

      const snippetsDir = frontierSnippetsDir(created.dirPath)
      const orphan = path.join(snippetsDir, `010.zzzzzz.md.tmp-${ulid()}`)
      await fsp.writeFile(orphan, 'half-written snippet bytes')

      handle = await storage.openWork(created.slug)
      try {
        expect(await readIfExists(orphan)).toBeNull() // swept at open
        expect(handle.listSnippets().map((r) => r.id)).toEqual([meta.id]) // never indexed
      } finally {
        await handle.close()
      }
    } finally {
      await fsp.rm(dataDir, { recursive: true, force: true })
    }
  })
})

describe('torn JSONL revision-log tails (§9.1)', () => {
  let dataDir: string
  let handle: WorkHandle
  let workDir: string

  beforeAll(async () => {
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cowrite-torn-'))
    const storage = createStorage(dataDir)
    const created = await storage.createWork('Torn Tail Probe')
    workDir = created.dirPath
    handle = await storage.openWork(created.slug)
  })

  afterAll(async () => {
    await handle.close().catch(() => {})
    await fsp.rm(dataDir, { recursive: true, force: true })
  })

  it('drops a torn tail on read; the snippet .md stays authoritative; appends heal the log', async () => {
    const meta = await handle.appendSnippet('Torn-tail original.', { author: 'user' })
    const ok = await handle.reviseSnippet(meta.id, 'Torn-tail revised.', {
      author: 'user',
      baseRev: 1,
    })
    expect(ok).toEqual({ ok: true, rev: 2, filePath: expect.any(String) })

    // crash mid-append: an unterminated half line at the end of the log (§9.1)
    const logPath = path.join(frontierRevisionsDir(workDir), `${meta.id}.jsonl`)
    await fsp.appendFile(logPath, '{"type":"revision","rev":3,"ts":"2026-07-06T14:0')

    // readers drop the torn line…
    const revisions = await handle.getRevisions(meta.id)
    expect(revisions.map((e) => e.rev)).toEqual([1, 2])
    expect(revisions[1]?.text).toBe('Torn-tail revised.')

    // …and the .md file remains the authority for current text and rev
    const file = await readSnippet(workDir, meta.id)
    expect(file.meta.rev).toBe(2)
    expect(file.text).toBe('Torn-tail revised.')

    // the reconciler recounts revisions from complete lines only
    await handle.reconcile()
    const row = handle.listSnippets().find((r) => r.id === meta.id)
    expect(row?.rev).toBe(2)
    expect(row?.revisionCount).toBe(2)

    // a subsequent revise physically drops the torn tail before appending, so the log
    // ends up fully valid — no fused mid-file corruption
    const healed = await handle.reviseSnippet(meta.id, 'Torn-tail healed.', {
      author: 'user',
      baseRev: 2,
    })
    expect(healed).toEqual({ ok: true, rev: 3, filePath: expect.any(String) })
    const raw = (await readIfExists(logPath)) ?? ''
    const lines = raw.split('\n').filter((l) => l !== '')
    expect(raw.endsWith('\n')).toBe(true)
    expect(lines).toHaveLength(3)
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow()
    expect((await handle.getRevisions(meta.id)).map((e) => e.rev)).toEqual([1, 2, 3])
  })

  it('tolerates a torn tail that is valid JSON but unterminated', async () => {
    const meta = await handle.appendSnippet('Second torn snippet.', { author: 'user' })
    const logPath = path.join(frontierRevisionsDir(workDir), `${meta.id}.jsonl`)
    // complete JSON, missing the trailing newline: still torn by definition (§9.1 —
    // only a line ending in '\n' is a committed append)
    await fsp.appendFile(
      logPath,
      '{"type":"revision","rev":2,"ts":"2026-07-06T15:00:00Z","author":"user","text":"phantom"}',
    )
    expect((await handle.getRevisions(meta.id)).map((e) => e.rev)).toEqual([1])
    const file = await readSnippet(workDir, meta.id)
    expect(file.meta.rev).toBe(1)
    expect(file.text).toBe('Second torn snippet.')
  })
})
