import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ulid } from 'ulid'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { StorageChange } from './events.js'
import { openIndex } from './index/db.js'
import { buildFixtureWork } from './index/fixture.js'
import { xxh64OfString } from './lib/hash.js'
import { indexPath, lockPath, runsDir, shortId } from './lib/paths.js'
import {
  createStorage,
  NotImplementedError,
  ReadOnlyError,
  type StorageService,
  type WorkHandle,
} from './service.js'

/**
 * End-to-end integration of the storage top layer (spec 02 §11) against a real temp
 * dataDir: lifecycle, ordering incl. reserved keys (§4), the optimistic-concurrency
 * contract (§6.6), world matching (§2.6), run provenance (§10.7), external edits via the
 * reconciler (§8), the files-are-truth rebuild invariant (§1, §7.3), and the
 * single-writer lock (§9.3). Tests in this suite run in order and share one work.
 */
describe('storage service end-to-end', () => {
  let dataDir: string
  let storage: StorageService
  let handle: WorkHandle
  let slug: string
  let workDirPath: string
  const events: StorageChange[] = []

  // entity ids threaded through the ordered tests
  let s1 = '' // first user snippet
  let s2 = '' // user snippet appended while a reservation was live
  let s3 = '' // agent snippet committed at the reserved key
  let entryId = ''
  let secId = ''
  let secDirName = ''
  const runId = ulid()
  const agentRunId = ulid()

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'cowrite-service-'))
    storage = createStorage(dataDir)
    const created = await storage.createWork('Salt and Signal')
    slug = created.slug
    workDirPath = created.dirPath
    handle = await storage.openWork(slug)
    handle.onChange((e) => events.push(e))
  })

  afterAll(async () => {
    await handle.close().catch(() => {})
    await rm(dataDir, { recursive: true, force: true })
  })

  it('creates and lists the work', async () => {
    const works = await storage.listWorks()
    expect(works).toHaveLength(1)
    expect(works[0]).toMatchObject({ slug, ok: true })
    expect(handle.readOnly).toBe(false)
    expect(handle.work.title).toBe('Salt and Signal')
  })

  it('orders appends around a reserved key per §4', async () => {
    s1 = (await handle.appendSnippet('First snippet words.', { author: 'user' })).id

    // The harness reserves a key at task start; a user append while the agent streams
    // must land AFTER the reservation (§4).
    const reserved = await handle.reserveOrderKey()
    s2 = (await handle.appendSnippet('User snippet typed mid-run.', { author: 'user' })).id
    s3 = (
      await handle.appendSnippet('Agent snippet at the reserved key.', {
        author: 'agent',
        runId: agentRunId,
        orderKey: reserved,
      })
    ).id

    const rows = handle.listSnippets()
    expect(rows.map((r) => r.id)).toEqual([s1, s3, s2])
    expect(rows.map((r) => r.authorship)).toEqual(['user', 'agent', 'user'])
    expect(rows[1]?.originRunId).toBe(agentRunId)
    expect(events.filter((e) => e.type === 'snippet.created')).toHaveLength(3)
  })

  it('revises with a correct baseRev and returns the §6.6 conflict shape on a stale one', async () => {
    const ok = await handle.reviseSnippet(s1, 'First snippet, revised.', {
      author: 'user',
      baseRev: 1,
    })
    expect(ok).toEqual({ ok: true, rev: 2, filePath: expect.any(String) })

    const stale = await handle.reviseSnippet(s1, 'a lost update', {
      author: 'agent',
      runId: agentRunId,
      baseRev: 1,
    })
    expect(stale).toEqual({
      ok: false,
      conflict: { currentRev: 2, currentText: 'First snippet, revised.' },
    })

    const row = handle.listSnippets().find((r) => r.id === s1)
    expect(row?.rev).toBe(2)
    expect(row?.revisionCount).toBe(2)
  })

  it('restores an old rev by appending a NEW revision (log stays append-only)', async () => {
    const res = await handle.restoreSnippet(s1, 1, { author: 'user' })
    expect(res).toEqual({ ok: true, rev: 3, filePath: expect.any(String) })
    const revs = await handle.getRevisions(s1)
    expect(revs).toHaveLength(3)
    expect(revs[2]?.text).toBe('First snippet words.')
    expect(handle.listSnippets().find((r) => r.id === s1)?.rev).toBe(3)
  })

  it('putSituation succeeds against the current hash and conflicts against a stale one', async () => {
    const empty = await handle.getSituation()
    expect(empty.text).toBe('')
    expect(empty.hash).toBe(await xxh64OfString(''))

    const put1 = await handle.putSituation('Mara confronts the harbormaster; storm building.', {
      baseHash: empty.hash,
    })
    expect(put1.ok).toBe(true)

    const put2 = await handle.putSituation('a clobbering write', {
      baseHash: empty.hash, // stale token
    })
    expect(put2.ok).toBe(false)
    if (!put2.ok) {
      expect(put2.conflict.currentText).toBe('Mara confronts the harbormaster; storm building.')
    }
    expect((await handle.getSituation()).text).toBe(
      'Mara confronts the harbormaster; storm building.',
    )
    expect(events.some((e) => e.type === 'situation.changed')).toBe(true)
  })

  it('stores world entries with keys and matches them by alias', async () => {
    const entry = await handle.upsertWorldEntry({
      name: 'Mara Voss',
      keys: ['Mara', 'the keeper'],
      createdBy: 'user',
      body: 'Keeper of the Cinder Point light.',
    })
    entryId = entry.meta.id

    const matched = await handle.matchWorldEntries('Then Mara raised the lamp.')
    expect(matched.map((m) => m.meta.id)).toEqual([entryId])
    const byPhrase = await handle.matchWorldEntries('She spoke with the keeper at dawn.')
    expect(byPhrase.map((m) => m.meta.id)).toEqual([entryId])
    expect(await handle.matchWorldEntries('No aliases in this text.')).toEqual([])

    // FTS indexed the entry body incrementally
    const hits = handle.search('Cinder')
    expect(hits.some((h) => h.kind === 'world' && h.entityId === entryId)).toBe(true)
  })

  it('records a run with artifacts and answers the provenance query', async () => {
    const sink = await handle.recordRun(runId, '2026-07-06T14:01:58Z')
    await sink.append({
      type: 'meta',
      runId,
      kind: 'continue',
      lane: 'high',
      model: 'test-model',
      spec: {},
      params: {},
      contextSnapshot: null,
      startedAt: '2026-07-06T14:01:58Z',
    })
    await sink.append({ type: 'output', text: 'Agent snippet at the reserved key.' })
    await sink.append({
      type: 'result',
      status: 'ok',
      usageTotal: { promptTokens: 100, completionTokens: 40 },
      partialText: null,
      artifacts: [{ kind: 'snippet', snippetId: s3, rev: 1, state: 'committed' }],
      endedAt: '2026-07-06T14:02:11Z',
    })
    expect(sink.closed).toBe(true)

    const byArtifact = handle.queryRunsByArtifact('snippet', s3)
    expect(byArtifact).toHaveLength(1)
    expect(byArtifact[0]).toMatchObject({ runId, kind: 'continue', status: 'ok', rev: 1 })

    expect(await handle.readRun(runId)).toHaveLength(3)
    expect(events.some((e) => e.type === 'run.recorded' && e.runId === runId)).toBe(true)
  })

  it('adopts an externally created section via reconcile (fresh enrichments not stale)', async () => {
    secId = ulid()
    secDirName = `010-first-chapter.${shortId(secId)}`
    const secDir = path.join(workDirPath, 'sections', secDirName)
    await mkdir(secDir, { recursive: true })

    const content = 'Chapter one prose, frozen and freshly summarized.\n'
    const contentHash = await xxh64OfString(content)
    const enrichment = {
      source: 'agent',
      runId: agentRunId,
      generatedAt: '2026-07-01T01:00:00Z',
      sourceHash: contentHash,
    }
    await writeFile(path.join(secDir, 'content.md'), content)
    await writeFile(path.join(secDir, 'summary-short.md'), 'Chapter one, shortly.\n')
    await writeFile(path.join(secDir, 'summary-long.md'), 'Chapter one, at length.\n')
    await writeFile(
      path.join(secDir, 'section.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          id: secId,
          kind: 'chapter',
          orderKey: 'a0',
          title: 'First Chapter',
          titleSource: 'user',
          frozenAt: '2026-07-01T00:00:00Z',
          contentHash,
          enrichments: {
            shortSummary: enrichment,
            longSummary: enrichment,
            illustration: { suppressed: true, deletedAt: '2026-07-05T12:00:00Z' },
          },
        },
        null,
        2,
      ),
    )

    const report = await handle.reconcile()
    expect(report.adopted).toContainEqual({
      kind: 'section',
      id: secId,
      path: `sections/${secDirName}`,
    })
    // Reserved-key commit order (010, 030, 020 on disk) drifted from orderKey order, so
    // the lazy prefix renumbering kicked in for the two trailing snippets (§4, §8).
    expect(report.renumbered).toBe(2)
    expect(report.unrecognized).toEqual([])

    const row = handle.listSections().find((r) => r.id === secId)
    expect(row).toBeDefined()
    expect(row?.title).toBe('First Chapter')
    expect(row?.shortSummaryStale).toBe(false)
    expect(row?.longSummaryStale).toBe(false)
    expect(row?.illustrationStale).toBe(false) // tombstone: never regenerate (§6.5)
    // snippet rows survived renumbering in the same order
    expect(handle.listSnippets().map((r) => r.id)).toEqual([s1, s3, s2])
  })

  it('detects an external section edit and flips summary staleness (§6.5, §8)', async () => {
    const secDir = path.join(workDirPath, 'sections', secDirName)
    await writeFile(
      path.join(secDir, 'content.md'),
      'Chapter one prose, frozen and freshly summarized.\n\nAn external editor appended a paragraph.\n',
    )

    const report = await handle.reconcile()
    expect(report.changed.some((c) => c.kind === 'section' && c.id === secId)).toBe(true)

    const row = handle.listSections().find((r) => r.id === secId)
    expect(row?.shortSummaryStale).toBe(true)
    expect(row?.longSummaryStale).toBe(true)
    expect(row?.illustrationStale).toBe(false)
    expect(
      events.some(
        (e) =>
          e.type === 'enrichment.updated' &&
          e.sectionId === secId &&
          e.enrichment === 'shortSummary',
      ),
    ).toBe(true)

    // the read path serves the external text
    const { text } = await handle.getSectionContent(secId)
    expect(text).toContain('An external editor appended a paragraph.')

    // and putSummary against the new prose un-stales exactly that summary
    await handle.putSummary(secId, 'short', 'Refreshed short summary.', {
      source: 'agent',
      runId: agentRunId,
    })
    const after = handle.listSections().find((r) => r.id === secId)
    expect(after?.shortSummaryStale).toBe(false)
    expect(after?.longSummaryStale).toBe(true)
  })

  it('tracks the editing-snippet marker in memory', () => {
    expect(handle.getEditingSnippet()).toBeNull()
    handle.setEditingSnippet(s1)
    expect(handle.getEditingSnippet()).toBe(s1)
    handle.setEditingSnippet(null)
    expect(handle.getEditingSnippet()).toBeNull()
  })

  it('exposes consolidation entry points that throw NotImplementedError until Stage 4', () => {
    expect(() => handle.maybeConsolidate({ taskTargetIds: [] })).toThrow(NotImplementedError)
    expect(() => handle.applyBoundaries({ boundaries: [] }, { boundaryRunId: null })).toThrow(
      NotImplementedError,
    )
    expect(() => handle.undoConsolidation('some-op')).toThrow(NotImplementedError)
  })

  it('rebuilds from files alone after .cowrite/ is deleted — reads answer identically (§1)', async () => {
    const before = {
      snippets: handle.listSnippets(),
      sections: handle.listSections(),
      situation: await handle.getSituation(),
      revisions: await handle.getRevisions(s1),
      worldIds: (await handle.listWorldEntries()).map((e) => e.meta.id),
      runsByArtifact: handle.queryRunsByArtifact('snippet', s3),
      search: handle.search('Cinder'),
    }

    await handle.close()
    await rm(path.join(workDirPath, '.cowrite'), { recursive: true, force: true })

    handle = await storage.openWork(slug)
    handle.onChange((e) => events.push(e))
    expect(handle.readOnly).toBe(false)

    expect(handle.listSnippets()).toEqual(before.snippets)
    expect(handle.listSections()).toEqual(before.sections)
    expect(await handle.getSituation()).toEqual(before.situation)
    expect(await handle.getRevisions(s1)).toEqual(before.revisions)
    expect((await handle.listWorldEntries()).map((e) => e.meta.id)).toEqual(before.worldIds)
    expect(handle.queryRunsByArtifact('snippet', s3)).toEqual(before.runsByArtifact)
    expect(handle.search('Cinder')).toEqual(before.search)
  })

  it('opens read-only for a second instance while the lock is held (§9.3)', async () => {
    const second = await storage.openWork(slug)
    expect(second.readOnly).toBe(true)

    // reads still answer
    expect(second.listSnippets().map((r) => r.id)).toEqual(handle.listSnippets().map((r) => r.id))
    expect((await second.getSituation()).text).toBe((await handle.getSituation()).text)

    // every mutating call throws the typed error
    await expect(second.appendSnippet('nope', { author: 'user' })).rejects.toBeInstanceOf(
      ReadOnlyError,
    )
    await expect(
      second.putSituation('nope', { baseHash: 'xxh64:0000000000000000' }),
    ).rejects.toBeInstanceOf(ReadOnlyError)
    await second.close()

    // the writer is unaffected
    expect(handle.readOnly).toBe(false)
    const meta = await handle.appendSnippet('Writer still writes.', { author: 'user' })
    expect(handle.listSnippets().some((r) => r.id === meta.id)).toBe(true)
  })

  it('drops to read-only when the lock nonce is taken over (§9.3 suspend/resume)', async () => {
    // Simulate a takeover while suspended: a foreign instance rewrote the lock.
    const lockFile = path.join(workDirPath, '.cowrite', 'lock')
    await writeFile(
      lockFile,
      JSON.stringify({
        pid: process.pid,
        hostname: os.hostname(),
        nonce: 'FOREIGNNONCE00000000000000',
        acquiredAt: new Date().toISOString(),
      }),
    )

    await expect(handle.appendSnippet('after takeover', { author: 'user' })).rejects.toBeInstanceOf(
      ReadOnlyError,
    )
    expect(handle.readOnly).toBe(true)
  })
})

describe('openWork failure paths (§9.3, §10.7)', () => {
  let dataDir: string
  let storage: StorageService

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'cowrite-openfail-'))
    storage = createStorage(dataDir)
  })

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true })
  })

  it('a failed open releases the lock so the next open in-process succeeds as writer', async () => {
    const created = await storage.createWork('Broken Index Probe')
    const seeded = await storage.openWork(created.slug)
    await seeded.close()

    // Sabotage the open lifecycle after lock acquisition: the index path becomes a
    // non-empty DIRECTORY, so the rebuild path's index-file removal throws.
    const idx = indexPath(created.dirPath)
    for (const suffix of ['', '-wal', '-shm']) await rm(`${idx}${suffix}`, { force: true })
    await mkdir(path.join(idx, 'blocker'), { recursive: true })
    await writeFile(path.join(idx, 'blocker', 'x'), 'x')
    await expect(storage.openWork(created.slug)).rejects.toThrow()

    // Regression: the throw above used to leak the held lock + refresh timer, forcing
    // every later open of this work read-only. After removing the cause, we must be
    // able to open as the writer again.
    await rm(idx, { recursive: true, force: true })
    const reopened = await storage.openWork(created.slug)
    try {
      expect(reopened.readOnly).toBe(false)
      const meta = await reopened.appendSnippet('still a writer', { author: 'user' })
      expect(reopened.listSnippets().some((r) => r.id === meta.id)).toBe(true)
    } finally {
      await reopened.close()
    }
  })

  it('openWork succeeds despite a corrupt middle line in an old finished run (§9.1)', async () => {
    const created = await storage.createWork('Corrupt Transcript Probe')
    const seeded = await storage.openWork(created.slug)
    await seeded.close()

    // A finished transcript with a mangled MIDDLE line (external corruption)…
    const shard = path.join(runsDir(created.dirPath), '2026-07')
    await mkdir(shard, { recursive: true })
    const corruptRunId = ulid()
    const corruptFile = path.join(shard, `${corruptRunId}.jsonl`)
    const meta = (runId: string): string =>
      `${JSON.stringify({
        type: 'meta',
        runId,
        kind: 'continue',
        lane: 'high',
        model: 'glm-5',
        spec: {},
        params: {},
        contextSnapshot: null,
        startedAt: '2026-07-06T14:01:58Z',
      })}\n`
    const result = `${JSON.stringify({
      type: 'result',
      status: 'ok',
      usageTotal: { promptTokens: 10, completionTokens: 5 },
      partialText: null,
      artifacts: [],
      endedAt: '2026-07-06T14:02:11Z',
    })}\n`
    await writeFile(corruptFile, `${meta(corruptRunId)}%%% mangled line %%%\n${result}`)
    // …and a genuinely crashed run needing finalization.
    const crashedRunId = ulid()
    await writeFile(path.join(shard, `${crashedRunId}.jsonl`), meta(crashedRunId))

    // Regression: openWork used to full-read every historical run file and throw on the
    // mangled middle line, making the work unopenable forever.
    const handle = await storage.openWork(created.slug)
    try {
      expect(handle.readOnly).toBe(false)
      // the crashed run still got its synthesized result…
      const events = await handle.readRun(crashedRunId)
      const last = events[events.length - 1]
      expect(last?.type).toBe('result')
      if (last?.type === 'result') expect(last.error?.code).toBe('crash')
      // …and the corrupt file was left untouched
      expect(await readFile(corruptFile, 'utf8')).toContain('%%% mangled line %%%')
    } finally {
      await handle.close()
    }
  })

  it('re-ingests crash-finalized runs on a HEALTHY index (agent_runs no longer stuck NULL)', async () => {
    const created = await storage.createWork('Crash Reingest Probe')
    const seeded = await storage.openWork(created.slug)
    await seeded.close() // leaves a healthy on-disk index with zero runs

    const shard = path.join(runsDir(created.dirPath), '2026-07')
    await mkdir(shard, { recursive: true })
    const runId = ulid()
    const lines = [
      {
        type: 'meta',
        runId,
        kind: 'continue',
        lane: 'high',
        model: 'glm-5',
        spec: {},
        params: {},
        contextSnapshot: null,
        startedAt: '2026-07-06T14:01:58Z',
      },
      { type: 'usage', promptTokens: 321, completionTokens: 45, estimated: false, call: 'writing' },
      { type: 'output', text: 'partial…' },
    ]
    await writeFile(
      path.join(shard, `${runId}.jsonl`),
      lines.map((l) => `${JSON.stringify(l)}\n`).join(''),
    )

    const handle = await storage.openWork(created.slug) // healthy index: no rebuild
    try {
      const runRow = () => {
        const db = openIndex(indexPath(created.dirPath)) // second WAL connection
        try {
          return db.listRunRows().find((r) => r.id === runId)
        } finally {
          db.close()
        }
      }
      const row = runRow()
      expect(row?.status).toBe('error')
      expect(row?.promptTokens).toBe(321)
      expect(row?.completionTokens).toBe(45)
      expect(row?.endedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)

      // incremental result == a from-scratch rebuild of the same files
      const before = row
      await handle.rebuildIndex()
      expect(runRow()).toEqual(before)
    } finally {
      await handle.close()
    }
  })

  it('a failed lock refresh demotes the handle to read-only instead of crashing', async () => {
    const created = await storage.createWork('Refresh Failure Probe')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    const handle = await storage.openWork(created.slug, { lock: { refreshMs: 25 } })
    try {
      // Break every future refresh: the lock path becomes a directory. (retry: a racing
      // refresh may recreate the file between rm and mkdir)
      const lockFile = lockPath(created.dirPath)
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          await rm(lockFile, { force: true })
          await mkdir(lockFile)
          break
        } catch {
          // recreated under us — try again
        }
      }
      const deadline = Date.now() + 2_000
      while (!handle.readOnly && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(handle.readOnly).toBe(true)
      await expect(handle.appendSnippet('nope', { author: 'user' })).rejects.toBeInstanceOf(
        ReadOnlyError,
      )
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
      consoleError.mockRestore()
      await handle.close()
    }
  })
})

describe('rebuildIndex keeps serving reads (§7.3)', () => {
  let dataDir: string
  let handle: WorkHandle

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'cowrite-rebuild-'))
    await mkdir(path.join(dataDir, 'works'), { recursive: true })
    await buildFixtureWork(path.join(dataDir, 'works'))
    handle = await createStorage(dataDir).openWork('salt-and-signal')
  })

  afterAll(async () => {
    await handle.close().catch(() => {})
    await rm(dataDir, { recursive: true, force: true })
  })

  it('interleaved listSections calls never throw and never see an empty index', async () => {
    const before = handle.listSections()
    expect(before).toHaveLength(2)

    const rebuild = handle.rebuildIndex()
    let done = false
    void rebuild.then(
      () => {
        done = true
      },
      () => {
        done = true
      },
    )
    let reads = 0
    while (!done) {
      // Regression: the old rebuild closed/reassigned the db across awaits, so these
      // un-mutexed sync reads either threw (connection closed) or saw empty tables.
      const rows = handle.listSections()
      expect(rows).toHaveLength(2)
      reads++
      await new Promise((resolve) => setImmediate(resolve))
    }
    await rebuild
    expect(reads).toBeGreaterThan(0)
    expect(handle.listSections()).toEqual(before)
  })
})
