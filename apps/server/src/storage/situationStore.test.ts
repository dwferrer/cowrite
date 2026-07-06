import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { xxh64OfString } from './lib/hash.js'
import { situationPath } from './lib/paths.js'
import { getSituation, putSituation, SITUATION_NEVER_WRITTEN } from './situationStore.js'

let workDir: string

beforeEach(async () => {
  workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cowrite-situation-'))
})

afterEach(async () => {
  await fsp.rm(workDir, { recursive: true, force: true })
})

describe('getSituation', () => {
  it('reads an absent file as empty with the never-written sentinel and the empty hash', async () => {
    expect(await getSituation(workDir)).toEqual({
      text: '',
      updatedAt: SITUATION_NEVER_WRITTEN,
      hash: await xxh64OfString(''),
    })
  })

  it('reads an externally created situation.md', async () => {
    await fsp.writeFile(situationPath(workDir), 'Mara confronts the harbormaster', 'utf8')
    const { text, updatedAt, hash } = await getSituation(workDir)
    expect(text).toBe('Mara confronts the harbormaster')
    expect(updatedAt).not.toBe(SITUATION_NEVER_WRITTEN)
    expect(hash).toBe(await xxh64OfString('Mara confronts the harbormaster'))
  })
})

describe('putSituation', () => {
  it('creates the file when base is the empty-text hash', async () => {
    const result = await putSituation(workDir, 'storm building', {
      baseHash: await xxh64OfString(''),
    })
    expect(result.ok).toBe(true)
    const current = await getSituation(workDir)
    expect(current.text).toBe('storm building')
    if (!result.ok) throw new Error('unreachable')
    expect(current.updatedAt).toBe(result.updatedAt)
    expect(current.hash).toBe(result.hash)
  })

  it('replaces when baseHash matches the current state', async () => {
    await putSituation(workDir, 'v1', { baseHash: await xxh64OfString('') })
    const current = await getSituation(workDir)
    const result = await putSituation(workDir, 'v2', { baseHash: current.hash })
    expect(result.ok).toBe(true)
    expect((await getSituation(workDir)).text).toBe('v2')
  })

  it('returns a typed conflict (never throws) on a stale base', async () => {
    const emptyHash = await xxh64OfString('')
    await putSituation(workDir, 'v1', { baseHash: emptyHash })
    const result = await putSituation(workDir, 'clobber', { baseHash: emptyHash })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.conflict.currentText).toBe('v1')
    expect(result.conflict.hash).toBe(await xxh64OfString('v1'))
    // The losing write changed nothing.
    expect((await getSituation(workDir)).text).toBe('v1')
  })

  it('detects an external edit even when the mtime is pinned equal (coarse-fs clobber)', async () => {
    // Regression: with a raw-mtime token, an external write B landing between A's read
    // and A's put on a coarse-timestamp filesystem (same mtime) was silently clobbered.
    const first = await putSituation(workDir, 'app text', { baseHash: await xxh64OfString('') })
    if (!first.ok) throw new Error('setup failed')
    // whole-second timestamp: round-trips exactly through utimes/stat on any fs
    const pinned = new Date(Math.trunc(Date.now() / 1000) * 1000)
    await fsp.utimes(situationPath(workDir), pinned, pinned)
    const read = await getSituation(workDir) // A reads…

    // …B rewrites externally, with the mtime pinned to the exact same value
    await fsp.writeFile(situationPath(workDir), 'external text', 'utf8')
    await fsp.utimes(situationPath(workDir), pinned, pinned)
    expect((await getSituation(workDir)).updatedAt).toBe(read.updatedAt) // token trap set

    const result = await putSituation(workDir, 'stale app write', { baseHash: read.hash })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.conflict.currentText).toBe('external text')
    expect((await getSituation(workDir)).text).toBe('external text')
  })
})
