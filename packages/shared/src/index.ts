import { z } from 'zod'

/**
 * Single runtime-validated contract between server and web (docs/02-data-model.md §10, §14).
 * Every schema module re-exports here; server and web import from '@cowrite/shared' only.
 */

export * from './context.js'
export * from './enrichment.js'
export * from './ids.js'
export * from './illustration.js'
export * from './runs.js'
export * from './section.js'
export * from './situation.js'
export * from './snippet.js'
export * from './tasks.js'
export * from './work.js'
export * from './world.js'

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  app: z.literal('cowrite'),
  version: z.string(),
})

export type HealthResponse = z.infer<typeof healthResponseSchema>
