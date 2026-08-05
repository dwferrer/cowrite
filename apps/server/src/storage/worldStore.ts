import fsp from 'node:fs/promises'
import path from 'node:path'
import { IllustrationMeta, WorldEntryMeta } from '@cowrite/shared'
import { ulid } from 'ulid'
import { StorageError } from './errors.js'
import { parseFrontmatter, serializeFrontmatter } from './lib/frontmatter.js'
import { ensureDir, readIfExists, writeFileAtomic } from './lib/fsx.js'
import { xxh64OfString } from './lib/hash.js'
import {
  slugify,
  worldEntriesDir,
  worldEntryFileName,
  worldImagePath,
  worldImageRelPath,
  worldImageSidecarPath,
  worldImagesDir,
} from './lib/paths.js'
import type { WorldEntry, WorldEntryWriteResult } from './storageTypes.js'

/**
 * World-info file store (spec 02 §2.6, §5.4): one frontmatter Markdown file per entry,
 * PNG + IllustrationMeta sidecar per image, and the pure key-scan matcher the
 * illustration pipeline (08) uses standalone until the index-backed variant lands.
 */

export class WorldEntryNotFoundError extends StorageError {
  constructor(readonly entryId: string) {
    super(`world entry not found: ${entryId}`, 'not_found', { kind: 'world', id: entryId })
    this.name = 'WorldEntryNotFoundError'
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

/** Frontmatter serialization order matches the §5.4 sample. Exported for the
 *  reconciler's frontmatter write-back at adoption time (§8). */
export function serializeEntry(meta: WorldEntryMeta, body: string): string {
  return serializeFrontmatter(
    {
      id: meta.id,
      name: meta.name,
      keys: meta.keys,
      image: meta.image,
      shortSummary: meta.shortSummary,
      createdBy: meta.createdBy,
      updatedAt: meta.updatedAt,
    },
    body,
  )
}

/**
 * All entries, sorted by name (then id) for determinism. Files whose frontmatter does
 * not validate are skipped — adoption/repair is the reconciler's job (§8).
 */
export async function listWorldEntries(workDirPath: string): Promise<WorldEntry[]> {
  const dir = worldEntriesDir(workDirPath)
  let names: string[]
  try {
    names = await fsp.readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const entries: WorldEntry[] = []
  for (const name of names) {
    if (!name.endsWith('.md')) continue
    const filePath = path.join(dir, name)
    const raw = await readIfExists(filePath)
    if (raw === null) continue
    const parsed = parseFrontmatter(raw)
    if (!parsed.hadFrontmatter) continue
    const meta = WorldEntryMeta.safeParse(parsed.data)
    if (!meta.success) continue
    entries.push({ meta: meta.data, body: parsed.body, filePath })
  }
  entries.sort((a, b) => {
    const byName = a.meta.name.localeCompare(b.meta.name)
    return byName !== 0 ? byName : a.meta.id < b.meta.id ? -1 : 1
  })
  return entries
}

/** Read one entry by id. Throws WorldEntryNotFoundError. */
export async function getWorldEntry(workDirPath: string, entryId: string): Promise<WorldEntry> {
  const entries = await listWorldEntries(workDirPath)
  const entry = entries.find((e) => e.meta.id === entryId)
  if (!entry) throw new WorldEntryNotFoundError(entryId)
  return entry
}

export interface WorldEntryUpsert {
  /** Omit to create (a ULID is minted); pass to update the existing entry in place. */
  id?: string
  name: string
  keys?: string[]
  image?: string | null
  shortSummary?: string | null
  createdBy: 'user' | 'agent'
  body: string
  /**
   * Optimistic-concurrency token (03 §3.5 PATCH): xxh64 of the entry's current BODY.
   * Requires `id`. A stale token returns the §6.6-style conflict result; omitting the
   * token keeps the historical last-write-wins create/update semantics.
   */
  baseHash?: string
}

/**
 * Create or update an entry (§5.4 frontmatter + Markdown body). Updates keep the
 * existing file path even when the name changes — filename slugs are a human mirror,
 * and renames are the reconciler's territory (§8). `updatedAt` is stamped here.
 * With `baseHash` set, a vanished target throws WorldEntryNotFoundError (typed 404,
 * never a conflict — the conflict shape cannot represent a missing entry).
 */
export async function upsertWorldEntry(
  workDirPath: string,
  input: WorldEntryUpsert,
): Promise<WorldEntryWriteResult> {
  await ensureDir(worldEntriesDir(workDirPath))
  const existing =
    input.id === undefined
      ? undefined
      : (await listWorldEntries(workDirPath)).find((e) => e.meta.id === input.id)

  if (input.baseHash !== undefined) {
    if (input.id === undefined) {
      throw new StorageError('baseHash requires an entry id (create carries no token)', 'invalid', {
        kind: 'world',
      })
    }
    if (existing === undefined) throw new WorldEntryNotFoundError(input.id)
    const currentHash = await xxh64OfString(existing.body)
    if (currentHash !== input.baseHash) {
      return { ok: false, conflict: { currentHash, currentText: existing.body } }
    }
  }

  const id = input.id ?? ulid()
  const meta = WorldEntryMeta.parse({
    id,
    name: input.name,
    keys: input.keys ?? existing?.meta.keys ?? [],
    image: input.image !== undefined ? input.image : (existing?.meta.image ?? null),
    shortSummary:
      input.shortSummary !== undefined ? input.shortSummary : (existing?.meta.shortSummary ?? null),
    createdBy: input.createdBy,
    updatedAt: nowIso(),
  })
  const filePath =
    existing?.filePath ??
    path.join(worldEntriesDir(workDirPath), worldEntryFileName(slugify(input.name), id))
  await writeFileAtomic(filePath, serializeEntry(meta, input.body))
  return { ok: true, entry: { meta, body: input.body, filePath } }
}

/**
 * Delete an entry and its own image assets (PNG + sidecar). This is an explicit API
 * delete, not a reconciler action — the never-delete-user-files rule (§8) binds the
 * reconciler, not deliberate deletion.
 */
export async function deleteWorldEntry(workDirPath: string, entryId: string): Promise<void> {
  const entry = await getWorldEntry(workDirPath, entryId)
  await fsp.rm(entry.filePath, { force: true })
  await fsp.rm(worldImagePath(workDirPath, entryId), { force: true })
  await fsp.rm(worldImageSidecarPath(workDirPath, entryId), { force: true })
}

/**
 * Atomic PNG write to `world/images/<entryId>.png` + IllustrationMeta sidecar JSON
 * (§5.2 — world entries have no section.json to host the meta), then point the entry's
 * `image` field at it. The path is stored work-relative with forward slashes (§10.6);
 * the §5.4 sample's entry-relative `../images/…` spelling loses to the schema comment.
 */
export async function putWorldImage(
  workDirPath: string,
  entryId: string,
  png: Uint8Array,
  meta: IllustrationMeta,
): Promise<{ imagePath: string }> {
  const entry = await getWorldEntry(workDirPath, entryId)
  const valid = IllustrationMeta.parse(meta)
  await ensureDir(worldImagesDir(workDirPath))
  // Crash-consistent commit (§14): stage the PNG, write the sidecar meta + point the entry's
  // frontmatter at the image, then swap the PNG into place last. A failure before the final
  // rename discards the staged bytes, so a crash mid-first-generation never leaves an orphaned,
  // invisible PNG (bytes on disk that nothing references and nothing sweeps).
  const finalPng = worldImagePath(workDirPath, entryId)
  const stagedPng = `${finalPng}.staging`
  const imagePath = worldImageRelPath(entryId)
  try {
    await writeFileAtomic(stagedPng, png)
    await writeFileAtomic(
      worldImageSidecarPath(workDirPath, entryId),
      `${JSON.stringify(valid, null, 2)}\n`,
    )
    const updated = WorldEntryMeta.parse({ ...entry.meta, image: imagePath })
    await writeFileAtomic(entry.filePath, serializeEntry(updated, entry.body))
    await fsp.rename(stagedPng, finalPng)
  } finally {
    await fsp.rm(stagedPng, { force: true }).catch(() => undefined)
  }
  return { imagePath }
}

/**
 * Clear an entry's image: null the frontmatter pointer and remove the PNG + sidecar.
 * Throws WorldEntryNotFoundError for an unknown entry; a no-image entry is an idempotent
 * no-op (`removed: false`) — stray bytes are still swept either way.
 */
export async function deleteWorldImage(
  workDirPath: string,
  entryId: string,
): Promise<{ removed: boolean }> {
  const entry = await getWorldEntry(workDirPath, entryId)
  const removed = entry.meta.image !== null
  if (removed) {
    const updated = WorldEntryMeta.parse({ ...entry.meta, image: null })
    await writeFileAtomic(entry.filePath, serializeEntry(updated, entry.body))
  }
  await fsp.rm(worldImagePath(workDirPath, entryId), { force: true })
  await fsp.rm(worldImageSidecarPath(workDirPath, entryId), { force: true })
  return { removed }
}

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g

/** Whole-word-ish: the term must not be flanked by letters/digits on either side. */
function termMatches(term: string, text: string): boolean {
  const trimmed = term.trim()
  if (trimmed === '') return false
  const escaped = trimmed.replace(REGEX_SPECIALS, '\\$&')
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu')
  return re.test(text)
}

/**
 * Pure, index-free key scan (§2.6): case-insensitive whole-word-ish match of each
 * entry's name and keys over `text`. Multi-word keys ("the keeper") match as phrases.
 * Consumers: the illustration pipeline's intent briefs (08 §compose) and search; the
 * index-backed variant arrives with the SQLite phase and must stay behaviorally equal.
 */
export function matchWorldEntries(entries: WorldEntry[], text: string): WorldEntry[] {
  return entries.filter((entry) =>
    [entry.meta.name, ...entry.meta.keys].some((term) => termMatches(term, text)),
  )
}
