import type { Dirent } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { ulid } from 'ulid'

/**
 * Crash-safe filesystem primitives (spec 02 §9.1).
 *
 * Single-file writes are atomic: write `<name>.tmp-<ulid>` in the same directory, fsync the
 * file, rename over the target, then fsync the directory (best-effort — Windows cannot open
 * or fsync directories, so that step is a silent no-op there).
 */

/** Matches the `<name>.tmp-<ulid>` names writeFileAtomic stages (§9.1). */
export const TMP_SUFFIX = /\.tmp-[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/

/** THE tmp-file predicate: shared by the sweep, the reconciler, and the index scan. */
export function isTmpFile(name: string): boolean {
  return TMP_SUFFIX.test(name)
}

/**
 * `readdir` with dirents, sorted by name — a deterministic walk order regardless of
 * platform readdir order. A missing directory reads as empty.
 */
export async function readdirSorted(dir: string): Promise<Dirent[]> {
  let entries: Dirent[]
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

async function fsyncDirBestEffort(dir: string): Promise<void> {
  // Best-effort by design: directories cannot be fsynced on Windows (EISDIR/EPERM/EBADF
  // depending on the platform), and losing the rename's directory-entry durability only
  // costs re-doing the write after a crash — the target file is never left torn.
  try {
    const handle = await fsp.open(dir, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    // ignore
  }
}

/** Atomically replace `filePath` with `data` (tmp file + fsync + rename + dir fsync). */
export async function writeFileAtomic(filePath: string, data: string | Uint8Array): Promise<void> {
  const dir = path.dirname(filePath)
  const tmpPath = path.join(dir, `${path.basename(filePath)}.tmp-${ulid()}`)
  let handle: fsp.FileHandle | undefined
  try {
    handle = await fsp.open(tmpPath, 'w')
    if (typeof data === 'string') {
      await handle.writeFile(data, 'utf8')
    } else {
      await handle.writeFile(data)
    }
    await handle.sync()
    await handle.close()
    handle = undefined
    await fsp.rename(tmpPath, filePath)
  } catch (err) {
    if (handle) await handle.close().catch(() => {})
    await fsp.unlink(tmpPath).catch(() => {})
    throw err
  }
  await fsyncDirBestEffort(dir)
}

/**
 * Append one JSONL event: a single write() of the serialized line ending in `\n`.
 * No fsync — a torn tail is tolerated by readers (readJsonl) and anything lost is
 * re-derivable from the primary files (spec 02 §9.1).
 */
export async function appendJsonlLine(filePath: string, value: unknown): Promise<void> {
  const line = `${JSON.stringify(value)}\n`
  const handle = await fsp.open(filePath, 'a')
  try {
    await handle.write(line, null, 'utf8')
  } finally {
    await handle.close()
  }
}

export interface JsonlReadResult {
  lines: unknown[]
  /** true when a torn (unterminated or unparseable) final line was dropped */
  torn: boolean
}

/**
 * Read a JSONL file, dropping a torn final line (unterminated, or terminated but
 * unparseable — e.g. a crash mid-append). A missing file reads as empty. Unparseable
 * lines *before* the final one indicate real corruption and throw. Blank lines are
 * skipped; trailing `\r` is tolerated (external editors on Windows).
 */
export async function readJsonl(filePath: string): Promise<JsonlReadResult> {
  const raw = await readIfExists(filePath)
  if (raw === null || raw === '') return { lines: [], torn: false }

  const segments = raw.split('\n')
  // A complete append always ends in '\n', so split() leaves a final '' segment.
  const terminated = segments[segments.length - 1] === ''
  if (terminated) segments.pop()

  const lines: unknown[] = []
  let torn = false
  for (let i = 0; i < segments.length; i++) {
    const segment = (segments[i] ?? '').replace(/\r$/, '')
    const isFinal = i === segments.length - 1
    if (segment.trim() === '') continue
    if (isFinal && !terminated) {
      // Unterminated final line: torn by definition (even if it happens to parse).
      torn = true
      break
    }
    try {
      lines.push(JSON.parse(segment))
    } catch (err) {
      if (isFinal) {
        torn = true
        break
      }
      throw new Error(`invalid JSONL at ${filePath}:${i + 1}: ${String(err)}`)
    }
  }
  return { lines, torn }
}

const READ_CHUNK = 64 * 1024

function trimCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

/**
 * Read a JSONL file's first line and last non-empty line without loading the whole
 * file: the first line is read forward chunk-by-chunk to the first '\n'; the last is
 * found by seeking backward from EOF. Used wherever only the boundary events matter —
 * run ingestion (§7.3) and crash finalization (§10.7) — so run volume never blows the
 * open/rebuild budget.
 */
export async function readJsonlBoundaryLines(
  fileAbs: string,
): Promise<{ first: string | null; last: string | null }> {
  const handle = await fsp.open(fileAbs, 'r')
  try {
    const { size } = await handle.stat()
    if (size === 0) return { first: null, last: null }

    // First line: forward scan.
    const firstParts: Buffer[] = []
    let pos = 0
    while (pos < size) {
      const chunk = Buffer.alloc(Math.min(READ_CHUNK, size - pos))
      await handle.read(chunk, 0, chunk.length, pos)
      const nl = chunk.indexOf(0x0a)
      if (nl !== -1) {
        firstParts.push(chunk.subarray(0, nl))
        break
      }
      firstParts.push(chunk)
      pos += chunk.length
    }
    const firstText = trimCr(Buffer.concat(firstParts).toString('utf8'))
    const first = firstText === '' ? null : firstText

    // Last non-empty line: backward scan. `buf` covers file offsets [bufStart, size).
    let buf = Buffer.alloc(0)
    let bufStart = size
    const extendDown = async (): Promise<boolean> => {
      if (bufStart === 0) return false
      const len = Math.min(READ_CHUNK, bufStart)
      const chunk = Buffer.alloc(len)
      await handle.read(chunk, 0, len, bufStart - len)
      buf = Buffer.concat([chunk, buf])
      bufStart -= len
      return true
    }
    let end = size
    while (end > 0) {
      while (end - 1 < bufStart && (await extendDown())) {
        // extend until buf covers offset end-1
      }
      const byte = buf[end - 1 - bufStart] ?? -1
      if (byte === 0x0a || byte === 0x0d) end--
      else break
    }
    if (end === 0) return { first, last: null }
    let start = end
    while (start > 0) {
      while (start - 1 < bufStart && (await extendDown())) {
        // extend until buf covers offset start-1
      }
      if (buf[start - 1 - bufStart] === 0x0a) break
      start--
    }
    const lastText = trimCr(buf.subarray(start - bufStart, end - bufStart).toString('utf8'))
    return { first, last: lastText === '' ? null : lastText }
  } finally {
    await handle.close()
  }
}

/**
 * Physically drop the torn tail readJsonl would drop logically: an unterminated final
 * line, or a terminated final line that is not valid JSON (crash mid-append, spec 02
 * §9.1). Readers merely tolerate a torn TAIL, so appending after one would fuse it into
 * MID-file corruption readers reject — writers call this before appending. Byte offsets
 * are computed on the Buffer: '\n' is one byte in UTF-8, but string indexes are UTF-16
 * code units, so truncation must not go through a string. A missing file is a no-op.
 */
export async function truncateTornTail(filePath: string): Promise<void> {
  const buf = await readBufferIfExists(filePath)
  if (buf === null) return
  let end = buf.length
  if (end > 0 && buf[end - 1] !== 0x0a) {
    end = buf.lastIndexOf(0x0a) + 1 // 0 when the whole file is one torn line
  }
  if (end > 0) {
    const prevNl = end >= 2 ? buf.lastIndexOf(0x0a, end - 2) : -1
    const lastLine = buf
      .subarray(prevNl + 1, end - 1)
      .toString('utf8')
      .replace(/\r$/, '')
    if (lastLine.trim() !== '') {
      try {
        JSON.parse(lastLine)
      } catch {
        end = prevNl + 1
      }
    }
  }
  if (end !== buf.length) await fsp.truncate(filePath, end)
}

/**
 * Delete orphaned `*.tmp-<ulid>` files left by a crash mid-atomic-write (startup sweep,
 * spec 02 §9.1). Returns the absolute paths removed. A missing dir sweeps nothing.
 */
export async function sweepTmpFiles(dir: string, recursive = false): Promise<string[]> {
  const removed: string[] = []
  let entries: Dirent[]
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return removed
    throw err
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (recursive) removed.push(...(await sweepTmpFiles(full, true)))
    } else if (entry.isFile() && isTmpFile(entry.name)) {
      await fsp.unlink(full).catch(() => {})
      removed.push(full)
    }
  }
  return removed
}

/** mkdir -p */
export async function ensureDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true })
}

/** Read a UTF-8 text file, or null when it does not exist. Other errors rethrow. */
export async function readIfExists(filePath: string): Promise<string | null> {
  try {
    return await fsp.readFile(filePath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/** Read a binary file, or null when it does not exist. Other errors rethrow. */
export async function readBufferIfExists(filePath: string): Promise<Buffer | null> {
  try {
    return await fsp.readFile(filePath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}
