import { z } from 'zod'

/**
 * Placeholder contract while the real data model lands (see docs/02-data-model.md).
 * Everything the server and web app exchange is defined here as a Zod schema,
 * so both sides share one runtime-validated contract.
 */

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  app: z.literal('cowrite'),
  version: z.string(),
})

export type HealthResponse = z.infer<typeof healthResponseSchema>
