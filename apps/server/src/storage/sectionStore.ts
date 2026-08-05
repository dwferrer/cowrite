import type { Dirent } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { EnrichmentMeta, IllustrationMeta, SectionMeta } from '@cowrite/shared'
import { StorageError } from './errors.js'
import { ensureDir, readIfExists, writeFileAtomic } from './lib/fsx.js'
import { xxh64OfString } from './lib/hash.js'
import { compareOrderKeys } from './lib/orderKeys.js'
import { sectionsDir } from './lib/paths.js'
import type { SectionNode, SectionWriteResult } from './storageTypes.js'

/**
 * Section-tree file store (spec 02 §2.3, §2.5, §5.2, §6.5, §6.6): section.json metadata,
 * leaf content.md with baseHash optimistic writes, summary/illustration enrichments.
 * Section *creation* is the consolidation engine's job (service phase); this store reads
 * and mutates existing section dirs.
 */

export class SectionNotFoundError extends StorageError {
  constructor(readonly sectionId: string) {
    super(`section not found: ${sectionId}`, 'not_found', { kind: 'section', id: sectionId })
    this.name = 'SectionNotFoundError'
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

function sectionMetaPath(sectionDirPath: string): string {
  return path.join(sectionDirPath, 'section.json')
}

function contentPath(sectionDirPath: string): string {
  return path.join(sectionDirPath, 'content.md')
}

function summaryPath(sectionDirPath: string, kind: 'short' | 'long'): string {
  return path.join(sectionDirPath, `summary-${kind}.md`)
}

function illustrationPath(sectionDirPath: string): string {
  return path.join(sectionDirPath, 'illustration.png')
}

/** Parse and validate `<sectionDir>/section.json`. Throws on a missing or invalid file. */
export async function readSectionMeta(sectionDirPath: string): Promise<SectionMeta> {
  const raw = await readIfExists(sectionMetaPath(sectionDirPath))
  if (raw === null) throw new Error(`section.json not found in ${sectionDirPath}`)
  return SectionMeta.parse(JSON.parse(raw))
}

/**
 * Parse raw section.json text; null when invalid. Exported so callers that already
 * hold the bytes (the index loader reads each file exactly once, §7.3) share the SAME
 * validity predicate as tryReadSectionMeta.
 */
export function parseSectionMeta(raw: string): SectionMeta | null {
  try {
    return SectionMeta.parse(JSON.parse(raw))
  } catch {
    return null
  }
}

/**
 * Parse `<sectionDir>/section.json`; null when missing or invalid. This is THE
 * section-dir predicate (§5.2, §8 — files are truth): a directory is a section dir iff
 * it holds a valid section.json, regardless of its name. The tree walk here, the
 * reconciler, and the index scan must all share it, or a hand-renamed section dir
 * would survive reconcile but vanish from a full rebuild (index != rebuild).
 */
export async function tryReadSectionMeta(sectionDirPath: string): Promise<SectionMeta | null> {
  const raw = await readIfExists(sectionMetaPath(sectionDirPath))
  if (raw === null) return null
  return parseSectionMeta(raw)
}

/** Validate and atomically replace `<sectionDir>/section.json` (pretty-printed, §5.1). */
export async function writeSectionMeta(sectionDirPath: string, meta: SectionMeta): Promise<void> {
  const valid = SectionMeta.parse(meta)
  await ensureDir(sectionDirPath)
  await writeFileAtomic(sectionMetaPath(sectionDirPath), `${JSON.stringify(valid, null, 2)}\n`)
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fsp.stat(p)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

async function walkInto(
  dirPath: string,
  depth: number,
  parentId: string | null,
  out: SectionNode[],
): Promise<void> {
  let entries: Dirent[]
  try {
    entries = await fsp.readdir(dirPath, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }
  const siblings: SectionNode[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const childDir = path.join(dirPath, entry.name)
    // A directory is a section dir iff it holds a valid section.json. Anything else is
    // "unrecognized" — the reconciler reports those (§8); the read path skips them.
    const meta = await tryReadSectionMeta(childDir)
    if (meta === null) continue
    siblings.push({
      meta,
      dirPath: childDir,
      depth,
      parentId,
      leaf: await fileExists(contentPath(childDir)),
    })
  }
  siblings.sort(
    (a, b) =>
      compareOrderKeys(a.meta.orderKey, b.meta.orderKey) ||
      (a.meta.id < b.meta.id ? -1 : a.meta.id > b.meta.id ? 1 : 0),
  )
  for (const node of siblings) {
    out.push(node)
    await walkInto(node.dirPath, depth + 1, node.meta.id, out)
  }
}

/**
 * Depth-first pre-order walk of `sections/**`: siblings sorted by orderKey with ULID
 * tiebreak; interior vs leaf decided by the presence of content.md (§2.3). A missing
 * sections/ dir walks as empty.
 */
export async function walkSectionTree(workDirPath: string): Promise<SectionNode[]> {
  const out: SectionNode[] = []
  await walkInto(sectionsDir(workDirPath), 0, null, out)
  return out
}

/**
 * Try to materialize the SectionNode at one KNOWN directory (the §7.2 index row's
 * dir_path) without walking the tree: the dir's section.json must be valid and carry
 * `sectionId`, and — files being the truth — every ancestor up to sections/ must still
 * be a valid section dir, or the node would not exist in a tree walk. Null on any miss.
 */
async function tryNodeAt(
  workDirPath: string,
  dirPathHint: string,
  sectionId: string,
): Promise<SectionNode | null> {
  const abs = path.isAbsolute(dirPathHint)
    ? dirPathHint
    : path.join(workDirPath, ...dirPathHint.split('/'))
  const rel = path.relative(sectionsDir(workDirPath), abs)
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`)) return null
  const meta = await tryReadSectionMeta(abs)
  if (meta === null || meta.id !== sectionId) return null
  const depth = rel.split(path.sep).length - 1
  let parentId: string | null = null
  if (depth > 0) {
    const parentMeta = await tryReadSectionMeta(path.dirname(abs))
    if (parentMeta === null) return null // orphaned dir: a tree walk would not reach it
    parentId = parentMeta.id
  }
  return { meta, dirPath: abs, depth, parentId, leaf: await fileExists(contentPath(abs)) }
}

/**
 * Locate a section node by id. Throws SectionNotFoundError. `dirPathHint` (the index
 * row's work-relative dir_path, when the caller has one) skips the whole-tree walk;
 * a stale or wrong hint silently falls back to the walk (§7.3 — the index is a cache).
 */
export async function findSection(
  workDirPath: string,
  sectionId: string,
  dirPathHint?: string,
): Promise<SectionNode> {
  if (dirPathHint !== undefined) {
    const node = await tryNodeAt(workDirPath, dirPathHint, sectionId)
    if (node !== null) return node
  }
  const nodes = await walkSectionTree(workDirPath)
  const node = nodes.find((n) => n.meta.id === sectionId)
  if (!node) throw new SectionNotFoundError(sectionId)
  return node
}

/** Leaf prose + its hash (the §6.6 concurrency token). Throws on interior sections. */
export async function getSectionContent(
  workDirPath: string,
  sectionId: string,
  dirPathHint?: string,
): Promise<{ text: string; contentHash: string }> {
  const node = await findSection(workDirPath, sectionId, dirPathHint)
  const text = await readIfExists(contentPath(node.dirPath))
  if (text === null) {
    throw new StorageError(`section ${sectionId} has no content.md (interior section)`, 'invalid', {
      kind: 'section',
      id: sectionId,
    })
  }
  return { text, contentHash: await xxh64OfString(text) }
}

async function currentContentState(
  sectionDirPath: string,
): Promise<{ text: string | null; hash: string | null }> {
  const text = await readIfExists(contentPath(sectionDirPath))
  return { text, hash: text === null ? null : await xxh64OfString(text) }
}

async function writeContent(node: SectionNode, text: string): Promise<{ contentHash: string }> {
  const contentHash = await xxh64OfString(text)
  await writeFileAtomic(contentPath(node.dirPath), text)
  await writeSectionMeta(node.dirPath, { ...node.meta, contentHash })
  return { contentHash }
}

/**
 * §6.6: `baseHash` must equal the hash of the current content.md (null = no content
 * yet); otherwise the current hash is returned as a conflict. On success the file is
 * replaced atomically and section.json's contentHash is updated.
 */
export async function replaceSectionContent(
  workDirPath: string,
  sectionId: string,
  text: string,
  opts: { baseHash: string | null },
  dirPathHint?: string,
): Promise<SectionWriteResult> {
  const node = await findSection(workDirPath, sectionId, dirPathHint)
  const current = await currentContentState(node.dirPath)
  if (current.hash !== opts.baseHash) {
    // §6.6/§8: the conflict carries the current state so the client can offer the
    // theirs/mine prompt without a second read.
    return { ok: false, conflict: { currentHash: current.hash, currentText: current.text } }
  }
  const { contentHash } = await writeContent(node, text)
  return { ok: true, contentHash }
}

/**
 * Replace `[startChar, endChar)` of the content that `baseHash` was computed from —
 * span offsets are only meaningful against that exact text (§6.6), so the hash check
 * runs first and an invalid span against the *matching* text throws (caller bug, not a
 * conflict). `runId` is accepted for the §11 signature; provenance recording lands with
 * the index (run_artifacts), not in the files.
 */
export async function replaceSectionSpan(
  workDirPath: string,
  sectionId: string,
  span: { startChar: number; endChar: number },
  text: string,
  opts: { runId?: string; baseHash: string | null },
  dirPathHint?: string,
): Promise<SectionWriteResult> {
  const node = await findSection(workDirPath, sectionId, dirPathHint)
  const current = await currentContentState(node.dirPath)
  if (current.hash !== opts.baseHash) {
    return { ok: false, conflict: { currentHash: current.hash, currentText: current.text } }
  }
  const base = current.text ?? ''
  const { startChar, endChar } = span
  if (
    !Number.isInteger(startChar) ||
    !Number.isInteger(endChar) ||
    startChar < 0 ||
    endChar < startChar ||
    endChar > base.length
  ) {
    throw new RangeError(
      `invalid span [${startChar}, ${endChar}) for content of length ${base.length}`,
    )
  }
  const spliced = base.slice(0, startChar) + text + base.slice(endChar)
  const { contentHash } = await writeContent(node, spliced)
  return { ok: true, contentHash }
}

/**
 * Title with titleSource pinning (§2.5): an agent may never overwrite a user title.
 * Deviation from the §11 `void` return: the boolean tells the caller whether the write
 * was pinned away, which the service layer needs to report a skipped artifact.
 */
export async function setSectionTitle(
  workDirPath: string,
  sectionId: string,
  title: string,
  opts: { source: 'user' | 'agent' },
  dirPathHint?: string,
): Promise<{ applied: boolean }> {
  const node = await findSection(workDirPath, sectionId, dirPathHint)
  if (opts.source === 'agent' && node.meta.titleSource === 'user') {
    return { applied: false }
  }
  await writeSectionMeta(node.dirPath, { ...node.meta, title, titleSource: opts.source })
  return { applied: true }
}

/**
 * Write a summary file + its EnrichmentMeta (§6.5). The stamped `sourceHash` is the
 * hash of the prose the summary was derived FROM: an agent commit passes the
 * ASSEMBLY-TIME contentHash via `opts.sourceHash` — if the prose changed while the run
 * was in flight, the summary still lands but correctly reads stale. A user edit (or an
 * agent commit without the hash) stamps the CURRENT content.md — a user-edited summary
 * is not stale until the prose changes again. Summaries only exist on leaf sections;
 * missing content.md throws.
 */
export async function putSummary(
  workDirPath: string,
  sectionId: string,
  kind: 'short' | 'long',
  text: string,
  opts: { source: 'user' | 'agent'; runId?: string; sourceHash?: string },
  dirPathHint?: string,
): Promise<EnrichmentMeta> {
  const node = await findSection(workDirPath, sectionId, dirPathHint)
  const content = await readIfExists(contentPath(node.dirPath))
  if (content === null) {
    throw new StorageError(
      `section ${sectionId} has no content.md; summaries are leaf-only (§2.3)`,
      'invalid',
      { kind: 'section', id: sectionId },
    )
  }
  const meta = EnrichmentMeta.parse({
    source: opts.source,
    // runId is null iff source === 'user' (§10.3): user edits carry no run.
    runId: opts.source === 'user' ? null : (opts.runId ?? null),
    generatedAt: nowIso(),
    sourceHash:
      opts.source === 'agent' && opts.sourceHash !== undefined
        ? opts.sourceHash
        : await xxh64OfString(content),
  })
  await writeFileAtomic(summaryPath(node.dirPath, kind), text)
  const enrichments = { ...node.meta.enrichments }
  if (kind === 'short') enrichments.shortSummary = meta
  else enrichments.longSummary = meta
  await writeSectionMeta(node.dirPath, { ...node.meta, enrichments })
  return meta
}

/**
 * Read both summary files for a section — the GET …/summaries lazy fetch (03 §3.2).
 * A missing file reads as null (never generated, or an interior section); staleness is
 * the index's concern, not this read's. Throws SectionNotFoundError for unknown ids.
 */
export async function getSummaries(
  workDirPath: string,
  sectionId: string,
  dirPathHint?: string,
): Promise<{ short: string | null; long: string | null }> {
  const node = await findSection(workDirPath, sectionId, dirPathHint)
  return {
    short: await readIfExists(summaryPath(node.dirPath, 'short')),
    long: await readIfExists(summaryPath(node.dirPath, 'long')),
  }
}

/**
 * Atomic PNG write + IllustrationMeta into section.json's illustration slot (§2.5).
 * Overwrites any prior image or tombstone — an explicit put is the user/pipeline intent.
 */
export async function putIllustration(
  workDirPath: string,
  sectionId: string,
  png: Uint8Array,
  meta: IllustrationMeta,
  dirPathHint?: string,
): Promise<void> {
  const node = await findSection(workDirPath, sectionId, dirPathHint)
  const valid = IllustrationMeta.parse(meta)
  // Crash-consistent commit (§14): stage the new PNG bytes off to the side, write the
  // section.json meta, and only then swap the PNG into place with a single rename. A failure
  // writing the meta leaves BOTH the live illustration.png and section.json at their OLD state
  // (the staged bytes are discarded) — never new bytes with stale meta. The cache-buster
  // (`illustrationHash`) is derived from the committed PNG bytes at reindex, so it can never go
  // stale against what is served.
  const finalPng = illustrationPath(node.dirPath)
  const stagedPng = `${finalPng}.staging`
  try {
    await writeFileAtomic(stagedPng, png)
    await writeSectionMeta(node.dirPath, {
      ...node.meta,
      enrichments: { ...node.meta.enrichments, illustration: valid },
    })
    await fsp.rename(stagedPng, finalPng)
  } finally {
    await fsp.rm(stagedPng, { force: true }).catch(() => undefined)
  }
}

/**
 * User deleted the image: remove the PNG and record the §2.5 tombstone
 * `{suppressed: true, deletedAt}` so the enrichment sweep never regenerates it.
 */
export async function suppressIllustration(
  workDirPath: string,
  sectionId: string,
  dirPathHint?: string,
): Promise<void> {
  const node = await findSection(workDirPath, sectionId, dirPathHint)
  await fsp.rm(illustrationPath(node.dirPath), { force: true })
  await writeSectionMeta(node.dirPath, {
    ...node.meta,
    enrichments: {
      ...node.meta.enrichments,
      illustration: { suppressed: true, deletedAt: nowIso() },
    },
  })
}

/**
 * Lift a tombstone back to null (never-had-one), letting the sweep regenerate. A present
 * illustration is left untouched — clearing suppression is only meaningful on a tombstone.
 */
export async function clearSuppression(
  workDirPath: string,
  sectionId: string,
  dirPathHint?: string,
): Promise<void> {
  const node = await findSection(workDirPath, sectionId, dirPathHint)
  const slot = node.meta.enrichments.illustration
  if (slot === null || !('suppressed' in slot)) return
  await writeSectionMeta(node.dirPath, {
    ...node.meta,
    enrichments: { ...node.meta.enrichments, illustration: null },
  })
}
