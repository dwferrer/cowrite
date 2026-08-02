import type {
  Hash,
  IsoTime,
  SectionMeta,
  SnippetMeta,
  Ulid,
  WorkMeta,
  WorldEntryMeta,
} from '@cowrite/shared'
import type { SnippetRow, WorkCounts } from './index/db.js'

/**
 * Shared-internal result and row types for the entity file stores (spec 02 §6.6, §11).
 * The service-phase types live next to their owners: `StorageChange` in events.ts,
 * `ReconcileReport` in reconciler.ts.
 */

// ---------------------------------------------------------------------------
// Optimistic-concurrency results (§6.6): conflicts are returned, never thrown.
// ---------------------------------------------------------------------------

export type OkOrConflict<Ok extends object, Conflict extends object> =
  | ({ ok: true } & Ok)
  | { ok: false; conflict: Conflict }

/** reviseSnippet — token is `rev`. `filePath` (absolute) lets the service re-index the
 *  written file without re-resolving the snippet (§7.3). */
export type SnippetWriteResult = OkOrConflict<
  { rev: number; filePath: string },
  { currentRev: number; currentText: string }
>

/** replaceSectionContent / replaceSectionSpan — token is `contentHash` (null = no content
 *  yet). The conflict carries the current text too: spec §8's theirs/mine prompt needs it. */
export type SectionWriteResult = OkOrConflict<
  { contentHash: Hash },
  { currentHash: Hash | null; currentText: string | null }
>

/** putSituation — token is the content `hash` (mtime is display-only, §2.2). */
export type SituationWriteResult = OkOrConflict<
  { updatedAt: IsoTime; hash: Hash },
  { currentText: string; updatedAt: IsoTime; hash: Hash }
>

/** upsertWorldEntry — token is the xxh64 of the entry's current BODY (03 §3.5 PATCH
 *  `baseHash`; mirrors sections' shape). No token ⇒ last-write-wins, as before. */
export type WorldEntryWriteResult = OkOrConflict<
  { entry: WorldEntry },
  { currentHash: Hash; currentText: string }
>

// ---------------------------------------------------------------------------
// Store row sources
// ---------------------------------------------------------------------------

/**
 * One entry per `works/*` directory; unparsable works surface as warnings, never throw.
 * (Named WorkListing because the shared DTO owns the name `WorkSummary` — 03 §3.1.)
 * `counts` are cheap works-list numbers read from the work's existing index without the
 * work lock; null when the index is absent, stale-versioned, or unreadable. The store
 * fills `counts: null`; the StorageService facade populates it.
 */
export type WorkListing =
  | { slug: string; ok: true; meta: WorkMeta; counts: WorkCounts | null }
  | { slug: string; ok: false; warning: string }

/** Frontier snippet index row joined with its full text — the SnippetDto source (03 §3.3). */
export type SnippetWithText = SnippetRow & { text: string }

/** Parsed frontier snippet file — the source a SQLite `snippets` row is built from (§7.1). */
export interface SnippetFile {
  meta: SnippetMeta
  text: string
  filePath: string
  fileName: string
  wordCount: number
}

/** One node from walkSectionTree; `leaf` = content.md present (§2.3: interior dirs have none). */
export interface SectionNode {
  meta: SectionMeta
  dirPath: string
  depth: number
  parentId: Ulid | null
  leaf: boolean
}

/** Parsed world entry: frontmatter meta + Markdown body (§5.4). */
export interface WorldEntry {
  meta: WorldEntryMeta
  body: string
  filePath: string
}
