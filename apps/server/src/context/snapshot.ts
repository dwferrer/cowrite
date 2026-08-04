import type { SyncHasher } from './estimate.js'

/**
 * WorkSnapshot capture (docs/06-context-engine.md §10): the session snapshots the section
 * tree, summaries, snippet list, world entries, and situation at `beginTask`; every read
 * during the task is served from the snapshot, so background writes landing mid-task are
 * invisible until the next `beginTask` (which captures afresh — the "queued and applied at
 * the next beginTask" policy falls out of per-task capture; the one explicitly queued
 * signal, the anchor refresh on `enrichment.completed`, is engine state).
 *
 * The reader interfaces are the injectable seam of 06 §9.3's `EngineDeps` — WorkHandle
 * satisfies them via a thin adapter in routes.ts; tests build synthetic works directly.
 */

// ---------------------------------------------------------------------------
// Injected readers (everything injected = everything mockable)
// ---------------------------------------------------------------------------

/** One section as the manuscript reader serves it (a SectionRow-shaped slice). */
export interface SectionSource {
  id: string
  parentId: string | null
  /** Level name from the work's levelScheme (e.g. 'chapter'). */
  kind: string
  orderKey: string
  title: string | null
  /** null ⇒ interior section (no prose of its own — 02 §sections). */
  contentHash: string | null
  frozenAt: string | null
  wordCount: number
  shortSummary: string | null
  longSummary: string | null
}

export interface ManuscriptReader {
  levelScheme(): string[]
  listSections(): SectionSource[]
  getSectionContent(sectionId: string): Promise<{ text: string; contentHash: string }>
  listSnippets(): Promise<Array<{ id: string; orderKey: string; text: string }>>
}

export interface WorldInfoReader {
  listEntries(): Promise<
    Array<{ id: string; name: string; shortSummary: string | null; body: string }>
  >
}

export interface SituationReader {
  getSituation(): Promise<{ text: string }>
}

// ---------------------------------------------------------------------------
// The frozen snapshot
// ---------------------------------------------------------------------------

export interface SnapshotSection {
  id: string
  parentId: string | null
  kind: string
  orderKey: string
  /** Display name: the title, or 'untitled <kind>' (06 §4.2). */
  name: string
  /** Ancestor names joined by ' › ' (excluding self); '' for roots. */
  path: string
  depth: number
  /** true when the section carries prose (content.md present). */
  leaf: boolean
  frozenAt: string | null
  wordCount: number
  contentHash: string | null
  shortSummary: string | null
  longSummary: string | null
  /** Leaf prose, captured at snapshot; null for interior sections. */
  content: string | null
}

export interface SnapshotSnippet {
  id: string
  orderKey: string
  text: string
}

export interface SnapshotWorldEntry {
  id: string
  name: string
  shortSummary: string | null
  body: string
  bodyHash: string
}

export interface WorkSnapshot {
  levelScheme: string[]
  /** Document (tree) order: (parent chain, orderKey, id). */
  sections: SnapshotSection[]
  sectionById: Map<string, SnapshotSection>
  /** Frontier order: (orderKey, id). */
  snippets: SnapshotSnippet[]
  /** Entry-creation order (ULID ascending — 06 §5.1 world-info ordering). */
  worldEntries: SnapshotWorldEntry[]
  worldById: Map<string, SnapshotWorldEntry>
  situation: string
}

export function sectionDisplayName(title: string | null, kind: string): string {
  return title ?? `untitled ${kind}`
}

/** Flatten `sources` into document order (depth-first by (orderKey, id) at each level). */
export function documentOrder(sources: SectionSource[]): SectionSource[] {
  const byParent = new Map<string | null, SectionSource[]>()
  const ids = new Set(sources.map((s) => s.id))
  for (const s of sources) {
    // An orphaned parent pointer (externally mangled tree) roots the subtree rather than
    // dropping it — the coverage invariant beats tree pedantry.
    const parent = s.parentId !== null && ids.has(s.parentId) ? s.parentId : null
    const list = byParent.get(parent)
    if (list) list.push(s)
    else byParent.set(parent, [s])
  }
  for (const list of byParent.values()) {
    list.sort((a, b) =>
      a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : a.id < b.id ? -1 : 1,
    )
  }
  const out: SectionSource[] = []
  const walk = (parent: string | null): void => {
    for (const s of byParent.get(parent) ?? []) {
      out.push(s)
      walk(s.id)
    }
  }
  walk(null)
  return out
}

/**
 * Section-content cache keyed by the index's contentHash: a capture only reads leaves
 * whose hash it has not seen (cold reads run in parallel), so a warm re-capture of an
 * unchanged manuscript performs ZERO content reads. After each capture the cache is
 * pruned to the hashes the snapshot actually references, so revised sections never
 * accumulate dead generations. Owned per-engine (one work), shared across captures.
 */
export type SectionContentCache = Map<string, string>

export async function captureSnapshot(
  readers: {
    manuscript: ManuscriptReader
    worldInfo: WorldInfoReader
    situation: SituationReader
  },
  hasher: SyncHasher,
  contentCache?: SectionContentCache,
): Promise<WorkSnapshot> {
  const levelScheme = readers.manuscript.levelScheme()
  const ordered = documentOrder(readers.manuscript.listSections())

  // Resolve leaf contents up front: cache hits by contentHash, cold reads in parallel.
  const contentById = new Map<string, { text: string; contentHash: string }>()
  const cold: SectionSource[] = []
  for (const s of ordered) {
    if (s.contentHash === null) continue
    const cached = contentCache?.get(s.contentHash)
    if (cached !== undefined) contentById.set(s.id, { text: cached, contentHash: s.contentHash })
    else cold.push(s)
  }
  await Promise.all(
    cold.map(async (s) => {
      contentById.set(s.id, await readers.manuscript.getSectionContent(s.id))
    }),
  )
  if (contentCache !== undefined) {
    contentCache.clear()
    for (const read of contentById.values()) contentCache.set(read.contentHash, read.text)
  }

  const idSet = new Set(ordered.map((s) => s.id))
  const byId = new Map(ordered.map((s) => [s.id, s]))
  const nameOf = (s: SectionSource): string => sectionDisplayName(s.title, s.kind)
  const pathOf = (s: SectionSource): { path: string; depth: number } => {
    const names: string[] = []
    let cursor = s.parentId !== null && idSet.has(s.parentId) ? byId.get(s.parentId) : undefined
    let depth = 0
    while (cursor !== undefined) {
      names.unshift(nameOf(cursor))
      depth += 1
      cursor =
        cursor.parentId !== null && idSet.has(cursor.parentId)
          ? byId.get(cursor.parentId)
          : undefined
    }
    return { path: names.join(' › '), depth }
  }

  const sections: SnapshotSection[] = []
  for (const s of ordered) {
    const { path, depth } = pathOf(s)
    const leaf = s.contentHash !== null
    let content: string | null = null
    let contentHash = s.contentHash
    if (leaf) {
      const read = contentById.get(s.id)
      if (read === undefined) throw new Error(`section ${s.id} lost its content mid-capture`)
      content = read.text
      contentHash = read.contentHash
    }
    sections.push({
      id: s.id,
      parentId: s.parentId !== null && idSet.has(s.parentId) ? s.parentId : null,
      kind: s.kind,
      orderKey: s.orderKey,
      name: nameOf(s),
      path,
      depth,
      leaf,
      frozenAt: s.frozenAt,
      wordCount: s.wordCount,
      contentHash,
      shortSummary: s.shortSummary,
      longSummary: s.longSummary,
      content,
    })
  }

  const snippets = (await readers.manuscript.listSnippets())
    .slice()
    .sort((a, b) =>
      a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : a.id < b.id ? -1 : 1,
    )

  const worldEntries: SnapshotWorldEntry[] = (await readers.worldInfo.listEntries())
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((e) => ({ ...e, bodyHash: hasher.hash(e.body) }))

  const situation = (await readers.situation.getSituation()).text

  return {
    levelScheme,
    sections,
    sectionById: new Map(sections.map((s) => [s.id, s])),
    snippets,
    worldEntries,
    worldById: new Map(worldEntries.map((e) => [e.id, e])),
    situation,
  }
}
