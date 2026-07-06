import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ulid } from 'ulid'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { compareOrderKeys, keyBetween } from './lib/orderKeys.js'
import { frontierRevisionsDir, frontierSnippetsDir, shortId } from './lib/paths.js'
import {
  appendSnippet,
  getRevisions,
  listSnippetFiles,
  OrderKeyConflictError,
  OrderKeyReservations,
  RevisionNotFoundError,
  readSnippet,
  reserveOrderKey,
  restoreSnippet,
  reviseSnippet,
  SnippetNotFoundError,
} from './snippetStore.js'

let workDir: string

beforeEach(async () => {
  workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cowrite-snippet-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fsp.rm(workDir, { recursive: true, force: true })
})

const RUN_ID = ulid()

describe('appendSnippet', () => {
  it('writes a frontmatter file plus the first revision event (user)', async () => {
    const meta = await appendSnippet(workDir, 'Mara pressed her palm...', { author: 'user' })
    expect(meta.rev).toBe(1)
    expect(meta.authorship).toBe('user')
    expect(meta.originRunId).toBeNull()
    expect(meta.createdAt).toBe(meta.updatedAt)

    const file = await readSnippet(workDir, meta.id)
    expect(file.text).toBe('Mara pressed her palm...')
    expect(file.fileName).toBe(`010.${shortId(meta.id)}.md`)
    expect(file.wordCount).toBe(4)

    const events = await getRevisions(workDir, meta.id)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'revision', rev: 1, author: 'user', text: file.text })
    expect(events[0]?.runId).toBeUndefined()
  })

  it('records originRunId and the revision runId for agent snippets', async () => {
    const meta = await appendSnippet(workDir, 'agent prose', { author: 'agent', runId: RUN_ID })
    expect(meta.authorship).toBe('agent')
    expect(meta.originRunId).toBe(RUN_ID)
    const events = await getRevisions(workDir, meta.id)
    expect(events[0]?.runId).toBe(RUN_ID)
  })

  it('appends after the current last orderKey and steps the filename prefix by 10', async () => {
    const a = await appendSnippet(workDir, 'one', { author: 'user' })
    const b = await appendSnippet(workDir, 'two', { author: 'user' })
    const c = await appendSnippet(workDir, 'three', { author: 'user' })
    expect(compareOrderKeys(a.orderKey, b.orderKey)).toBeLessThan(0)
    expect(compareOrderKeys(b.orderKey, c.orderKey)).toBeLessThan(0)
    const files = await listSnippetFiles(workDir)
    expect(files.map((f) => f.fileName.split('.')[0])).toEqual(['010', '020', '030'])
  })

  it('uses the next multiple of 10 after a drifted (renamed) prefix', async () => {
    const meta = await appendSnippet(workDir, 'x', { author: 'user' })
    const dir = frontierSnippetsDir(workDir)
    await fsp.rename(
      path.join(dir, `010.${shortId(meta.id)}.md`),
      path.join(dir, `015.${shortId(meta.id)}.md`),
    )
    const next = await appendSnippet(workDir, 'y', { author: 'user' })
    const file = await readSnippet(workDir, next.id)
    expect(file.fileName).toBe(`020.${shortId(next.id)}.md`)
  })

  it('honors an explicit orderKey (insert between neighbors)', async () => {
    const a = await appendSnippet(workDir, 'a', { author: 'user' })
    const b = await appendSnippet(workDir, 'b', { author: 'user' })
    const between = keyBetween(a.orderKey, b.orderKey)
    const mid = await appendSnippet(workDir, 'mid', { author: 'user', orderKey: between })
    const files = await listSnippetFiles(workDir)
    expect(files.map((f) => f.meta.id)).toEqual([a.id, mid.id, b.id])
  })
})

describe('listSnippetFiles', () => {
  it('sorts by orderKey (not filename) and skips foreign or broken files', async () => {
    const a = await appendSnippet(workDir, 'first', { author: 'user' })
    const b = await appendSnippet(workDir, 'second', { author: 'user' })
    const dir = frontierSnippetsDir(workDir)
    // Filename order now contradicts orderKey order: frontmatter wins (§4).
    await fsp.rename(
      path.join(dir, `010.${shortId(a.id)}.md`),
      path.join(dir, `090.${shortId(a.id)}.md`),
    )
    // Foreign files: bad name, and a valid name with no frontmatter.
    await fsp.writeFile(path.join(dir, 'notes.md'), 'stray', 'utf8')
    await fsp.writeFile(path.join(dir, '050.aaaaaa.md'), 'no frontmatter here', 'utf8')

    const files = await listSnippetFiles(workDir)
    expect(files.map((f) => f.meta.id)).toEqual([a.id, b.id])
  })

  it('returns [] when the frontier does not exist yet', async () => {
    expect(await listSnippetFiles(workDir)).toEqual([])
  })
})

describe('readSnippet resolution fast paths (§7.3)', () => {
  it('resolves via a file-path hint (absolute or work-relative), verifying the id', async () => {
    const a = await appendSnippet(workDir, 'first', { author: 'user' })
    const b = await appendSnippet(workDir, 'second', { author: 'user' })
    const relHint = `frontier/snippets/010.${shortId(a.id)}.md`
    expect((await readSnippet(workDir, a.id, relHint)).text).toBe('first')
    const absHint = path.join(frontierSnippetsDir(workDir), `020.${shortId(b.id)}.md`)
    expect((await readSnippet(workDir, b.id, absHint)).text).toBe('second')
    // a hint pointing at the WRONG snippet's file must not serve the wrong text
    expect((await readSnippet(workDir, b.id, relHint)).text).toBe('second')
  })

  it('falls back to the short-id filename match, then the full scan', async () => {
    const meta = await appendSnippet(workDir, 'by short id', { author: 'user' })
    // stale hint → short-id match still finds it
    const viaShortId = await readSnippet(workDir, meta.id, 'frontier/snippets/gone.md')
    expect(viaShortId.text).toBe('by short id')

    // rename to a conforming name whose short id does NOT match: only the scan finds it
    const dir = frontierSnippetsDir(workDir)
    await fsp.rename(path.join(dir, `010.${shortId(meta.id)}.md`), path.join(dir, '090.zzzzzz.md'))
    const viaScan = await readSnippet(workDir, meta.id)
    expect(viaScan.text).toBe('by short id')
    await expect(readSnippet(workDir, ulid())).rejects.toBeInstanceOf(SnippetNotFoundError)
  })
})

describe('reviseSnippet', () => {
  it('bumps rev, rewrites the file, and appends a revision event', async () => {
    const meta = await appendSnippet(workDir, 'v1', { author: 'user' })
    const result = await reviseSnippet(workDir, meta.id, 'v2', { author: 'user', baseRev: 1 })
    expect(result).toEqual({ ok: true, rev: 2, filePath: expect.any(String) })
    const file = await readSnippet(workDir, meta.id)
    expect(file.text).toBe('v2')
    expect(file.meta.rev).toBe(2)
    expect(file.meta.authorship).toBe('user')
    const events = await getRevisions(workDir, meta.id)
    expect(events.map((e) => e.rev)).toEqual([1, 2])
  })

  it('returns the current state as a conflict on a stale baseRev, changing nothing', async () => {
    const meta = await appendSnippet(workDir, 'v1', { author: 'user' })
    await reviseSnippet(workDir, meta.id, 'v2', { author: 'user', baseRev: 1 })
    const result = await reviseSnippet(workDir, meta.id, 'lost update', {
      author: 'user',
      baseRev: 1,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.conflict).toEqual({ currentRev: 2, currentText: 'v2' })
    expect((await readSnippet(workDir, meta.id)).text).toBe('v2')
    expect(await getRevisions(workDir, meta.id)).toHaveLength(2)
  })

  it('flips authorship to mixed when the other party edits (both directions)', async () => {
    const userSnippet = await appendSnippet(workDir, 'u', { author: 'user' })
    await reviseSnippet(workDir, userSnippet.id, 'u2', {
      author: 'agent',
      runId: RUN_ID,
      baseRev: 1,
    })
    expect((await readSnippet(workDir, userSnippet.id)).meta.authorship).toBe('mixed')

    const agentSnippet = await appendSnippet(workDir, 'a', { author: 'agent', runId: RUN_ID })
    await reviseSnippet(workDir, agentSnippet.id, 'a2', { author: 'user', baseRev: 1 })
    expect((await readSnippet(workDir, agentSnippet.id)).meta.authorship).toBe('mixed')

    // mixed stays mixed; same-author edits do not flip.
    await reviseSnippet(workDir, agentSnippet.id, 'a3', { author: 'user', baseRev: 2 })
    expect((await readSnippet(workDir, agentSnippet.id)).meta.authorship).toBe('mixed')
    const solo = await appendSnippet(workDir, 's', { author: 'user' })
    await reviseSnippet(workDir, solo.id, 's2', { author: 'user', baseRev: 1 })
    expect((await readSnippet(workDir, solo.id)).meta.authorship).toBe('user')
  })

  it('preserves originRunId across agent revisions of an agent snippet', async () => {
    const meta = await appendSnippet(workDir, 'a', { author: 'agent', runId: RUN_ID })
    const laterRun = ulid()
    await reviseSnippet(workDir, meta.id, 'a2', { author: 'agent', runId: laterRun, baseRev: 1 })
    const file = await readSnippet(workDir, meta.id)
    expect(file.meta.originRunId).toBe(RUN_ID)
    expect(file.meta.authorship).toBe('agent')
    const events = await getRevisions(workDir, meta.id)
    expect(events[1]?.runId).toBe(laterRun)
  })

  it('throws SnippetNotFoundError for a vanished snippet', async () => {
    await expect(
      reviseSnippet(workDir, ulid(), 'x', { author: 'user', baseRev: 1 }),
    ).rejects.toBeInstanceOf(SnippetNotFoundError)
  })
})

describe('restoreSnippet', () => {
  it('appends a NEW revision carrying the old text (log stays append-only)', async () => {
    const meta = await appendSnippet(workDir, 'v1', { author: 'user' })
    await reviseSnippet(workDir, meta.id, 'v2', { author: 'user', baseRev: 1 })
    const result = await restoreSnippet(workDir, meta.id, 1, { author: 'user' })
    expect(result).toEqual({ ok: true, rev: 3, filePath: expect.any(String) })
    const file = await readSnippet(workDir, meta.id)
    expect(file.text).toBe('v1')
    expect(file.meta.rev).toBe(3)
    const events = await getRevisions(workDir, meta.id)
    expect(events.map((e) => e.rev)).toEqual([1, 2, 3])
    expect(events[2]?.text).toBe('v1')
  })

  it('throws the typed RevisionNotFoundError when the requested rev never existed', async () => {
    const meta = await appendSnippet(workDir, 'v1', { author: 'user' })
    const promise = restoreSnippet(workDir, meta.id, 7, { author: 'user' })
    promise.catch(() => {}) // assertions below re-await; keep the rejection handled
    await expect(promise).rejects.toThrow(/no revision 7/)
    await expect(promise).rejects.toBeInstanceOf(RevisionNotFoundError)
  })
})

describe('getRevisions', () => {
  it('drops a torn final line (crash mid-append)', async () => {
    const meta = await appendSnippet(workDir, 'v1', { author: 'user' })
    const logPath = path.join(frontierRevisionsDir(workDir), `${meta.id}.jsonl`)
    await fsp.appendFile(logPath, '{"type":"revision","rev":2,"ts":"2026-', 'utf8')
    const events = await getRevisions(workDir, meta.id)
    expect(events).toHaveLength(1)
  })

  it('reads a missing log as empty', async () => {
    expect(await getRevisions(workDir, ulid())).toEqual([])
  })

  it('a revise after a torn tail drops the torn line instead of fusing with it', async () => {
    const meta = await appendSnippet(workDir, 'v1', { author: 'user' })
    const logPath = path.join(frontierRevisionsDir(workDir), `${meta.id}.jsonl`)
    await fsp.appendFile(logPath, '{"type":"revision","rev":2,"ts":"20', 'utf8')
    await reviseSnippet(workDir, meta.id, 'v2', { author: 'user', baseRev: 1 })
    const events = await getRevisions(workDir, meta.id)
    expect(events.map((e) => e.rev)).toEqual([1, 2])
    expect(events[1]?.text).toBe('v2')
  })

  it('a revise after a terminated-but-unparseable final line drops it instead of appending after garbage', async () => {
    const meta = await appendSnippet(workDir, 'v1', { author: 'user' })
    const logPath = path.join(frontierRevisionsDir(workDir), `${meta.id}.jsonl`)
    // A crash mid-append that still flushed the newline: terminated, but not JSON.
    // readJsonl drops it as torn — a revise must physically drop it too, or its valid
    // new line would land AFTER the garbage and turn it into mid-file corruption.
    await fsp.appendFile(logPath, '{"type":"revision","rev":2,"ts":"20\n', 'utf8')
    await reviseSnippet(workDir, meta.id, 'v2', { author: 'user', baseRev: 1 })
    const events = await getRevisions(workDir, meta.id)
    expect(events.map((e) => e.rev)).toEqual([1, 2])
    expect(events[1]?.text).toBe('v2')
  })
})

describe('order key reservations (§4)', () => {
  it('reserves after the last existing snippet', async () => {
    const a = await appendSnippet(workDir, 'a', { author: 'user' })
    const reservations = new OrderKeyReservations()
    const reserved = await reserveOrderKey(workDir, reservations)
    expect(compareOrderKeys(a.orderKey, reserved)).toBeLessThan(0)
    expect(reservations.has(reserved)).toBe(true)
  })

  it('stacks: each reservation lands after the previous one', async () => {
    const reservations = new OrderKeyReservations()
    const r1 = await reserveOrderKey(workDir, reservations)
    const r2 = await reserveOrderKey(workDir, reservations)
    expect(compareOrderKeys(r1, r2)).toBeLessThan(0)
    expect(reservations.has(r1)).toBe(true)
    expect(reservations.has(r2)).toBe(true)
  })

  it('a user append during a live reservation lands after it', async () => {
    await appendSnippet(workDir, 'existing', { author: 'user' })
    const reservations = new OrderKeyReservations()
    const reserved = await reserveOrderKey(workDir, reservations)
    // User appends while the agent run is still streaming (§4).
    const userMeta = await appendSnippet(workDir, 'user text', { author: 'user', reservations })
    expect(compareOrderKeys(reserved, userMeta.orderKey)).toBeLessThan(0)
    // The agent's snippet then commits on its reserved key and still sorts first.
    const agentMeta = await appendSnippet(workDir, 'agent text', {
      author: 'agent',
      runId: RUN_ID,
      orderKey: reserved,
      reservations,
    })
    expect(reservations.has(reserved)).toBe(false)
    const order = (await listSnippetFiles(workDir)).map((f) => f.meta.id)
    expect(order.indexOf(agentMeta.id)).toBeLessThan(order.indexOf(userMeta.id))
  })

  it('released reservations stop influencing key generation', async () => {
    const reservations = new OrderKeyReservations()
    const r1 = await reserveOrderKey(workDir, reservations)
    reservations.release(r1)
    expect(reservations.has(r1)).toBe(false)
    expect(reservations.last()).toBeNull()
    // No gap to repair: the next append is generated from the files alone.
    const meta = await appendSnippet(workDir, 'x', { author: 'user', reservations })
    expect(meta.orderKey).toBe(r1)
  })

  it('a failing write leaves the reservation intact; the retry commits the same key once', async () => {
    // Regression: consume() used to run BEFORE the file write, so a failed write burned
    // the reservation and a retried commit could double-mint the key.
    const reservations = new OrderKeyReservations()
    const reserved = await reserveOrderKey(workDir, reservations)

    vi.spyOn(fsp, 'rename').mockRejectedValueOnce(new Error('injected write failure'))
    await expect(
      appendSnippet(workDir, 'doomed', {
        author: 'agent',
        runId: RUN_ID,
        orderKey: reserved,
        reservations,
      }),
    ).rejects.toThrow('injected write failure')
    vi.restoreAllMocks()

    expect(reservations.has(reserved)).toBe(true) // still ours to retry
    expect(await listSnippetFiles(workDir)).toEqual([]) // nothing landed

    const meta = await appendSnippet(workDir, 'retried', {
      author: 'agent',
      runId: RUN_ID,
      orderKey: reserved,
      reservations,
    })
    expect(meta.orderKey).toBe(reserved)
    expect(reservations.has(reserved)).toBe(false) // consumed exactly once, at commit
    expect((await listSnippetFiles(workDir)).map((f) => f.meta.id)).toEqual([meta.id])
  })

  it('rejects an explicit orderKey that is neither reserved nor collision-free', async () => {
    const reservations = new OrderKeyReservations()
    const first = await appendSnippet(workDir, 'holder', { author: 'user' })

    // colliding, unreserved: typed error, nothing written
    await expect(
      appendSnippet(workDir, 'dup', { author: 'user', orderKey: first.orderKey, reservations }),
    ).rejects.toBeInstanceOf(OrderKeyConflictError)
    expect(await listSnippetFiles(workDir)).toHaveLength(1)

    // the same key IS accepted while reserved (the reservation owns it)
    const reserved = await reserveOrderKey(workDir, reservations)
    const committed = await appendSnippet(workDir, 'ok', {
      author: 'user',
      orderKey: reserved,
      reservations,
    })
    expect(committed.orderKey).toBe(reserved)
  })
})
