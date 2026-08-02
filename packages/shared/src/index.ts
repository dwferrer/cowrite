/**
 * Single runtime-validated contract between server and web (docs/02-data-model.md §10, §14;
 * docs/03-api.md §6). Every schema module re-exports here; server and web import from
 * '@cowrite/shared' only.
 */

export type { HealthRes as HealthResponse } from './api.js'
export * from './api.js'
// Legacy alias for the Stage 1 scaffold's health schema — now the 03 §3.12 shape
// `{ok: true, version, uptime}` (identity-equal to the registry's `api.health.res`).
export { HealthRes as healthResponseSchema } from './api.js'
export * from './config.js'
export * from './context.js'
export * from './enrichment.js'
export * from './events.js'
export * from './ids.js'
export * from './illustration.js'
export * from './runs.js'
export * from './section.js'
export * from './situation.js'
export * from './snippet.js'
export * from './tasks.js'
export * from './work.js'
export * from './world.js'
