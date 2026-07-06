import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ulid } from 'ulid'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  appendJsonlLine,
  ensureDir,
  readBufferIfExists,
  readIfExists,
  readJsonl,
  sweepTmpFiles,
  truncateTornTail,
  writeFileAtomic,
} from './fsx.js'

let dir: string

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cowrite-fsx-'))
})

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true })
})

describe('writeFileAtomic', () => {
  it('creates a file with the given text', async () => {
    const target = path.join(dir, 'a.md')
    await writeFileAtomic(target, 'hello\n')
    expect(await fsp.readFile(target, 'utf8')).toBe('hello\n')
  })

  it('replaces an existing file', async () => {
    const target = path.join(dir, 'a.json')
    await writeFileAtomic(target, 'v1')
    await writeFileAtomic(target, 'v2')
    expect(await fsp.readFile(target, 'utf8')).toBe('v2')
  })

  it('writes binary data', async () => {
    const target = path.join(dir, 'a.png')
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff])
    await writeFileAtomic(target, bytes)
    expect(new Uint8Array(await fsp.readFile(target))).toEqual(bytes)
  })

  it('leaves no tmp files behind', async () => {
    await writeFileAtomic(path.join(dir, 'a.md'), 'x')
    await writeFileAtomic(path.join(dir, 'a.md'), 'y')
    expect(await fsp.readdir(dir)).toEqual(['a.md'])
  })

  it('cleans up its tmp file and rethrows when the write fails', async () => {
    // Writing into a missing subdirectory fails at open time.
    const target = path.join(dir, 'missing', 'a.md')
    await expect(writeFileAtomic(target, 'x')).rejects.toThrow()
    expect(await fsp.readdir(dir)).toEqual([])
  })
})

describe('appendJsonlLine / readJsonl', () => {
  it('round-trips appended events in order', async () => {
    const file = path.join(dir, 'log.jsonl')
    await appendJsonlLine(file, { type: 'revision', rev: 1 })
    await appendJsonlLine(file, { type: 'revision', rev: 2 })
    const { lines, torn } = await readJsonl(file)
    expect(torn).toBe(false)
    expect(lines).toEqual([
      { type: 'revision', rev: 1 },
      { type: 'revision', rev: 2 },
    ])
  })

  it('writes exactly one newline-terminated line per event', async () => {
    const file = path.join(dir, 'log.jsonl')
    await appendJsonlLine(file, { a: 1 })
    expect(await fsp.readFile(file, 'utf8')).toBe('{"a":1}\n')
  })

  it('reads a missing file as empty and not torn', async () => {
    expect(await readJsonl(path.join(dir, 'nope.jsonl'))).toEqual({ lines: [], torn: false })
  })

  it('drops an unterminated final line and reports torn', async () => {
    const file = path.join(dir, 'log.jsonl')
    await fsp.writeFile(file, '{"rev":1}\n{"rev":2}\n{"rev":3', 'utf8')
    const { lines, torn } = await readJsonl(file)
    expect(torn).toBe(true)
    expect(lines).toEqual([{ rev: 1 }, { rev: 2 }])
  })

  it('drops a terminated but unparseable final line and reports torn', async () => {
    const file = path.join(dir, 'log.jsonl')
    await fsp.writeFile(file, '{"rev":1}\n{"rev":2,\n', 'utf8')
    const { lines, torn } = await readJsonl(file)
    expect(torn).toBe(true)
    expect(lines).toEqual([{ rev: 1 }])
  })

  it('throws on an unparseable line before the final one (real corruption)', async () => {
    const file = path.join(dir, 'log.jsonl')
    await fsp.writeFile(file, '{"rev":1}\ngarbage\n{"rev":3}\n', 'utf8')
    await expect(readJsonl(file)).rejects.toThrow(/invalid JSONL/)
  })

  it('skips blank lines and tolerates CRLF endings', async () => {
    const file = path.join(dir, 'log.jsonl')
    await fsp.writeFile(file, '{"rev":1}\r\n\r\n{"rev":2}\r\n', 'utf8')
    const { lines, torn } = await readJsonl(file)
    expect(torn).toBe(false)
    expect(lines).toEqual([{ rev: 1 }, { rev: 2 }])
  })
})

describe('truncateTornTail', () => {
  it('truncates an unterminated final line', async () => {
    const file = path.join(dir, 'log.jsonl')
    await fsp.writeFile(file, '{"rev":1}\n{"rev":2}\n{"rev":3', 'utf8')
    await truncateTornTail(file)
    expect(await fsp.readFile(file, 'utf8')).toBe('{"rev":1}\n{"rev":2}\n')
  })

  it('truncates a terminated but unparseable final line', async () => {
    const file = path.join(dir, 'log.jsonl')
    await fsp.writeFile(file, '{"rev":1}\n{"rev":2,\n', 'utf8')
    await truncateTornTail(file)
    expect(await fsp.readFile(file, 'utf8')).toBe('{"rev":1}\n')
  })

  it('leaves a healthy file byte-identical', async () => {
    const file = path.join(dir, 'log.jsonl')
    await fsp.writeFile(file, '{"rev":1}\n{"rev":2}\n', 'utf8')
    await truncateTornTail(file)
    expect(await fsp.readFile(file, 'utf8')).toBe('{"rev":1}\n{"rev":2}\n')
  })

  it('empties a file that is one torn line, and no-ops on a missing file', async () => {
    const file = path.join(dir, 'log.jsonl')
    await fsp.writeFile(file, '{"rev":1', 'utf8')
    await truncateTornTail(file)
    expect(await fsp.readFile(file, 'utf8')).toBe('')
    await truncateTornTail(path.join(dir, 'nope.jsonl')) // must not throw
  })
})

describe('sweepTmpFiles', () => {
  it('removes orphaned tmp files and keeps everything else', async () => {
    const orphan = path.join(dir, `work.json.tmp-${ulid()}`)
    await fsp.writeFile(orphan, 'partial')
    await fsp.writeFile(path.join(dir, 'work.json'), '{}')
    await fsp.writeFile(path.join(dir, 'notes.tmp-short'), 'not a ulid suffix')
    const removed = await sweepTmpFiles(dir)
    expect(removed).toEqual([orphan])
    expect((await fsp.readdir(dir)).sort()).toEqual(['notes.tmp-short', 'work.json'])
  })

  it('recurses into subdirectories when asked', async () => {
    const sub = path.join(dir, 'sections', '010-a.k9v3qa')
    await fsp.mkdir(sub, { recursive: true })
    const orphan = path.join(sub, `content.md.tmp-${ulid()}`)
    await fsp.writeFile(orphan, 'partial')
    expect(await sweepTmpFiles(dir)).toEqual([])
    expect(await sweepTmpFiles(dir, true)).toEqual([orphan])
  })

  it('sweeps nothing for a missing directory', async () => {
    expect(await sweepTmpFiles(path.join(dir, 'nope'), true)).toEqual([])
  })
})

describe('ensureDir / readIfExists', () => {
  it('creates nested directories idempotently', async () => {
    const nested = path.join(dir, 'a', 'b', 'c')
    await ensureDir(nested)
    await ensureDir(nested)
    expect((await fsp.stat(nested)).isDirectory()).toBe(true)
  })

  it('readIfExists returns text or null', async () => {
    const file = path.join(dir, 'a.md')
    expect(await readIfExists(file)).toBeNull()
    await fsp.writeFile(file, 'body', 'utf8')
    expect(await readIfExists(file)).toBe('body')
  })

  it('readBufferIfExists returns bytes or null', async () => {
    const file = path.join(dir, 'a.bin')
    expect(await readBufferIfExists(file)).toBeNull()
    await fsp.writeFile(file, Uint8Array.from([1, 2, 3]))
    expect(new Uint8Array((await readBufferIfExists(file)) ?? [])).toEqual(
      Uint8Array.from([1, 2, 3]),
    )
  })
})
