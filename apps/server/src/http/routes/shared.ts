import type {
  IllustrationMeta,
  SectionRow,
  WorkDetail,
  WorkSettings,
  WorkSettingsUpdate,
  WorldEntryDto,
} from '@cowrite/shared'
import { IllustrationMeta as IllustrationMetaSchema } from '@cowrite/shared'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { hydrateSection } from '../../events/adapter.js'
import { xxh64OfString } from '../../storage/lib/hash.js'
import { readPngDimensions } from '../../storage/lib/png.js'
import type { StorageService, WorkHandle } from '../../storage/service.js'
import type { WorldEntry } from '../../storage/storageTypes.js'
import { AppError } from '../errors.js'
import type { OpenWork, WorkRegistry } from '../workRegistry.js'

/**
 * Shared plumbing for the resource routes (docs/03-api.md §3): dependency shape, the
 * Zod-type-provider instance alias, param access, and the DTO mappers that more than one
 * route file needs. Handlers stay thin — validate, call the WorkHandle, shape the DTO —
 * and throw `AppError`/typed storage errors for the §7 envelope.
 */

export interface ResourceDeps {
  works: WorkRegistry
  storage: StorageService
}

export function withZod(app: FastifyInstance) {
  return app.withTypeProvider<ZodTypeProvider>()
}
/** A Fastify instance with the Zod type provider applied — what route files register on. */
export type RouteApp = ReturnType<typeof withZod>

/** Read a path param (`:w`, `:s`, …) that Fastify guarantees present on a matched route. */
export function param(req: FastifyRequest, name: string): string {
  const value = (req.params as Record<string, string | undefined>)[name]
  if (value === undefined) throw new AppError('internal', `missing route param :${name}`)
  return value
}

/** Lazy-open the work named by `:w` (docs/03 §4.1); 404s for an unknown id. */
export function openWork(deps: ResourceDeps, req: FastifyRequest): Promise<OpenWork> {
  return deps.works.open(param(req, 'w'))
}

// ---------------------------------------------------------------------------
// Works
// ---------------------------------------------------------------------------

/** WorkDetail (03 §3.1) from an open handle: meta + live counts + lock state. The
 *  counts/updatedAt come from the index aggregate shared with the works list (one
 *  encoding, zero per-request file reads); createdAt is the empty-work floor. */
export function toWorkDetail(open: OpenWork): WorkDetail {
  const { handle } = open
  const counts = handle.workCounts()
  return {
    id: handle.work.id,
    title: handle.work.title,
    slug: open.slug,
    wordCount: counts.wordCount,
    snippetCount: counts.snippetCount,
    sectionCount: counts.sectionCount,
    updatedAt: counts.updatedAt ?? handle.work.createdAt,
    settings: handle.work.settings,
    levelScheme: handle.work.levelScheme,
    readonly: handle.readOnly,
  }
}

function definedOnly<T extends object>(obj: T | undefined): Partial<T> {
  if (obj === undefined) return {}
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>
}

/** PATCH /works/:w true-partial merge: absent fields keep their saved values (03 §3.1). */
export function mergeSettings(current: WorkSettings, update: WorkSettingsUpdate): WorkSettings {
  return {
    consolidation: { ...current.consolidation, ...definedOnly(update.consolidation) },
    illustrationStaleWordDeltaPct:
      update.illustrationStaleWordDeltaPct ?? current.illustrationStaleWordDeltaPct,
    contextOverrides:
      update.contextOverrides === undefined
        ? current.contextOverrides
        : { ...current.contextOverrides, ...definedOnly(update.contextOverrides) },
  }
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

/** One section as the shared SectionRow DTO (the adapter's hydrator core); 404 when the
 *  id is unknown — the route-facing wrapper over the null-returning `hydrateSection`. */
export function hydrateSectionRow(handle: WorkHandle, sectionId: string): SectionRow {
  const section = hydrateSection(handle, sectionId)
  if (section === null) throw new AppError('not_found', `no section '${sectionId}'`)
  return section
}

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

/** WorldEntryDto (03 §3.5); the image version answers from the index files table.
 *  `bodyHash` is the PATCH baseHash concurrency token, computed from the body served. */
export async function toWorldEntryDto(
  handle: WorkHandle,
  entry: WorldEntry,
): Promise<WorldEntryDto> {
  let imageVersion: string | null = null
  try {
    imageVersion = handle.worldImagePath(entry.meta.id)?.version ?? null
  } catch {
    // Not indexed yet (entry created moments ago): no streamable image either way.
  }
  return {
    id: entry.meta.id,
    name: entry.meta.name,
    keys: entry.meta.keys,
    body: entry.body,
    bodyHash: await xxh64OfString(entry.body),
    shortSummary: entry.meta.shortSummary,
    hasImage: imageVersion !== null,
    imageVersion,
    updatedAt: entry.meta.updatedAt,
  }
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

/** Raw `image/png` request body: must be a Buffer with a well-formed PNG header. */
export function requirePng(body: unknown): Buffer {
  if (!Buffer.isBuffer(body) || readPngDimensions(body) === null) {
    throw new AppError('validation', 'request body is not a valid PNG')
  }
  return body
}

/** IllustrationMeta for a user upload (03 §3.10, 08 §8): no run, no prompt, no source. */
export function userUploadMeta(): IllustrationMeta {
  return IllustrationMetaSchema.parse({
    source: 'user',
    runId: null,
    generatedAt: new Date().toISOString(),
    sourceHash: null,
    sourceWordCount: null,
    entities: [],
    prompt: null,
    workflow: null,
    workflowHash: null,
    seed: null,
    attempts: null,
    score: null,
    guidance: null,
  })
}
