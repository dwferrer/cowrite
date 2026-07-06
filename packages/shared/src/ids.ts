import { z } from 'zod'

/**
 * Primitives shared by every schema (docs/02-data-model.md §10.1).
 * All entity ids are bare ULIDs; payloads mixing id kinds carry an explicit `kind` field (02 §3).
 */

export const Ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/)
export type Ulid = z.infer<typeof Ulid>

/** Fractional order key over the base-36 alphabet (02 §4). */
export const OrderKey = z.string().regex(/^[0-9a-z]+$/)
export type OrderKey = z.infer<typeof OrderKey>

// The doc spells this `z.string().datetime()`; zod 4 deprecates that in favour of
// `z.iso.datetime()` with identical validation semantics (UTC 'Z' suffix, no offsets).
export const IsoTime = z.iso.datetime()
export type IsoTime = z.infer<typeof IsoTime>

export const Hash = z.string().regex(/^xxh64:[0-9a-f]{16}$/)
export type Hash = z.infer<typeof Hash>

export const EntityKind = z.enum(['work', 'section', 'snippet', 'world', 'run'])
export type EntityKind = z.infer<typeof EntityKind>
