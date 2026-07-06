import fsp from 'node:fs/promises'
import type { SituationDto } from '@cowrite/shared'
import { readIfExists, writeFileAtomic } from './lib/fsx.js'
import { xxh64OfString } from './lib/hash.js'
import { situationPath } from './lib/paths.js'
import type { SituationWriteResult } from './storageTypes.js'

/**
 * The per-work singleton scratchpad (spec 02 §2.2): `situation.md` at the work root, no
 * frontmatter. Absent file = empty situation. The §6.6 concurrency token is the CONTENT
 * HASH (xxh64, like sections' baseHash) — mtime is exposed as `updatedAt` for display
 * only, because coarse filesystem timestamps can collide across distinct writes and
 * would let a stale put clobber an external edit silently.
 */

/**
 * Sentinel `updatedAt` for a never-written situation (display only; the put token is
 * the hash, and an absent file hashes as the empty string, so the first put of a client
 * that read the empty state succeeds naturally).
 */
export const SITUATION_NEVER_WRITTEN = '1970-01-01T00:00:00.000Z'

async function statUpdatedAt(filePath: string): Promise<string | null> {
  try {
    const stat = await fsp.stat(filePath)
    return new Date(stat.mtimeMs).toISOString()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/** Read the situation; an absent file reads as '' with the never-written sentinel. */
export async function getSituation(workDirPath: string): Promise<SituationDto> {
  const filePath = situationPath(workDirPath)
  const text = await readIfExists(filePath)
  if (text === null) {
    return { text: '', updatedAt: SITUATION_NEVER_WRITTEN, hash: await xxh64OfString('') }
  }
  // Stat after the read: worst case the mtime is newer than the text we return, which
  // only affects the display timestamp — the concurrency token is the content hash.
  const updatedAt = (await statUpdatedAt(filePath)) ?? SITUATION_NEVER_WRITTEN
  return { text, updatedAt, hash: await xxh64OfString(text) }
}

/**
 * Atomic replace with the §6.6 optimistic contract: `baseHash` must equal the hash of
 * the current text (the hash of '' when the file does not exist yet), otherwise the
 * current state is returned as a conflict — never thrown.
 */
export async function putSituation(
  workDirPath: string,
  text: string,
  opts: { baseHash: string },
): Promise<SituationWriteResult> {
  const filePath = situationPath(workDirPath)
  const current = await getSituation(workDirPath)
  if (current.hash !== opts.baseHash) {
    return {
      ok: false,
      conflict: { currentText: current.text, updatedAt: current.updatedAt, hash: current.hash },
    }
  }
  await writeFileAtomic(filePath, text)
  const updatedAt = (await statUpdatedAt(filePath)) ?? SITUATION_NEVER_WRITTEN
  return { ok: true, updatedAt, hash: await xxh64OfString(text) }
}
