import type { Dirent } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { WorkMeta } from '@cowrite/shared'
import { ulid } from 'ulid'
import { StorageError } from './errors.js'
import { ensureDir, readIfExists, writeFileAtomic } from './lib/fsx.js'
import {
  cowriteDir,
  frontierRevisionsDir,
  frontierSnippetsDir,
  runsDir,
  sectionsDir,
  slugify,
  trashMarkerPath,
  trashRoot,
  workDir,
  workMetaPath,
  worksRoot,
  worldEntriesDir,
  worldImagesDir,
} from './lib/paths.js'
import type { WorkListing } from './storageTypes.js'

/**
 * Work lifecycle file store (spec 02 §2.1, §5.2, §11): create/list/trash works and
 * read/write `work.json`. No SQLite here — files are the truth.
 */

function nowIso(): string {
  return new Date().toISOString()
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.stat(p)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

/** First free slug: `<base>`, then `<base>-2`, `<base>-3`, … (collision suffix). */
async function availableSlug(dataDir: string, title: string): Promise<string> {
  const base = slugify(title)
  let candidate = base
  for (let n = 2; await exists(workDir(dataDir, candidate)); n++) {
    candidate = `${base}-${n}`
  }
  return candidate
}

export interface CreatedWork {
  slug: string
  meta: WorkMeta
  dirPath: string
}

/**
 * Mint a ULID, pick a collision-free slug, materialize the canonical directory skeleton
 * (§5.2) and write `work.json` from WorkMeta defaults (flat ["chapter"] scheme, default
 * settings).
 */
export async function createWork(dataDir: string, title: string): Promise<CreatedWork> {
  const slug = await availableSlug(dataDir, title)
  const dirPath = workDir(dataDir, slug)
  const meta = WorkMeta.parse({
    schemaVersion: 1,
    id: ulid(),
    title,
    createdAt: nowIso(),
  })
  await ensureDir(dirPath)
  await ensureDir(sectionsDir(dirPath))
  await ensureDir(frontierSnippetsDir(dirPath))
  await ensureDir(frontierRevisionsDir(dirPath))
  await ensureDir(worldEntriesDir(dirPath))
  await ensureDir(worldImagesDir(dirPath))
  await ensureDir(runsDir(dirPath))
  await ensureDir(cowriteDir(dirPath))
  await writeWorkMeta(dirPath, meta)
  return { slug, meta, dirPath }
}

/** Parse and validate `<workDir>/work.json`. Throws on a missing or invalid file. */
export async function readWorkMeta(workDirPath: string): Promise<WorkMeta> {
  const raw = await readIfExists(workMetaPath(workDirPath))
  if (raw === null) {
    throw new StorageError(`work.json not found in ${workDirPath}`, 'not_found', { kind: 'work' })
  }
  return WorkMeta.parse(JSON.parse(raw))
}

/** Validate and atomically replace `<workDir>/work.json` (pretty-printed, §5.1). */
export async function writeWorkMeta(workDirPath: string, meta: WorkMeta): Promise<void> {
  const valid = WorkMeta.parse(meta)
  await writeFileAtomic(workMetaPath(workDirPath), `${JSON.stringify(valid, null, 2)}\n`)
}

/**
 * Scan every `<dataDir>/works/<slug>/work.json`. Unparsable or missing metadata yields a warning
 * entry instead of throwing — a broken work must never hide the healthy ones. Sorted by
 * slug for determinism. `counts` stays null here (no SQLite in this store); the
 * StorageService facade fills it from each work's index (read-only, lock-free).
 */
export async function listWorks(dataDir: string): Promise<WorkListing[]> {
  const root = worksRoot(dataDir)
  let entries: Dirent[]
  try {
    entries = await fsp.readdir(root, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const summaries: WorkListing[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const slug = entry.name
    try {
      const meta = await readWorkMeta(workDir(dataDir, slug))
      summaries.push({ slug, ok: true, meta, counts: null })
    } catch (err) {
      summaries.push({
        slug,
        ok: false,
        warning: err instanceof Error ? err.message : String(err),
      })
    }
  }
  summaries.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
  return summaries
}

export interface TrashedWork {
  originalSlug: string
  trashedTo: string
  deletedAt: string
}

/**
 * Move `works/<slug>` to `<dataDir>/.trash/<slug>-<ts>/` and write
 * `.cowrite/trash.json` `{deletedAt, originalSlug}` inside it (§5.2) so restoration is
 * mechanical. Never hard-deletes prose; trash GC is manual (deferred, §13).
 */
export async function trashWork(dataDir: string, slug: string): Promise<TrashedWork> {
  const source = workDir(dataDir, slug)
  if (!(await exists(source))) {
    throw new StorageError(`work not found: ${slug}`, 'not_found', { kind: 'work', id: slug })
  }
  const deletedAt = nowIso()
  // Windows forbids ':' in filenames, so the timestamp is the ISO instant with ':' and
  // '.' flattened to '-' (e.g. 2026-07-06T14-02-11-123Z).
  const ts = deletedAt.replace(/[:.]/g, '-')
  await ensureDir(trashRoot(dataDir))
  let target = path.join(trashRoot(dataDir), `${slug}-${ts}`)
  for (let n = 2; await exists(target); n++) {
    target = path.join(trashRoot(dataDir), `${slug}-${ts}-${n}`)
  }
  await fsp.rename(source, target)
  await ensureDir(cowriteDir(target))
  await writeFileAtomic(
    trashMarkerPath(target),
    `${JSON.stringify({ deletedAt, originalSlug: slug }, null, 2)}\n`,
  )
  return { originalSlug: slug, trashedTo: target, deletedAt }
}
