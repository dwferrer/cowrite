import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { SectionRow, SnippetDto, type WorkEvent } from '@cowrite/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { StorageChangeListener } from '../storage/events.js'
import type { SectionRow as IndexSectionRow } from '../storage/index/db.js'
import { buildFixtureWork, FIX } from '../storage/index/fixture.js'
import { createStorage, type WorkHandle } from '../storage/service.js'
import { attachStorageAdapter, inlinesLongSummary, type StorageAdapter } from './adapter.js'
import { type InProcessEvent, WorkEventBus } from './bus.js'

/**
 * storage onChange → WorkEvent translation with hydration (docs/03-api.md §8.2), against
 * real storage on a temp-dir fixture work.
 */

let dataDir: string
let handle: WorkHandle
let bus: WorkEventBus
let adapter: StorageAdapter
let wire: WorkEvent[]
let local: InProcessEvent[]

beforeEach(async () => {
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cowrite-adapter-'))
  await buildFixtureWork(path.join(dataDir, 'works'))
  handle = await createStorage(dataDir).openWork('salt-and-signal')
  bus = new WorkEventBus()
  wire = []
  local = []
  bus.attach({
    write: (chunk) => {
      for (const block of chunk.split('\n\n')) {
        if (block === '' || block.startsWith(':')) continue
        const dataLine = block.split('\n').find((line) => line.startsWith('data: '))
        if (dataLine !== undefined) wire.push(JSON.parse(dataLine.slice(6)) as WorkEvent)
      }
    },
    end: () => {},
  })
  wire.length = 0 // drop the hello frame
  bus.onLocal((event) => local.push(event))
  adapter = attachStorageAdapter(handle, bus, { onError: (err) => throwLater(err) })
})

let pendingError: unknown = null
function throwLater(err: unknown): void {
  pendingError = err
}

afterEach(async () => {
  adapter.detach()
  bus.end()
  await handle.close()
  await fsp.rm(dataDir, { recursive: true, force: true })
  if (pendingError !== null) {
    const err = pendingError
    pendingError = null
    throw err
  }
})

async function drain(): Promise<void> {
  await adapter.settled()
}

describe('storage → SSE adapter', () => {
  it('hydrates snippet.created into a full SnippetDto', async () => {
    const meta = await handle.appendSnippet('A brand new line.', { author: 'user' })
    await drain()
    expect(wire).toHaveLength(1)
    const event = wire[0]
    if (event?.type !== 'snippet.created') throw new Error(`unexpected ${event?.type}`)
    const dto = SnippetDto.parse(event.snippet)
    expect(dto.id).toBe(meta.id)
    expect(dto.text).toBe('A brand new line.')
    expect(dto.rev).toBe(1)
    expect(dto.authorship).toBe('user')
  })

  it('maps snippet.updated to snippet.revised with the fresh revision', async () => {
    const res = await handle.reviseSnippet(FIX.snip1, 'Rewritten body.', {
      author: 'user',
      baseRev: 3,
    })
    expect(res.ok).toBe(true)
    await drain()
    const event = wire[0]
    if (event?.type !== 'snippet.revised') throw new Error(`unexpected ${event?.type}`)
    expect(event.snippet.rev).toBe(4)
    expect(event.snippet.text).toBe('Rewritten body.')
    expect(event.snippet.revisionCount).toBe(4)
  })

  it('maps snippet.removed to snippet.deleted with the bare id', async () => {
    await handle.deleteSnippet(FIX.snip2)
    await drain()
    expect(wire[0]).toEqual({ type: 'snippet.deleted', id: FIX.snip2 })
  })

  it('hydrates section.changed into the shared SectionRow DTO', async () => {
    const content = await handle.getSectionContent(FIX.sec1)
    const res = await handle.replaceSectionContent(FIX.sec1, `${content.text}\nMore prose.\n`, {
      baseHash: content.contentHash,
    })
    expect(res.ok).toBe(true)
    await drain()
    const event = wire[0]
    if (event?.type !== 'section.changed') throw new Error(`unexpected ${event?.type}`)
    const row = SectionRow.parse(event.section)
    expect(row.id).toBe(FIX.sec1)
    expect(row.isLeaf).toBe(true)
    expect(row.shortSummary).toBe('Keeper watches the harbor.\n')
    // single-level scheme (['chapter']) inlines longSummary for every section
    expect(row.longSummary).toBe('A longer summary of chapter one.\n')
    expect(row.illustration).toMatchObject({ width: 640, height: 480 })
    // the prose changed, so the user-edited short summary just went stale
    expect(row.stale.short).toBe(true)
  })

  it('remaps enrichment names and includes the hydrated section row', async () => {
    await handle.putSummary(FIX.sec2, 'short', 'Fresh short summary.', { source: 'user' })
    await drain()
    const event = wire[0]
    if (event?.type !== 'enrichment.updated') throw new Error(`unexpected ${event?.type}`)
    expect(event.kind).toBe('short')
    expect(event.sectionId).toBe(FIX.sec2)
    const row = SectionRow.parse(event.section)
    expect(row.shortSummary).toBe('Fresh short summary.')
    expect(row.stale.short).toBe(false)
    // sec2's illustration is the suppressed tombstone: renders as null, never a badge
    expect(row.illustration).toBeNull()
  })

  it('maps world.updated to world.changed with the entryId', async () => {
    const res = await handle.upsertWorldEntry({
      id: FIX.glass,
      name: 'The Storm Glass',
      createdBy: 'agent',
      body: 'Updated body.',
    })
    expect(res.ok).toBe(true)
    await drain()
    expect(wire[0]).toEqual({ type: 'world.changed', entryId: FIX.glass })
  })

  it('maps world.removed to world.changed without an entryId (refetch the list)', async () => {
    await handle.deleteWorldEntry(FIX.glass)
    await drain()
    expect(wire[0]).toEqual({ type: 'world.changed' })
  })

  it('hydrates situation.changed with the fresh text and updatedAt', async () => {
    const before = await handle.getSituation()
    const res = await handle.putSituation('New situation.', { baseHash: before.hash })
    expect(res.ok).toBe(true)
    await drain()
    const event = wire[0]
    if (event?.type !== 'situation.changed') throw new Error(`unexpected ${event?.type}`)
    expect(event.text).toBe('New situation.')
    expect(typeof event.updatedAt).toBe('string')
    // the payload carries the fresh concurrency token (self-echo detection on the web)
    expect(event.hash).toBe((await handle.getSituation()).hash)
  })

  it('keeps work.changed in-process only, never on the wire', async () => {
    await handle.updateWork({ title: 'Salt and Signal, Revised' })
    await drain()
    expect(wire).toHaveLength(0)
    expect(local.map((e) => e.type)).toEqual(['work.changed'])
  })

  it('publishes in commit order even though hydration is async', async () => {
    await handle.appendSnippet('First.', { author: 'user' })
    await handle.appendSnippet('Second.', { author: 'user' })
    await handle.deleteSnippet(FIX.snip3)
    await drain()
    expect(wire.map((e) => e.type)).toEqual([
      'snippet.created',
      'snippet.created',
      'snippet.deleted',
    ])
  })

  it('coalesces section hydrations per sectionId within one drain tick', async () => {
    // A bulk reconcile emits many changes for the same section back-to-back; the adapter
    // must publish every event but hydrate the section exactly once per batch.
    const sectionId = FIX.sec1
    const row = handle.getSection(sectionId)
    if (row === null) throw new Error('fixture section missing')
    let listener: StorageChangeListener = () => {}
    let getSectionCalls = 0
    const stub = {
      work: handle.work,
      getSection: (id: string): IndexSectionRow | null => {
        getSectionCalls += 1
        return id === sectionId ? row : null
      },
      onChange: (l: StorageChangeListener) => {
        listener = l
        return () => {}
      },
    } as unknown as WorkHandle
    const stubAdapter = attachStorageAdapter(stub, bus, { onError: (err) => throwLater(err) })

    // one synchronous burst = one drain tick
    listener({ type: 'section.changed', sectionId })
    listener({ type: 'enrichment.updated', sectionId, enrichment: 'shortSummary' })
    listener({ type: 'section.changed', sectionId })
    await stubAdapter.settled()
    expect(wire.map((e) => e.type)).toEqual([
      'section.changed',
      'enrichment.updated',
      'section.changed',
    ])
    expect(getSectionCalls).toBe(1)

    // the cache is per drain tick: a later batch hydrates afresh
    listener({ type: 'section.changed', sectionId })
    await stubAdapter.settled()
    expect(getSectionCalls).toBe(2)
    stubAdapter.detach()
  })
})

describe('inlinesLongSummary', () => {
  it('inlines everything in a single-level scheme', () => {
    expect(inlinesLongSummary('chapter', ['chapter'])).toBe(true)
  })
  it('excludes the deepest level of a multi-level scheme', () => {
    expect(inlinesLongSummary('scene', ['book', 'chapter', 'scene'])).toBe(false)
    expect(inlinesLongSummary('chapter', ['book', 'chapter', 'scene'])).toBe(true)
    expect(inlinesLongSummary('book', ['book', 'chapter', 'scene'])).toBe(true)
  })
  it('treats an unknown kind as deepest (lazy fetch is always available)', () => {
    expect(inlinesLongSummary('interlude', ['book', 'chapter'])).toBe(false)
  })
})
