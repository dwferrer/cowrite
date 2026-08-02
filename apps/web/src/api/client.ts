import {
  ApiErrorBody,
  type ApiRouteName,
  type ApiRoutes,
  api,
  type ErrorCode,
  type RouteDef,
} from '@cowrite/shared'
import type { z } from 'zod'

/**
 * Thin typed fetch wrapper over the shared route registry (docs/04-frontend.md §4.2).
 * Every JSON response is Zod-parsed against the registry's `res` schema so a contract break
 * fails loudly; every non-2xx is decoded from the one error envelope into `ApiError`.
 */

type Route<N extends ApiRouteName> = ApiRoutes[N]
type PathParams<N extends ApiRouteName> = Parameters<Route<N>['path']>
/** Request-body input type (z.input — defaults/optionals still sparse) for a route. */
export type ApiBody<N extends ApiRouteName> =
  Route<N> extends { body: infer B extends z.ZodType } ? z.input<B> : never

/** Parsed 2xx response type for a route; `undefined` for 204/raw routes. */
export type ApiResult<N extends ApiRouteName> =
  Route<N> extends { res: infer R extends z.ZodType } ? z.output<R> : undefined

type BodyInput<N extends ApiRouteName> = ApiBody<N>
type ResOutput<N extends ApiRouteName> = ApiResult<N>

/** Non-2xx response, decoded from the shared error envelope (03 §7). Safe to toast `message`. */
export class ApiError extends Error {
  readonly code: ErrorCode
  readonly status: number
  readonly details: unknown

  constructor(code: ErrorCode, message: string, status: number, details?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
    this.details = details
  }
}

/** A 2xx response that failed the shared schema — client/server version mismatch (04 §14). */
export class ContractError extends Error {
  readonly route: string
  readonly issues: z.core.$ZodIssue[]

  constructor(route: string, error: z.ZodError) {
    super(`Response for '${route}' failed the shared contract: ${error.message}`)
    this.name = 'ContractError'
    this.route = route
    this.issues = error.issues
  }
}

export interface CallOptions<N extends ApiRouteName> {
  body?: BodyInput<N>
  query?: Record<string, string | number | undefined>
  signal?: AbortSignal
}

/**
 * Decode a non-2xx response through the one §7 error envelope and throw `ApiError`.
 * Shared by `apiCall` and every raw-fetch path (e.g. the PNG upload) so the decode
 * never forks. Falls back to a generic `internal` ApiError for non-envelope bodies.
 */
export async function throwApiError(response: Response, routeName: string): Promise<never> {
  const fallback = new ApiError(
    'internal',
    `HTTP ${response.status} on ${routeName}`,
    response.status,
  )
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw fallback
  }
  const envelope = ApiErrorBody.safeParse(payload)
  if (envelope.success) {
    const { code, message, details } = envelope.data.error
    throw new ApiError(code, message, response.status, details)
  }
  throw fallback
}

export async function apiCall<N extends ApiRouteName>(
  name: N,
  params: PathParams<N>,
  options: CallOptions<N> = {},
): Promise<ResOutput<N>> {
  const route: RouteDef = api[name]
  let url = route.path(...params)
  if (options.query) {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(options.query)) {
      if (value !== undefined) search.set(key, String(value))
    }
    const qs = search.toString()
    if (qs) url = `${url}?${qs}`
  }

  const init: RequestInit = { method: route.method, signal: options.signal ?? null }
  if (options.body !== undefined) {
    init.headers = { 'content-type': 'application/json' }
    init.body = JSON.stringify(options.body)
  }

  const response = await fetch(url, init)

  if (!response.ok) await throwApiError(response, name)

  if (!route.res) return undefined as ResOutput<N>

  const json: unknown = await response.json()
  const parsed = route.res.safeParse(json)
  if (!parsed.success) throw new ContractError(name, parsed.error)
  return parsed.data as ResOutput<N>
}
