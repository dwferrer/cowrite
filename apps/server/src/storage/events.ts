import type { Ulid } from '@cowrite/shared'

/**
 * Storage-originated change events (spec 02 §11): every committed mutation — app writes,
 * reconciler adoptions, staleness flips — emits exactly one `StorageChange`. The union
 * maps 1:1 onto the storage-originated members of the canonical `WorkEvent` union (owned
 * by 03 §SSE); the API layer subscribes via `onChange` and fans out over SSE. Storage
 * itself never touches HTTP.
 */

export type EnrichmentName = 'shortSummary' | 'longSummary' | 'illustration' | 'title'

export type StorageChange =
  | { type: 'work.changed' }
  | { type: 'situation.changed' }
  | { type: 'snippet.created'; snippetId: Ulid }
  | { type: 'snippet.updated'; snippetId: Ulid }
  | { type: 'snippet.removed'; snippetId: Ulid }
  | { type: 'section.changed'; sectionId: Ulid }
  | { type: 'enrichment.updated'; sectionId: Ulid; enrichment: EnrichmentName }
  | { type: 'world.updated'; entryId: Ulid }
  | { type: 'world.removed'; entryId: Ulid }
  | { type: 'run.recorded'; runId: Ulid }

export type StorageChangeListener = (event: StorageChange) => void
export type Unsubscribe = () => void

/**
 * Minimal synchronous fan-out. Listeners are isolated: one throwing subscriber must
 * never break a committed storage mutation or starve the other subscribers.
 */
export class StorageEvents {
  private readonly listeners = new Set<StorageChangeListener>()

  on(listener: StorageChangeListener): Unsubscribe {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  emit(event: StorageChange): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch {
        // subscriber errors are the subscriber's problem, not storage's
      }
    }
  }
}
