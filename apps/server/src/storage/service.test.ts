import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { IllustrationMeta, WorkSettings } from '@cowrite/shared'
import { ulid } from 'ulid'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { StorageChange } from './events.js'
import { needsRebuild, openIndex } from './index/db.js'
import { buildFixtureWork, FIX } from './index/fixture.js'
import { xxh64OfString } from './lib/hash.js'
import { indexPath, lockPath, revisionLogPath, runsDir, shortId } from './lib/paths.js'
import { SectionNotFoundError } from './sectionStore.js'
import { createStorage, ReadOnlyError, type StorageService, type WorkHandle } from './service.js'
import { SnippetNotFoundError } from './snippetStore.js'
import { WorldEntryNotFoundError } from './worldStore.js'

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
    const upserted = await handle.upsertWorldEntry({
      name: 'Mara Voss',
      keys: ['Mara', 'the keeper'],
      createdBy: 'user',
      body: 'Keeper of the Cinder Point light.',
    })
    if (!upserted.ok) throw new Error('unexpected world upsert conflict')
    entryId = upserted.entry.meta.id

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
      spec: { kind: 'continue' },
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

  it('answers consolidation entry points (engine detail in consolidation.service.test.ts)', async () => {
    // The shared work sits far below the default thresholds — the evaluation is idle.
    await expect(handle.maybeConsolidate({ taskTargetIds: [] })).resolves.toEqual({
      status: 'idle',
    })
    // An empty proposal is the §6.3 all-dropped/none case: a typed deferral.
    await expect(
      handle.applyBoundaries({ boundaries: [] }, { boundaryRunId: null }),
    ).resolves.toEqual({ ok: false, deferred: true, droppedBoundaries: 0 })
    // No op is inside its grace window, so the undo token is expired/unknown → 409.
    await expect(handle.undoConsolidation(ulid())).rejects.toMatchObject({ code: 'conflict' })
    await expect(handle.pendingConsolidation()).resolves.toBeNull()
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
        spec: { kind: 'continue' },
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
        spec: { kind: 'continue' },
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

/**
 * The Stage 2 API-support surface (03 §3): text-carrying snippet reads, snippet delete,
 * summaries read, work PATCH, world optimistic concurrency, image path resolution for
 * streaming routes, works-list counts, and the reconcile cadence hooks. Tests run in
 * order and share one work.
 */
describe('storage service API-support surface', () => {
  let dataDir: string
  let storage: StorageService
  let handle: WorkHandle
  let workDirPath: string
  const events: StorageChange[] = []

  let sA = ''
  let sB = ''
  let secId = ''
  let entryId = ''

  const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9])

  function illustrationFixture(sourceWordCount: number | null): IllustrationMeta {
    return IllustrationMeta.parse({
      source: 'agent',
      runId: ulid(),
      generatedAt: new Date().toISOString(),
      sourceHash: null,
      sourceWordCount,
      entities: [],
      prompt: 'a lighthouse in a storm',
      workflow: 'default',
      workflowHash: null,
      seed: 7,
      attempts: 1,
      score: 8,
      guidance: null,
    })
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'cowrite-service-api-'))
    storage = createStorage(dataDir)
    const created = await storage.createWork('Gap Coverage')
    workDirPath = created.dirPath
    handle = await storage.openWork(created.slug)
    handle.onChange((e) => events.push(e))

    sA = (await handle.appendSnippet('Alpha snippet text.', { author: 'user' })).id
    sB = (await handle.appendSnippet('Beta snippet text.', { author: 'user' })).id
    await handle.reviseSnippet(sB, 'Beta snippet text, revised.', { author: 'user', baseRev: 1 })

    // A leaf section with prose + both summary files, adopted via reconcile (§8) the
    // same way the consolidation engine will materialize one.
    secId = ulid()
    const secDir = path.join(workDirPath, 'sections', `010-opening.${shortId(secId)}`)
    await mkdir(secDir, { recursive: true })
    const content = 'Opening prose for the gap-coverage work.\n'
    await writeFile(path.join(secDir, 'content.md'), content)
    await writeFile(path.join(secDir, 'summary-short.md'), 'Short summary.\n')
    await writeFile(path.join(secDir, 'summary-long.md'), 'Long summary, at length.\n')
    await writeFile(
      path.join(secDir, 'section.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: secId,
        kind: 'chapter',
        orderKey: 'a0',
        title: 'Opening',
        titleSource: 'user',
        frozenAt: null,
        contentHash: await xxh64OfString(content),
        enrichments: { shortSummary: null, longSummary: null, illustration: null },
      }),
    )
    await handle.reconcile()

    const upserted = await handle.upsertWorldEntry({
      name: 'Cinder Point',
      keys: ['the point'],
      createdBy: 'user',
      body: 'A basalt headland.',
    })
    if (!upserted.ok) throw new Error('unexpected world upsert conflict')
    entryId = upserted.entry.meta.id
  })

  afterAll(async () => {
    await handle.close().catch(() => {})
    await rm(dataDir, { recursive: true, force: true })
  })

  it('listWorks carries the work id and cheap index-backed counts (03 §3.1)', async () => {
    // A second work that has never been opened has no index — its counts are null.
    await storage.createWork('Never Opened')

    const works = await storage.listWorks()
    expect(works.map((w) => w.slug).sort()).toEqual(['gap-coverage', 'never-opened'])

    const opened = works.find((w) => w.slug === 'gap-coverage')
    if (opened?.ok !== true) throw new Error('expected a healthy listing')
    expect(opened.meta.id).toBe(handle.work.id)
    expect(opened.counts).toMatchObject({ snippetCount: 2, sectionCount: 1 })
    expect(opened.counts?.wordCount).toBeGreaterThan(0)
    expect(opened.counts?.updatedAt).toMatch(/^\d{4}-/)

    const unopened = works.find((w) => w.slug === 'never-opened')
    if (unopened?.ok !== true) throw new Error('expected a healthy listing')
    expect(unopened.counts).toBeNull()
  })

  it('listSnippetsWithText returns rows + text + revisionCount in orderKey order', async () => {
    const list = await handle.listSnippetsWithText()
    expect(list.map((s) => s.id)).toEqual([sA, sB])
    expect(list.map((s) => s.text)).toEqual(['Alpha snippet text.', 'Beta snippet text, revised.'])
    expect(list.map((s) => s.revisionCount)).toEqual([1, 2])
    expect(list[0]?.filePath).toMatch(/^frontier\/snippets\//)

    const one = await handle.getSnippet(sB)
    expect(one.text).toBe('Beta snippet text, revised.')
    expect(one.rev).toBe(2)
    await expect(handle.getSnippet(ulid())).rejects.toBeInstanceOf(SnippetNotFoundError)
  })

  it('deleteSnippet removes the file AND the revision log, drops rows, emits removal', async () => {
    const before = await handle.getSnippet(sB)
    const snippetAbs = path.join(workDirPath, ...before.filePath.split('/'))
    const logAbs = revisionLogPath(workDirPath, sB)
    await stat(snippetAbs) // both exist before the delete
    await stat(logAbs)

    await handle.deleteSnippet(sB)

    await expect(stat(snippetAbs)).rejects.toThrow()
    await expect(stat(logAbs)).rejects.toThrow()
    expect(handle.listSnippets().map((r) => r.id)).toEqual([sA])
    expect((await handle.listSnippetsWithText()).map((s) => s.id)).toEqual([sA])
    expect(events).toContainEqual({ type: 'snippet.removed', snippetId: sB })

    // gone = typed NotFound (API maps to 404), for delete and reads alike
    await expect(handle.deleteSnippet(sB)).rejects.toBeInstanceOf(SnippetNotFoundError)
    await expect(handle.getSnippet(sB)).rejects.toBeInstanceOf(SnippetNotFoundError)

    // the index agrees with a full rebuild (§7.3)
    await handle.rebuildIndex()
    expect(handle.listSnippets().map((r) => r.id)).toEqual([sA])
  })

  it('getSummaries reads both summary files; unknown sections are typed NotFound', async () => {
    expect(await handle.getSummaries(secId)).toEqual({
      short: 'Short summary.\n',
      long: 'Long summary, at length.\n',
    })
    await expect(handle.getSummaries(ulid())).rejects.toBeInstanceOf(SectionNotFoundError)
  })

  it('updateWork patches title/settings, refreshes the index, emits work.changed', async () => {
    const settings = WorkSettings.parse({ illustrationStaleWordDeltaPct: 40 })
    const next = await handle.updateWork({ title: 'Gap Coverage, Revised', settings })
    expect(next.title).toBe('Gap Coverage, Revised')
    expect(handle.work.title).toBe('Gap Coverage, Revised')
    expect(handle.work.settings.illustrationStaleWordDeltaPct).toBe(40)
    expect(events).toContainEqual({ type: 'work.changed' })

    const onDisk = JSON.parse(await readFile(path.join(workDirPath, 'work.json'), 'utf8'))
    expect(onDisk.title).toBe('Gap Coverage, Revised')
    expect(onDisk.settings.illustrationStaleWordDeltaPct).toBe(40)

    // Our own write refreshed the files row: the next reconcile reports no drift.
    const report = await handle.reconcile()
    expect(report.changed).toEqual([])
    expect(report.adopted).toEqual([])
    expect(report.removed).toEqual([])

    await expect(handle.updateWork({ title: '' })).rejects.toThrow() // schema-invalid
  })

  it('world upsert honors baseHash through the handle and emits no event on conflict', async () => {
    const eventsBefore = events.filter((e) => e.type === 'world.updated').length
    const stale = await handle.upsertWorldEntry({
      id: entryId,
      name: 'Cinder Point',
      createdBy: 'user',
      body: 'a lost update',
      baseHash: await xxh64OfString('not the current body'),
    })
    expect(stale.ok).toBe(false)
    if (!stale.ok) {
      expect(stale.conflict.currentText).toBe('A basalt headland.')
      expect(stale.conflict.currentHash).toBe(await xxh64OfString('A basalt headland.'))
    }
    expect(events.filter((e) => e.type === 'world.updated')).toHaveLength(eventsBefore)

    const fresh = await handle.upsertWorldEntry({
      id: entryId,
      name: 'Cinder Point',
      createdBy: 'user',
      body: 'A basalt headland, updated.',
      baseHash: await xxh64OfString('A basalt headland.'),
    })
    expect(fresh.ok).toBe(true)
    expect((await handle.getWorldEntry(entryId)).body).toBe('A basalt headland, updated.')
    expect(events.filter((e) => e.type === 'world.updated')).toHaveLength(eventsBefore + 1)
  })

  it('sectionIllustrationPath: absent → null, present → path+version, tombstone → null', async () => {
    expect(handle.sectionIllustrationPath(secId)).toBeNull()
    expect(() => handle.sectionIllustrationPath(ulid())).toThrow(SectionNotFoundError)

    await handle.putIllustration(secId, PNG_BYTES, illustrationFixture(7))
    const resolved = handle.sectionIllustrationPath(secId)
    expect(resolved).not.toBeNull()
    expect(resolved?.absPath.endsWith('illustration.png')).toBe(true)
    expect(path.isAbsolute(resolved?.absPath ?? '')).toBe(true)
    expect(resolved?.version).toMatch(/^xxh64:[0-9a-f]{16}$/)
    await stat(resolved?.absPath ?? '') // streamable: the PNG really is there

    await handle.suppressIllustration(secId)
    expect(handle.sectionIllustrationPath(secId)).toBeNull() // suppressed tombstone
  })

  it('worldImagePath: no image → null, uploaded → path+version, unknown → NotFound', async () => {
    expect(handle.worldImagePath(entryId)).toBeNull()
    expect(() => handle.worldImagePath(ulid())).toThrow(WorldEntryNotFoundError)

    await handle.putWorldImage(entryId, PNG_BYTES, illustrationFixture(null))
    const resolved = handle.worldImagePath(entryId)
    expect(resolved).not.toBeNull()
    expect(path.isAbsolute(resolved?.absPath ?? '')).toBe(true)
    expect(resolved?.absPath.endsWith(`${entryId}.png`)).toBe(true)
    expect(resolved?.version).toMatch(/^xxh64:[0-9a-f]{16}$/)
    await stat(resolved?.absPath ?? '')
  })

  it('deleteWorldImage clears the pointer, removes PNG + sidecar, emits ONE world.updated', async () => {
    const imageAbs = handle.worldImagePath(entryId)?.absPath
    if (imageAbs === undefined) throw new Error('fixture image missing')
    const sidecarAbs = imageAbs.replace(/\.png$/, '.json')
    await stat(sidecarAbs) // sidecar exists before the delete

    const updatesBefore = events.filter((e) => e.type === 'world.updated').length
    await handle.deleteWorldImage(entryId)

    expect((await handle.getWorldEntry(entryId)).meta.image).toBeNull()
    expect(handle.worldImagePath(entryId)).toBeNull()
    await expect(stat(imageAbs)).rejects.toThrow()
    await expect(stat(sidecarAbs)).rejects.toThrow()
    expect(events.filter((e) => e.type === 'world.updated')).toHaveLength(updatesBefore + 1)

    // idempotent no-op: no second event, no error
    await handle.deleteWorldImage(entryId)
    expect(events.filter((e) => e.type === 'world.updated')).toHaveLength(updatesBefore + 1)

    // unknown entry is a typed NotFound (API maps to 404)
    await expect(handle.deleteWorldImage(ulid())).rejects.toBeInstanceOf(WorldEntryNotFoundError)

    // the index agrees with a full rebuild (files are truth, §7.3)
    await handle.rebuildIndex()
    expect(handle.worldImagePath(entryId)).toBeNull()
  })

  it('reconcile is timer-safe (idle no-op) and stamps lastReconcileAt', async () => {
    expect(handle.lastReconcileAt).toMatch(/^\d{4}-\d{2}-\d{2}T/) // set by openWork
    const before = handle.lastReconcileAt
    // Two immediate back-to-back reconciles, as a 30 s timer would fire them on an
    // idle work: pure (size, mtime) fast path, empty report, nothing rewritten.
    for (let i = 0; i < 2; i++) {
      const report = await handle.reconcile()
      expect(report.changed).toEqual([])
      expect(report.adopted).toEqual([])
      expect(report.removed).toEqual([])
      expect(report.unrecognized).toEqual([])
      expect(report.renumbered).toBe(0)
    }
    expect(handle.lastReconcileAt).not.toBeNull()
    expect((handle.lastReconcileAt ?? '') >= (before ?? '')).toBe(true)
  })
})

describe('index schema v2: inlined summaries, point lookups, version-mismatch rebuild', () => {
  let dataDir: string

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'cowrite-schema-v2-'))
    await mkdir(path.join(dataDir, 'works'), { recursive: true })
    await buildFixtureWork(path.join(dataDir, 'works'))
  })

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true })
  })

  it('a stale user_version routes through the full rebuild and serves index-only reads', async () => {
    const storage = createStorage(dataDir)
    const first = await storage.openWork('salt-and-signal')
    const idxPath = indexPath(path.join(dataDir, 'works', 'salt-and-signal'))
    expect(first.listSections()[0]?.shortSummary).toBe('Keeper watches the harbor.\n')
    await first.close()

    // Simulate an index written by an older build: same file, foreign user_version.
    const tampered = openIndex(idxPath)
    tampered.handle.pragma('user_version = 1')
    tampered.close()
    expect(needsRebuild(idxPath)).toBe(true)

    // Reopen: the mismatch takes the existing delete-and-rebuild path (§7.3)…
    const handle = await storage.openWork('salt-and-signal')
    try {
      expect(needsRebuild(idxPath)).toBe(false)

      // …and every summary-bearing read answers from the rebuilt rows, no file I/O.
      const row = handle.getSection(FIX.sec1)
      expect(row?.shortSummary).toBe('Keeper watches the harbor.\n')
      expect(row?.longSummary).toBe('A longer summary of chapter one.\n')
      expect(handle.getSection(FIX.sec2)?.shortSummary).toBeNull()
      expect(handle.getSection(ulid())).toBeNull() // point lookup: unknown id → null

      // the WorkDetail aggregates ride the same index (shared with readWorkCounts)
      expect(handle.workCounts()).toEqual({
        snippetCount: 3,
        sectionCount: 2,
        wordCount: expect.any(Number),
        updatedAt: '2026-07-06T14:02:11Z',
      })
    } finally {
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
