import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { api } from '@cowrite/shared'
import type { FastifyReply } from 'fastify'
import type { WorkHandle } from '../../storage/service.js'
import { AppError } from '../errors.js'
import {
  openWork,
  param,
  type ResourceDeps,
  type RouteApp,
  requirePng,
  userUploadMeta,
} from './shared.js'

/**
 * Image routes (docs/03-api.md §3.10): stream section illustrations and world images
 * from disk (no @fastify/static — paths come from index rows, so a tiny read-stream
 * handler with a path-containment check is safer), `Cache-Control: immutable` behind the
 * `?v=` content-hash version, `ETag` from the same hash, 404 on absent/suppressed/escaped.
 * Plus the M1 user upload (source: "user", replaces any tombstone) and the suppression
 * delete for section illustrations.
 */

const IMMUTABLE = 'public, max-age=31536000, immutable'

/** Resolve, containment-check (must stay inside the work dir), stat, and stream a PNG. */
async function streamPng(
  handle: WorkHandle,
  info: { absPath: string; version: string } | null,
  etagOf: (version: string) => string,
  ifNoneMatch: string | undefined,
  reply: FastifyReply,
): Promise<FastifyReply> {
  if (info === null) throw new AppError('not_found', 'no image')
  const resolved = path.resolve(info.absPath)
  const rel = path.relative(path.resolve(handle.workDir), resolved)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    // A path that escapes the work dir is never streamable (§11 failure table).
    throw new AppError('not_found', 'no image')
  }
  try {
    await fsp.access(resolved)
  } catch {
    throw new AppError('not_found', 'no image')
  }
  const etag = etagOf(info.version)
  reply.header('etag', etag).header('cache-control', IMMUTABLE)
  if (ifNoneMatch === etag) return reply.code(304).send()
  return reply.type('image/png').send(fs.createReadStream(resolved))
}

function ifNoneMatchOf(headers: { 'if-none-match'?: string | string[] }): string | undefined {
  const value = headers['if-none-match']
  return typeof value === 'string' ? value : undefined
}

export function registerImageRoutes(app: RouteApp, deps: ResourceDeps): void {
  app.route({
    method: 'GET',
    url: '/api/works/:w/sections/:s/illustration',
    handler: async (req, reply) => {
      const { handle } = await openWork(deps, req)
      // Throws SectionNotFoundError (404) for unknown ids; null covers both "never had
      // one" and the user-suppressed tombstone — 404 either way (§3.10).
      const info = handle.sectionIllustrationPath(param(req, 's'))
      return streamPng(handle, info, (v) => `"${v}"`, ifNoneMatchOf(req.headers), reply)
    },
  })

  app.route({
    method: 'POST',
    url: '/api/works/:w/sections/:s/illustration',
    schema: { response: { 200: api.uploadSectionIllustration.res } },
    handler: async (req) => {
      const { handle } = await openWork(deps, req)
      const sectionId = param(req, 's')
      const png = requirePng(req.body)
      // putIllustration overwrites any prior image or tombstone (08 §8 user upload).
      await handle.putIllustration(sectionId, png, userUploadMeta())
      const info = handle.sectionIllustrationPath(sectionId)
      if (info === null) throw new AppError('internal', 'uploaded illustration did not index')
      return { illustrationVersion: info.version }
    },
  })

  app.route({
    method: 'DELETE',
    url: '/api/works/:w/sections/:s/illustration',
    handler: async (req, reply) => {
      const { handle } = await openWork(deps, req)
      // Deletes the PNG and writes the suppression tombstone (08 §5); idempotent.
      await handle.suppressIllustration(param(req, 's'))
      return reply.code(204).send()
    },
  })

  app.route({
    method: 'GET',
    url: '/api/works/:w/world/:e/image',
    handler: async (req, reply) => {
      const { handle } = await openWork(deps, req)
      // Throws WorldEntryNotFoundError (404) for unknown entries; null when the entry
      // has no image, the file vanished, or its path escaped the work dir.
      const info = handle.worldImagePath(param(req, 'e'))
      return streamPng(handle, info, (v) => `"${v}"`, ifNoneMatchOf(req.headers), reply)
    },
  })
}
