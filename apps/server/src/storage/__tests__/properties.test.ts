import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ulid } from 'ulid'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ensureDir } from '../lib/fsx.js'
import { compareOrderKeys, isValidOrderKey, keyBetween, nKeysBetween } from '../lib/orderKeys.js'
import { frontierSnippetsDir, snippetFileName } from '../lib/paths.js'
import {
  appendSnippet,
  getRevisions,
  listSnippetFiles,
  OrderKeyReservations,
  readSnippet,
  restoreSnippet,
  reviseSnippet,
  serializeSnippet,
} from '../snippetStore.js'
import { mulberry32, pick, randInt } from './prng.js'

/**
 * Property-style hardening tests (spec 02 §12): fractional order keys stay strictly
 * totally ordered under random interleaved appends / inserts-between / reservations
 * (§4), the filename-prefix mirror never affects ordering (frontmatter is
 * authoritative), and random revise/restore sequences keep every snippet's rev equal to
 * its revision-line count with the current text equal to the last event's text (§6.1,
 * §6.6). Plain loops + a seeded mulberry32 PRNG — deterministic, no new dependency.
 */

const ORDER_KEY_RE = /^[0-9a-z]+$/

function assertStrictlyOrdered(keys: readonly string[]): void {
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i] ?? ''
    expect(key).toMatch(ORDER_KEY_RE)
    if (i > 0) {
      expect(compareOrderKeys(keys[i - 1] ?? '', key)).toBeLessThan(0)
    }
  }
}

/**
 * Sorted, but tolerating equal neighbors: keys themselves need not be globally unique —
 * a between-neighbors insert can land exactly on a live reservation's key, and §4's
 * total order is over (orderKey, ULID) pairs, ULID breaking the tie.
 */
function assertSorted(keys: readonly string[]): void {
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i] ?? ''
    expect(key).toMatch(ORDER_KEY_RE)
    if (i > 0) {
      expect(compareOrderKeys(keys[i - 1] ?? '', key)).toBeLessThanOrEqual(0)
    }
  }
}

/** Insert `key` into the sorted model (equal keys allowed — ULID tiebreak in prod). */
function insertSorted(keys: string[], key: string): void {
  let at = keys.length
  for (let i = 0; i < keys.length; i++) {
    if (compareOrderKeys(key, keys[i] ?? '') < 0) {
      at = i
      break
    }
  }
  keys.splice(at, 0, key)
}

describe('fractional order keys under random interleaved operations (§4)', () => {
  it.each([
    [1],
    [7],
    [1234],
  ])('keeps a strict total order over hundreds of ops (seed %i)', (seed) => {
    const rand = mulberry32(seed)
    // The model: sorted committed keys. Files are the truth, so it is SEEDED with
    // hand-authored keys (the spec's §5.4 samples and friends) that satisfy the shared
    // OrderKey regex but not fractional-indexing's key grammar: every random
    // interleaving then drives both the library fast path and the lexicographic
    // fallback through the same assertions.
    const committed: string[] = ['0z', 'a0', 'a2', 'z', 'zz']
    const reservations = new OrderKeyReservations()
    const reserved: string[] = []

    const lastCommitted = (): string | null => committed[committed.length - 1] ?? null

    for (let op = 0; op < 400; op++) {
      const kind = pick(rand, [
        'append',
        'append',
        'append',
        'insertBetween',
        'insertBetween',
        'insertFirst',
        'reserve',
        'reserve',
        'commitReserved',
        'commitReserved',
        'release',
      ] as const)

      switch (kind) {
        case 'append': {
          // appendSnippet's rule: after both the last committed key and every live
          // reservation, so a user append during an agent run lands after the
          // reservation (§4).
          const last = reservations.last()
          const floor =
            last === null
              ? lastCommitted()
              : lastCommitted() === null || compareOrderKeys(last, lastCommitted() ?? '') >= 0
                ? last
                : lastCommitted()
          const key = keyBetween(floor, null)
          // an append lands strictly after everything committed and reserved
          for (const existing of [...committed, ...reserved]) {
            expect(compareOrderKeys(existing, key)).toBeLessThan(0)
          }
          committed.push(key)
          break
        }
        case 'insertBetween': {
          if (committed.length < 2) break
          const i = randInt(rand, committed.length - 1)
          const a = committed[i] ?? ''
          const b = committed[i + 1] ?? ''
          if (compareOrderKeys(a, b) === 0) break // duplicate pair: nothing between
          const key = keyBetween(a, b)
          expect(compareOrderKeys(a, key)).toBeLessThan(0)
          expect(compareOrderKeys(key, b)).toBeLessThan(0)
          committed.splice(i + 1, 0, key)
          break
        }
        case 'insertFirst': {
          if (committed.length === 0) break
          const first = committed[0] ?? ''
          const key = keyBetween(null, first)
          expect(compareOrderKeys(key, first)).toBeLessThan(0)
          committed.unshift(key)
          break
        }
        case 'reserve': {
          const key = reservations.reserveAfter(lastCommitted())
          // a reservation lands strictly after everything committed and reserved
          for (const existing of [...committed, ...reserved]) {
            expect(compareOrderKeys(existing, key)).toBeLessThan(0)
          }
          reserved.push(key)
          break
        }
        case 'commitReserved': {
          if (reserved.length === 0) break
          const at = randInt(rand, reserved.length)
          const key = reserved.splice(at, 1)[0] ?? ''
          expect(reservations.consume(key)).toBe(true)
          insertSorted(committed, key)
          break
        }
        case 'release': {
          if (reserved.length === 0) break
          const at = randInt(rand, reserved.length)
          const key = reserved.splice(at, 1)[0] ?? ''
          reservations.release(key)
          expect(reservations.has(key)).toBe(false)
          // released reservations leave no gap to repair (§4) — nothing else changes
          break
        }
      }

      assertSorted(committed)
      for (const key of reserved) expect(isValidOrderKey(key)).toBe(true)
    }

    expect(committed.length).toBeGreaterThan(100)
    for (const key of reserved) expect(reservations.has(key)).toBe(true)
  })

  it('nKeysBetween yields strictly ordered in-bound keys in the base-36 alphabet', () => {
    const rand = mulberry32(42)
    let bounds: Array<[string | null, string | null]> = [[null, null]]
    for (let round = 0; round < 20; round++) {
      const [a, b] = pick(rand, bounds)
      const n = 1 + randInt(rand, 9)
      const keys = nKeysBetween(a, b, n)
      expect(keys).toHaveLength(n)
      assertStrictlyOrdered(keys)
      const first = keys[0] ?? ''
      const last = keys[keys.length - 1] ?? ''
      if (a !== null) expect(compareOrderKeys(a, first)).toBeLessThan(0)
      if (b !== null) expect(compareOrderKeys(last, b)).toBeLessThan(0)
      // recurse into random sub-gaps so later rounds exercise deep midpoints
      bounds = bounds.concat(keys.map((k, i) => [k, keys[i + 1] ?? b] as [string | null, string]))
      if (bounds.length > 64) bounds = bounds.slice(-64)
    }
  })
})

describe('filename-prefix mirror never affects ordering (§4)', () => {
  let workDir: string

  beforeAll(async () => {
    workDir = await mkdtemp(path.join(os.tmpdir(), 'cowrite-prop-mirror-'))
  })

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true })
  })

  it('listSnippetFiles sorts by frontmatter orderKey with ULID tiebreak, prefixes shuffled', async () => {
    const rand = mulberry32(99)
    const dir = frontierSnippetsDir(workDir)
    await ensureDir(dir)

    const keys = nKeysBetween(null, null, 30)
    // two extra snippets sharing an existing key: ULID must break the tie
    const dupKey = keys[10] ?? ''
    const entries = keys
      .map((orderKey) => ({ id: ulid(), orderKey }))
      .concat([
        { id: ulid(), orderKey: dupKey },
        { id: ulid(), orderKey: dupKey },
      ])

    // filename prefixes deliberately shuffled: the human mirror disagrees with key order
    const prefixes = entries.map((_, i) => (i + 1) * 10)
    for (let i = prefixes.length - 1; i > 0; i--) {
      const j = randInt(rand, i + 1)
      const a = prefixes[i] ?? 0
      prefixes[i] = prefixes[j] ?? 0
      prefixes[j] = a
    }

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]
      if (entry === undefined) continue
      const meta = {
        id: entry.id,
        orderKey: entry.orderKey,
        createdAt: '2026-07-06T12:00:00Z',
        updatedAt: '2026-07-06T12:00:00Z',
        authorship: 'user' as const,
        originRunId: null,
        rev: 1,
      }
      const fileName = snippetFileName(prefixes[i] ?? 10, entry.id)
      await writeFile(path.join(dir, fileName), serializeSnippet(meta, `Body ${i}.\n`))
    }

    const expected = [...entries].sort(
      (a, b) =>
        compareOrderKeys(a.orderKey, b.orderKey) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
    const listed = await listSnippetFiles(workDir)
    expect(listed.map((f) => f.meta.id)).toEqual(expected.map((e) => e.id))
    assertStrictlyOrdered([...new Set(listed.map((f) => f.meta.orderKey))])
  })
})

describe('revision logs under random revise/restore sequences (§6.1, §6.6)', () => {
  let workDir: string

  beforeAll(async () => {
    workDir = await mkdtemp(path.join(os.tmpdir(), 'cowrite-prop-revs-'))
  })

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true })
  })

  it('rev always equals the revision-line count and current text equals the last event', async () => {
    const rand = mulberry32(2026)

    // model: per snippet, the ordered list of event texts (index i = rev i+1)
    const model = new Map<string, string[]>()
    for (let i = 0; i < 3; i++) {
      const text = `Seed snippet ${i}.`
      const meta = await appendSnippet(workDir, text, { author: 'user' })
      model.set(meta.id, [text])
    }
    const ids = [...model.keys()]

    const checkInvariant = async (id: string): Promise<void> => {
      const texts = model.get(id) ?? []
      const file = await readSnippet(workDir, id)
      const events = await getRevisions(workDir, id)
      expect(file.meta.rev).toBe(events.length) // rev == revision-line count
      expect(events.map((e) => e.rev)).toEqual(texts.map((_, i) => i + 1))
      expect(events.map((e) => e.text)).toEqual(texts)
      expect(file.text).toBe(events[events.length - 1]?.text) // current == last event
    }

    for (let op = 0; op < 200; op++) {
      const id = pick(rand, ids)
      const texts = model.get(id) ?? []
      const kind = pick(rand, ['revise', 'revise', 'revise', 'staleRevise', 'restore'] as const)

      switch (kind) {
        case 'revise': {
          const text = `Revision ${op} of ${id.slice(-6)}.`
          const author = pick(rand, ['user', 'agent'] as const)
          const res = await reviseSnippet(workDir, id, text, {
            author,
            ...(author === 'agent' ? { runId: ulid() } : {}),
            baseRev: texts.length,
          })
          expect(res).toEqual({ ok: true, rev: texts.length + 1, filePath: expect.any(String) })
          texts.push(text)
          break
        }
        case 'staleRevise': {
          // a stale baseRev must surface as a typed conflict and change nothing
          const res = await reviseSnippet(workDir, id, 'lost update', {
            author: 'user',
            baseRev: texts.length + 1 + randInt(rand, 3),
          })
          expect(res).toEqual({
            ok: false,
            conflict: { currentRev: texts.length, currentText: texts[texts.length - 1] },
          })
          break
        }
        case 'restore': {
          const target = 1 + randInt(rand, texts.length)
          const res = await restoreSnippet(workDir, id, target, { author: 'user' })
          // restore appends a NEW revision carrying the old text (append-only log)
          expect(res).toEqual({ ok: true, rev: texts.length + 1, filePath: expect.any(String) })
          texts.push(texts[target - 1] ?? '')
          break
        }
      }

      await checkInvariant(id)
    }

    for (const id of ids) await checkInvariant(id)
    // the random walk actually revised things
    const total = [...model.values()].reduce((n, texts) => n + texts.length, 0)
    expect(total).toBeGreaterThan(100)
  })
})
