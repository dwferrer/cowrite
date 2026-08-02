import type { ApiErrorBody, ErrorCode } from '@cowrite/shared'
import type { FastifyInstance } from 'fastify'
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod'
import { ulid } from 'ulid'
import { StorageError } from '../storage/errors.js'
import { NotImplementedError, ReadOnlyError, WorkClosedError } from '../storage/service.js'

/**
 * The error envelope (docs/03-api.md §7): one shape for every non-2xx JSON response.
 * Handlers never hand-build error JSON — they throw `AppError(code, message, details)`
 * (or let typed storage errors propagate) and the global handler maps code → status via
 * the closed table below. Anything unrecognized becomes `internal` with a `logRef` ULID
 * printed to the server console so the toast and the log line can be matched.
 */

export class AppError extends Error {
  readonly code: ErrorCode
  readonly details: unknown

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.details = details
  }
}

/** The closed ErrorCode → HTTP status table (§7; the shared `ErrorCode` enum owns the codes). */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  validation: 400,
  forbidden_host: 403,
  not_found: 404,
  conflict: 409,
  busy: 409,
  readonly: 409,
  payload_too_large: 413,
  // task/agent codes (05 §failure taxonomy), surfaced at task-create time
  config_missing: 409,
  auth: 502,
  endpoint_unreachable: 502,
  rate_limited: 429,
  timeout: 504,
  output_invalid: 502,
  pipeline: 502,
  crash: 500,
  not_implemented: 501,
  internal: 500,
}

/** Build the §7 envelope body — the ONLY way error JSON is shaped anywhere. */
export function errorBody(code: ErrorCode, message: string, details?: unknown): ApiErrorBody {
  return {
    error: { code, message, ...(details === undefined ? {} : { details }) },
  }
}

interface IssueTree {
  errors: string[]
  properties?: Record<string, IssueTree>
}

/** Treeified Zod issues (per §7, mirroring `z.treeifyError`) from the compiler's list. */
function treeifyValidation(issues: Array<{ instancePath: string; message?: string }>): IssueTree {
  const root: IssueTree = { errors: [] }
  for (const issue of issues) {
    let node = root
    for (const segment of issue.instancePath.split('/')) {
      if (segment === '') continue
      node.properties ??= {}
      node = node.properties[segment] ??= { errors: [] }
    }
    node.errors.push(issue.message ?? 'invalid')
  }
  return root
}

interface Mapped {
  status: number
  code: ErrorCode
  message: string
  details?: unknown
}

function mapKnown(err: unknown): Mapped | null {
  if (err instanceof AppError) {
    return {
      status: ERROR_STATUS[err.code],
      code: err.code,
      message: err.message,
      ...(err.details === undefined ? {} : { details: err.details }),
    }
  }
  if (hasZodFastifySchemaValidationErrors(err)) {
    return {
      status: 400,
      code: 'validation',
      message: 'request validation failed',
      details: treeifyValidation(err.validation),
    }
  }
  // Typed storage errors (02 §11): the API layer maps them without string matching.
  if (err instanceof NotImplementedError) {
    return { status: 501, code: 'not_implemented', message: err.message }
  }
  if (err instanceof WorkClosedError) {
    return { status: 409, code: 'conflict', message: err.message }
  }
  if (err instanceof ReadOnlyError) {
    return { status: 409, code: 'readonly', message: err.message }
  }
  if (err instanceof StorageError) {
    switch (err.code) {
      case 'not_found':
        return { status: 404, code: 'not_found', message: err.message }
      case 'read_only':
        return { status: 409, code: 'readonly', message: err.message }
      case 'conflict':
        return { status: 409, code: 'conflict', message: err.message }
      case 'invalid':
        return { status: 400, code: 'validation', message: err.message }
      case 'not_implemented':
        return { status: 501, code: 'not_implemented', message: err.message }
    }
  }
  // Typed not-founds that predate StorageError (RunNotFoundError extends plain Error).
  if (err instanceof Error && err.name.endsWith('NotFoundError')) {
    return { status: 404, code: 'not_found', message: err.message }
  }
  if (err instanceof Error) {
    const statusCode = (err as { statusCode?: number }).statusCode
    if (statusCode === 413) return { status: 413, code: 'payload_too_large', message: err.message }
    if (statusCode === 415 || statusCode === 400) {
      // unsupported media type / unparsable body — request-shaped, not our bug
      return { status: 400, code: 'validation', message: err.message }
    }
  }
  return null
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, req, reply) => {
    if (isResponseSerializationError(err)) {
      // A handler returned an off-contract DTO — a contract break must fail loudly (§12).
      const logRef = ulid()
      console.error(
        `[cowrite] response-contract break ${logRef} on ${req.method} ${req.url}:`,
        err.cause ?? err,
      )
      return reply
        .status(500)
        .send(errorBody('internal', 'response failed contract validation', { logRef }))
    }
    const mapped = mapKnown(err)
    if (mapped !== null) {
      return reply
        .status(mapped.status)
        .send(errorBody(mapped.code, mapped.message, mapped.details))
    }
    const logRef = ulid()
    console.error(`[cowrite] internal error ${logRef} on ${req.method} ${req.url}:`, err)
    return reply.status(500).send(errorBody('internal', 'internal server error', { logRef }))
  })
}
