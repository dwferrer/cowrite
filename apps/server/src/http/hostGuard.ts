import type { FastifyInstance } from 'fastify'
import { AppError } from './errors.js'

/**
 * Host-header allowlist — the DNS-rebinding defense (docs/03-api.md §5.4) and the one
 * security measure this app ships. An `onRequest` hook rejects any request whose `Host`
 * hostname is not allowlisted: `127.0.0.1` / `localhost` / `::1`, plus the configured
 * `server.host` when it is a specific non-loopback address, plus `server.allowedHosts`
 * (for `0.0.0.0` binds behind a known name). Comparison is hostname-only — the port is
 * fixed by the socket. Additionally, non-GET requests carrying an `Origin` header whose
 * hostname is NOT in the same allowlist are rejected (belt for the suspenders; GETs and
 * SSE are unaffected, and the dev-mode `http://localhost:5173` origin passes because its
 * hostname is allowlisted). Rejection is always `403 forbidden_host`.
 */

export interface HostGuardConfig {
  host: string
  allowedHosts: string[]
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])
const WILDCARD_BINDS = new Set(['0.0.0.0', '::'])

/** Hostname (lowercased, brackets stripped) of a Host header value; null when unparsable. */
export function hostnameOfHostHeader(hostHeader: string): string | null {
  try {
    return stripBrackets(new URL(`http://${hostHeader}`).hostname)
  } catch {
    return null
  }
}

/** Hostname of an Origin header value; null when unparsable (including `Origin: null`). */
export function hostnameOfOrigin(origin: string): string | null {
  try {
    return stripBrackets(new URL(origin).hostname)
  } catch {
    return null
  }
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

export function isAllowedHostname(hostname: string, config: HostGuardConfig): boolean {
  if (LOOPBACK.has(hostname)) return true
  const boundHost = config.host.toLowerCase()
  if (hostname === boundHost && !WILDCARD_BINDS.has(boundHost)) return true
  return config.allowedHosts.some((allowed) => allowed.toLowerCase() === hostname)
}

export function registerHostGuard(app: FastifyInstance, getConfig: () => HostGuardConfig): void {
  app.addHook('onRequest', (req, _reply, done) => {
    const config = getConfig()
    const hostHeader = req.headers.host
    const hostname = hostHeader === undefined ? null : hostnameOfHostHeader(hostHeader)
    if (hostname === null || !isAllowedHostname(hostname, config)) {
      done(
        new AppError(
          'forbidden_host',
          `host '${hostHeader ?? ''}' is not allowed; add it to server.allowedHosts if this is your machine's name`,
        ),
      )
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin
      if (typeof origin === 'string') {
        const originHost = hostnameOfOrigin(origin)
        if (originHost === null || !isAllowedHostname(originHost, config)) {
          done(new AppError('forbidden_host', `cross-origin request from '${origin}' rejected`))
          return
        }
      }
    }
    done()
  })
}
