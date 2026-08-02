import type { FastifyInstance } from 'fastify'
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod'

/**
 * fastify-type-provider-zod wiring (docs/03-api.md §5.2): route options carry the shared
 * Zod schemas directly, the validator compiler rejects bad input (mapped to the §7
 * envelope by the global error handler), and the serializer compiler runs RESPONSES
 * through Zod too — a handler returning a malformed DTO fails loudly instead of shipping
 * a contract break.
 */

export type { ZodTypeProvider }

/** The buildApp return type: a Fastify instance with the Zod type provider applied. */
export type ZodApp = ReturnType<typeof useZod>

/** Install BOTH compilers and return the type-provider-scoped instance. */
export function useZod(app: FastifyInstance) {
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)
  return app.withTypeProvider<ZodTypeProvider>()
}
