import fsp from 'node:fs/promises'
import path from 'node:path'
import { RevisionEvent, SnippetMeta } from '@cowrite/shared'
import { ulid } from 'ulid'
import { StorageError } from './errors.js'
import { parseFrontmatter, serializeFrontmatter } from './lib/frontmatter.js'
import {
  appendJsonlLine,
  ensureDir,
  readIfExists,
  readJsonl,
  truncateTornTail,
  writeFileAtomic,
} from './lib/fsx.js'
import { wordCount } from './lib/hash.js'
import { compareOrderKeys, keyBetween } from './lib/orderKeys.js'
import {
  frontierRevisionsDir,
  frontierSnippetsDir,
  parseSnippetFileName,
  revisionLogPath,
  shortId,
  snippetFileName,
} from './lib/paths.js'
import type { SnippetFile, SnippetWriteResult } from './storageTypes.js'

/**
 * Frontier snippet file store (spec 02 §2.4, §5.4, §6.1, §6.6): one frontmatter `.md`
 * per live snippet, one full-text `RevisionEvent` JSONL per snippet, fractional
 * orderKeys with in-memory reservations (§4), numeric filename prefixes as a human
 * mirror only (never authoritative).
 */

/** Thrown when a snippet id resolves to no frontier file (e.g. consolidated away). The
 *  service phase maps this onto its own conflict/404 story — a §6.6 conflict result needs
 *  `currentRev`/`currentText`, which a vanished snippet cannot supply. */
export class SnippetNotFoundError extends StorageError {
  constructor(readonly snippetId: string) {
    super(`snippet not found in frontier: ${snippetId}`, 'not_found', {
      kind: 'snippet',
      id: snippetId,
    })
    this.name = 'SnippetNotFoundError'
  }
}

/** Thrown by restoreSnippet for a revision that never existed in the log (§6.6): a
 *  vanished/unknown target is a typed NotFound for the API to map to 404, never a
 *  conflict result (the conflict shape cannot represent it). */
export class RevisionNotFoundError extends StorageError {
  constructor(
    readonly snippetId: string,
    readonly rev: number,
  ) {
    super(`snippet ${snippetId} has no revision ${rev}`, 'not_found', {
      kind: 'snippet-revision',
      id: snippetId,
    })
    this.name = 'RevisionNotFoundError'
  }
}

/** Thrown by appendSnippet for an explicit orderKey that is neither a live reservation
 *  nor collision-free against the existing frontier (§4) — e.g. a key whose reservation
 *  was already consumed by an earlier committed append. */
export class OrderKeyConflictError extends StorageError {
  constructor(readonly orderKey: string) {
    super(
      `orderKey '${orderKey}' is not reserved and already belongs to a frontier snippet`,
      'conflict',
      { kind: 'orderKey', id: orderKey },
    )
    this.name = 'OrderKeyConflictError'
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

function maxOrderKey(a: string | null, b: string | null): string | null {
  if (a === null) return b
  if (b === null) return a
  return compareOrderKeys(a, b) >= 0 ? a : b
}

/**
 * In-memory registry of reserved orderKeys (§4): the harness reserves a key at task
 * start so the agent's forthcoming snippet has a stable position, and any append made
 * while reservations are live lands *after* them. Purely in-memory by design — a crash
 * loses only reservations, never files; released reservations leave no gap to repair.
 */
export class OrderKeyReservations {
  private readonly live = new Set<string>()

  /** Largest live reserved key, or null when none. */
  last(): string | null {
    let max: string | null = null
    for (const key of this.live) max = maxOrderKey(max, key)
    return max
  }

  /** Allocate a key after both `lastExistingKey` and every live reservation. */
  reserveAfter(lastExistingKey: string | null): string {
    const key = keyBetween(maxOrderKey(lastExistingKey, this.last()), null)
    this.live.add(key)
    return key
  }

  /** Release a reservation whose task ended without committing. Unknown keys are a no-op. */
  release(key: string): void {
    this.live.delete(key)
  }

  /** Consume a reservation at commit time; returns whether the key was reserved. */
  consume(key: string): boolean {
    return this.live.delete(key)
  }

  has(key: string): boolean {
    return this.live.has(key)
  }
}

/** Reserve the next orderKey after the last of (existing snippets ∪ live reservations). */
export async function reserveOrderKey(
  workDirPath: string,
  reservations: OrderKeyReservations,
): Promise<string> {
  const existing = await listSnippetFiles(workDirPath)
  return reservations.reserveAfter(existing[existing.length - 1]?.meta.orderKey ?? null)
}

async function appendRevisionEvent(
  workDirPath: string,
  snippetId: string,
  event: unknown,
): Promise<void> {
  const logPath = revisionLogPath(workDirPath, snippetId)
  // A crash mid-append can leave a torn final line — unterminated OR terminated but
  // unparseable (§9.1). Readers drop it, but appending after it would leave MID-file
  // garbage getRevisions rejects, so physically drop it first (shared with runStore).
  await truncateTornTail(logPath)
  await appendJsonlLine(logPath, RevisionEvent.parse(event))
}

/** Frontmatter serialization order matches the §5.4 sample. Exported for the
 *  reconciler's frontmatter write-back at adoption time (§8). */
export function serializeSnippet(meta: SnippetMeta, text: string): string {
  return serializeFrontmatter(
    {
      id: meta.id,
      orderKey: meta.orderKey,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      authorship: meta.authorship,
      originRunId: meta.originRunId,
      rev: meta.rev,
    },
    text,
  )
}

/**
 * Parse every recognizable frontier snippet, sorted by orderKey with ULID tiebreak (§4).
 * Files whose name or frontmatter does not validate are skipped here — adopting or
 * repairing foreign files is the reconciler's job (§8), not the read path's.
 */
export async function listSnippetFiles(workDirPath: string): Promise<SnippetFile[]> {
  const dir = frontierSnippetsDir(workDirPath)
  let names: string[]
  try {
    names = await fsp.readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const files: SnippetFile[] = []
  for (const name of names) {
    if (!parseSnippetFileName(name)) continue
    const filePath = path.join(dir, name)
    const raw = await readIfExists(filePath)
    if (raw === null) continue
    const parsed = parseFrontmatter(raw)
    if (!parsed.hadFrontmatter) continue
    const meta = SnippetMeta.safeParse(parsed.data)
    if (!meta.success) continue
    files.push({
      meta: meta.data,
      text: parsed.body,
      filePath,
      fileName: name,
      wordCount: wordCount(parsed.body),
    })
  }
  files.sort(
    (a, b) =>
      compareOrderKeys(a.meta.orderKey, b.meta.orderKey) ||
      (a.meta.id < b.meta.id ? -1 : a.meta.id > b.meta.id ? 1 : 0),
  )
  return files
}

/** Parse the snippet at `filePath` iff it is valid and carries `snippetId`; else null. */
async function tryReadSnippetAt(filePath: string, snippetId: string): Promise<SnippetFile | null> {
  const raw = await readIfExists(filePath)
  if (raw === null) return null
  const parsed = parseFrontmatter(raw)
  if (!parsed.hadFrontmatter) return null
  const meta = SnippetMeta.safeParse(parsed.data)
  if (!meta.success || meta.data.id !== snippetId) return null
  return {
    meta: meta.data,
    text: parsed.body,
    filePath,
    fileName: path.basename(filePath),
    wordCount: wordCount(parsed.body),
  }
}

/**
 * Read one snippet by id. Throws SnippetNotFoundError when it is not in the frontier.
 * Resolution order (§7.3 — never scan the whole frontier when a cheaper truth-checked
 * route exists): the caller's `filePathHint` (an index row's file_path, absolute or
 * work-relative), then the filename short-id match (§3), then the full scan. Every fast
 * path verifies the frontmatter id, so a stale hint can never serve the wrong snippet.
 */
export async function readSnippet(
  workDirPath: string,
  snippetId: string,
  filePathHint?: string,
): Promise<SnippetFile> {
  if (filePathHint !== undefined) {
    const abs = path.isAbsolute(filePathHint)
      ? filePathHint
      : path.join(workDirPath, ...filePathHint.split('/'))
    const hit = await tryReadSnippetAt(abs, snippetId)
    if (hit !== null) return hit
  }
  const dir = frontierSnippetsDir(workDirPath)
  const sid = shortId(snippetId)
  let names: string[] = []
  try {
    names = await fsp.readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  for (const name of names) {
    if (parseSnippetFileName(name)?.shortId !== sid) continue
    const hit = await tryReadSnippetAt(path.join(dir, name), snippetId)
    if (hit !== null) return hit
  }
  // Fallback: a hand-renamed file can carry any name; only the frontmatter knows.
  const files = await listSnippetFiles(workDirPath)
  const found = files.find((f) => f.meta.id === snippetId)
  if (!found) throw new SnippetNotFoundError(snippetId)
  return found
}

/**
 * Next numeric filename prefix: the next multiple of 10 after the current max across all
 * recognizable snippet filenames (10 for an empty frontier). The prefix is the human
 * mirror of ordering ONLY (§4) — frontmatter orderKey is authoritative, and the
 * reconciler renumbers drifted prefixes lazily.
 */
async function nextFilePrefix(workDirPath: string): Promise<number> {
  let max = 0
  try {
    for (const name of await fsp.readdir(frontierSnippetsDir(workDirPath))) {
      const parsed = parseSnippetFileName(name)
      if (parsed && parsed.prefix > max) max = parsed.prefix
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  return (Math.floor(max / 10) + 1) * 10
}

export interface AppendSnippetOptions {
  author: 'user' | 'agent'
  runId?: string
  /** Explicit key (a reserved key, or a between-neighbors insert). Omit to append last. */
  orderKey?: string
  /** When given, appendSnippet consumes `orderKey` from it, and an append WITHOUT an
   *  explicit key lands after every live reservation (§4). */
  reservations?: OrderKeyReservations
}

/**
 * Create a new frontier snippet: frontmatter file + first RevisionEvent line (§6.1).
 * Returns the validated SnippetMeta.
 */
export async function appendSnippet(
  workDirPath: string,
  text: string,
  opts: AppendSnippetOptions,
): Promise<SnippetMeta> {
  const snippetsDir = frontierSnippetsDir(workDirPath)
  await ensureDir(snippetsDir)
  await ensureDir(frontierRevisionsDir(workDirPath))

  let orderKey: string
  let reserved = false
  if (opts.orderKey !== undefined) {
    orderKey = opts.orderKey
    reserved = opts.reservations?.has(orderKey) ?? false
    if (!reserved) {
      // Not a live reservation: allowed only when it collides with no existing snippet
      // (a between-neighbors insert). A duplicate of a committed key here is a caller
      // bug — e.g. re-using a reservation that was already consumed (§4).
      const existing = await listSnippetFiles(workDirPath)
      if (existing.some((f) => f.meta.orderKey === orderKey)) {
        throw new OrderKeyConflictError(orderKey)
      }
    }
  } else {
    const existing = await listSnippetFiles(workDirPath)
    const lastExisting = existing[existing.length - 1]?.meta.orderKey ?? null
    orderKey = keyBetween(maxOrderKey(lastExisting, opts.reservations?.last() ?? null), null)
  }

  const ts = nowIso()
  const runId = opts.author === 'agent' ? (opts.runId ?? null) : null
  const meta = SnippetMeta.parse({
    id: ulid(),
    orderKey,
    createdAt: ts,
    updatedAt: ts,
    authorship: opts.author,
    originRunId: runId,
    rev: 1,
  })
  const prefix = await nextFilePrefix(workDirPath)
  const filePath = path.join(snippetsDir, snippetFileName(prefix, meta.id))
  await writeFileAtomic(filePath, serializeSnippet(meta, text))
  // Consume the reservation only once the snippet file has landed: a failed write must
  // leave the reservation intact so the task can retry at the same key (§4), and the
  // key can never be handed out twice because it stays reserved until this point.
  if (reserved) opts.reservations?.consume(orderKey)
  await appendRevisionEvent(workDirPath, meta.id, {
    type: 'revision',
    rev: 1,
    ts,
    author: opts.author,
    ...(runId === null ? {} : { runId }),
    text,
  })
  return meta
}

/** user edit on an agent snippet ⇒ mixed, and vice versa; mixed stays mixed (§2.4). */
function transitionAuthorship(
  current: 'user' | 'agent' | 'mixed',
  editor: 'user' | 'agent',
): 'user' | 'agent' | 'mixed' {
  if (current === 'mixed') return 'mixed'
  return current === editor ? current : 'mixed'
}

export interface ReviseSnippetOptions {
  author: 'user' | 'agent'
  runId?: string
  baseRev: number
  /** Index-row file_path fast path for the read (verified; stale hints fall back). */
  filePathHint?: string
}

/**
 * One reviseSnippet call = one revision event (§2.4). §6.6 contract: `baseRev` must equal
 * the snippet's current rev, otherwise the current state is returned as a conflict.
 * Atomic file rewrite + revision append. The ok result carries the written `filePath`
 * so the caller can re-index without re-resolving the snippet.
 */
export async function reviseSnippet(
  workDirPath: string,
  snippetId: string,
  text: string,
  opts: ReviseSnippetOptions,
): Promise<SnippetWriteResult> {
  const current = await readSnippet(workDirPath, snippetId, opts.filePathHint)
  if (current.meta.rev !== opts.baseRev) {
    return { ok: false, conflict: { currentRev: current.meta.rev, currentText: current.text } }
  }
  const ts = nowIso()
  const rev = current.meta.rev + 1
  const meta = SnippetMeta.parse({
    ...current.meta,
    updatedAt: ts,
    authorship: transitionAuthorship(current.meta.authorship, opts.author),
    rev,
  })
  await writeFileAtomic(current.filePath, serializeSnippet(meta, text))
  const runId = opts.author === 'agent' ? opts.runId : undefined
  await appendRevisionEvent(workDirPath, snippetId, {
    type: 'revision',
    rev,
    ts,
    author: opts.author,
    ...(runId === undefined ? {} : { runId }),
    text,
  })
  return { ok: true, rev, filePath: current.filePath }
}

/**
 * Restore an old revision by appending a NEW revision carrying the old text — the log
 * stays append-only ("cycle & roll back", §6.6). No baseRev: restore always wins over
 * the current tip. Throws RevisionNotFoundError when `rev` does not exist in the log.
 */
export async function restoreSnippet(
  workDirPath: string,
  snippetId: string,
  rev: number,
  opts: { author: 'user' | 'agent'; filePathHint?: string },
): Promise<{ ok: true; rev: number; filePath: string }> {
  const events = await getRevisions(workDirPath, snippetId)
  const target = events.find((e) => e.rev === rev)
  if (!target) throw new RevisionNotFoundError(snippetId, rev)
  const current = await readSnippet(workDirPath, snippetId, opts.filePathHint)
  const ts = nowIso()
  const newRev = current.meta.rev + 1
  const meta = SnippetMeta.parse({
    ...current.meta,
    updatedAt: ts,
    authorship: transitionAuthorship(current.meta.authorship, opts.author),
    rev: newRev,
  })
  await writeFileAtomic(current.filePath, serializeSnippet(meta, target.text))
  await appendRevisionEvent(workDirPath, snippetId, {
    type: 'revision',
    rev: newRev,
    ts,
    author: opts.author,
    text: target.text,
  })
  return { ok: true, rev: newRev, filePath: current.filePath }
}

/**
 * All revision events for a snippet, oldest first. Torn-tail tolerant via readJsonl
 * (§9.1); a missing log reads as empty. Lines that parse as JSON but fail the schema
 * indicate real corruption and throw.
 */
export async function getRevisions(
  workDirPath: string,
  snippetId: string,
): Promise<RevisionEvent[]> {
  const { lines } = await readJsonl(revisionLogPath(workDirPath, snippetId))
  return lines.map((line) => RevisionEvent.parse(line))
}
