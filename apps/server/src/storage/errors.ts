/**
 * Typed storage-layer errors (spec 02 §6.6, §11). Every error the storage layer throws
 * on purpose extends `StorageError`, carrying a machine-readable `code` plus the entity
 * `kind`/`id` involved, so the API layer (03) can map errors to HTTP without string
 * matching. Conflicts are NOT errors — they are returned as typed results (§6.6); the
 * 'conflict' code exists only for caller bugs like reusing a consumed order key.
 */

export type StorageErrorCode =
  | 'not_found'
  | 'read_only'
  | 'conflict'
  | 'invalid'
  | 'not_implemented'

export class StorageError extends Error {
  readonly code: StorageErrorCode
  /** Entity kind involved, e.g. 'work' | 'section' | 'snippet' | 'world' | 'orderKey'. */
  readonly kind: string | null
  /** Entity id (or slug/key) involved, when one exists. */
  readonly id: string | null

  constructor(message: string, code: StorageErrorCode, opts: { kind?: string; id?: string } = {}) {
    super(message)
    this.name = 'StorageError'
    this.code = code
    this.kind = opts.kind ?? null
    this.id = opts.id ?? null
  }
}
