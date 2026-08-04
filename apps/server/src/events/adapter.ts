import type { SectionRow, SnippetDto, WorkEvent } from '@cowrite/shared'
import { StorageError } from '../storage/errors.js'
import type { StorageChange } from '../storage/events.js'
import type { SectionRow as IndexSectionRow } from '../storage/index/db.js'
import type { WorkHandle } from '../storage/service.js'
import type { SnippetWithText } from '../storage/storageTypes.js'
import type { WorkEventBus } from './bus.js'

/**
 * storage `onChange` → canonical `WorkEvent` translation with hydration (docs/03-api.md
 * §8.2). Storage changes carry only ids; the wire contract requires payloads sufficient
 * to patch the client cache without a refetch, so the adapter re-reads the entity through
 * the same WorkHandle before publishing. Domain events therefore fire for EVERY mutation
 * regardless of origin — REST call, agent commit, or reconciler adoption.
 *
 * Hydration is async while `onChange` is sync, so changes queue into a batch drained on
 * a FIFO promise chain: publish order always matches commit order, and section
 * hydrations are coalesced per sectionId within one drain tick (a bulk reconcile that
 * touches a section many times hydrates it once). A change whose entity vanished before
 * hydration (created-then-deleted races) is dropped — the follow-up deletion event is
 * the truth the client needs.
 *
 * `work.changed` and `run.recorded` stay in-process only (§8.5): they route to the bus's
 * local channel, never onto the wire.
 */

export interface StorageAdapter {
  /** Stop translating; already-queued hydrations still drain. */
  detach(): void
  /** Resolves when every change received so far has been hydrated and published. */
  settled(): Promise<void>
}

export interface AdapterOptions {
  onError?: (err: unknown) => void
}

export function toSnippetDto(snippet: SnippetWithText): SnippetDto {
  return {
    id: snippet.id,
    orderKey: snippet.orderKey,
    text: snippet.text,
    rev: snippet.rev,
    authorship: snippet.authorship,
    originRunId: snippet.originRunId,
    updatedAt: snippet.updatedAt,
    revisionCount: snippet.revisionCount,
  }
}

/**
 * The doc-view row rule (03 §3.2): `longSummary` is inlined for sections at or above
 * chapter level and omitted (null ⇒ lazy `GET …/summaries`) for the scheme's deepest
 * level — except in a single-level scheme, where every section is that top level.
 * An unknown kind is treated as deepest (the client can always lazy-fetch).
 */
export function inlinesLongSummary(kind: string, levelScheme: string[]): boolean {
  if (levelScheme.length <= 1) return true
  const index = levelScheme.indexOf(kind)
  return index !== -1 && index < levelScheme.length - 1
}

/** Index row (summaries inlined, schema v2) → the shared `SectionRow` DTO (03 §3.2). */
export function toSectionRowDto(row: IndexSectionRow, levelScheme: string[]): SectionRow {
  const illustration =
    row.illustrationHash !== null &&
    row.illustrationWidth !== null &&
    row.illustrationHeight !== null
      ? {
          version: row.illustrationHash,
          width: row.illustrationWidth,
          height: row.illustrationHeight,
        }
      : null
  return {
    id: row.id,
    parentId: row.parentId,
    kind: row.kind,
    orderKey: row.orderKey,
    title: row.title,
    titleSource: row.titleSource,
    isLeaf: row.contentHash !== null,
    wordCount: row.wordCount,
    contentHash: row.contentHash,
    shortSummary: row.shortSummary,
    longSummary: inlinesLongSummary(row.kind, levelScheme) ? row.longSummary : null,
    illustration,
    stale: {
      short: row.shortSummaryStale,
      long: row.longSummaryStale,
      illustration: row.illustrationStale,
    },
  }
}

/**
 * The ONE section hydrator (shared by the SSE adapter and the resource routes): index
 * point lookup → DTO, zero file reads. Returns null for an unknown/vanished section —
 * the route wrapper maps that to 404, the adapter drops the event.
 */
export function hydrateSection(handle: WorkHandle, sectionId: string): SectionRow | null {
  const row = handle.getSection(sectionId)
  return row === null ? null : toSectionRowDto(row, handle.work.levelScheme)
}

const ENRICHMENT_KIND = {
  shortSummary: 'short',
  longSummary: 'long',
  title: 'title',
  illustration: 'illustration',
} as const

export function attachStorageAdapter(
  handle: WorkHandle,
  bus: WorkEventBus,
  options: AdapterOptions = {},
): StorageAdapter {
  const onError = options.onError ?? (() => {})
  let tail: Promise<void> = Promise.resolve()
  let queue: StorageChange[] = []
  let drainScheduled = false

  /** Per-drain-tick section DTO cache: one hydration per sectionId per batch. */
  const translate = async (
    change: StorageChange,
    sections: Map<string, SectionRow | null>,
  ): Promise<WorkEvent | null> => {
    const sectionFor = (sectionId: string): SectionRow | null => {
      const cached = sections.get(sectionId)
      if (cached !== undefined) return cached
      const fresh = hydrateSection(handle, sectionId)
      sections.set(sectionId, fresh)
      return fresh
    }

    switch (change.type) {
      case 'snippet.created':
        return {
          type: 'snippet.created',
          snippet: toSnippetDto(await handle.getSnippet(change.snippetId)),
        }
      case 'snippet.updated':
        return {
          type: 'snippet.revised',
          snippet: toSnippetDto(await handle.getSnippet(change.snippetId)),
        }
      case 'snippet.removed':
        return { type: 'snippet.deleted', id: change.snippetId }
      case 'section.changed': {
        const section = sectionFor(change.sectionId)
        return section === null ? null : { type: 'section.changed', section }
      }
      case 'sections.restructured':
        // deliberate refetch signal (03 §8.2) — no payload to hydrate
        return { type: 'sections.restructured' }
      case 'consolidation.applied': {
        // The wire row carries the toast title (03 §8.2): the first frozen section's
        // title, or '' until the enrichment agent names it (heuristic splits start
        // untitled) — plus the grace deadline the client's toast TTL derives from.
        const first = change.sectionIds[0]
        const section = first === undefined ? null : sectionFor(first)
        return {
          type: 'consolidation.applied',
          sectionIds: change.sectionIds,
          title: section?.title ?? '',
          undoToken: change.undoToken,
          undoDeadline: change.undoDeadline,
        }
      }
      case 'consolidation.undone':
        return { type: 'consolidation.undone', sectionIds: change.sectionIds }
      case 'consolidation.finalized':
        return { type: 'consolidation.finalized', opId: change.opId }
      case 'enrichment.updated': {
        const section = sectionFor(change.sectionId)
        if (section === null) return null
        return {
          type: 'enrichment.updated',
          sectionId: change.sectionId,
          kind: ENRICHMENT_KIND[change.enrichment],
          section,
        }
      }
      case 'world.updated':
        return { type: 'world.changed', entryId: change.entryId }
      case 'world.removed':
        // A deleted entry cannot be patched by refetching it — signal a list refetch.
        return { type: 'world.changed' }
      case 'situation.changed': {
        const situation = await handle.getSituation()
        return {
          type: 'situation.changed',
          text: situation.text,
          updatedAt: situation.updatedAt,
          // the fresh concurrency token — lets the web tell self-echoes from foreign edits
          hash: situation.hash,
        }
      }
      case 'work.changed':
      case 'run.recorded':
        // §8.5 in-process channel: never on the wire.
        bus.publishLocal({ ...change })
        return null
    }
  }

  const drain = async (): Promise<void> => {
    drainScheduled = false
    const batch = queue
    queue = []
    const sections = new Map<string, SectionRow | null>()
    for (const change of batch) {
      try {
        const event = await translate(change, sections)
        if (event !== null) bus.publish(event)
      } catch (err) {
        // The entity vanished between commit and hydration: the follow-up removal
        // event is authoritative; everything else is the caller's to log.
        if (err instanceof StorageError && err.code === 'not_found') continue
        onError(err)
      }
    }
  }

  const unsubscribe = handle.onChange((change) => {
    queue.push(change)
    if (drainScheduled) return
    drainScheduled = true
    tail = tail.then(drain)
  })

  return {
    detach: unsubscribe,
    settled: () => tail.then(() => {}),
  }
}
