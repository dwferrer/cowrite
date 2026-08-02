/**
 * Compatibility shim: `buildApp` and its deps live in `http/app.ts` (docs/03-api.md
 * §5.1's layout puts the wiring in `src/http/`); this root module re-exports them so the
 * Stage-1 import path keeps working.
 */
export {
  type BuildAppDeps,
  buildApp,
  type ConfigLike,
  JSON_BODY_LIMIT,
  PNG_BODY_LIMIT,
} from './http/app.js'
