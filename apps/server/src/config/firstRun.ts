import path from 'node:path'
import { ensureDir, readIfExists, writeFileAtomic } from '../storage/lib/fsx.js'

/**
 * First-run bootstrap (docs/03-api.md §9.4): when no config file exists, write the
 * commented JSONC template (all models null) and create the data directory. The server
 * starts anyway — zero endpoints configured means agents are unavailable, not the app.
 * Idempotent: an existing config file is never touched; ensureDir is mkdir -p.
 */

/** The commented first-run template. Must parse against AppConfig — a named regression test. */
export const CONFIG_TEMPLATE = `// Cowrite configuration — JSONC (comments and trailing commas are fine).
// Precedence, lowest to highest: schema defaults → this file → environment variables → CLI flags.
// The settings screen edits this file for you; hand-edits apply after "Reload from disk"
// (POST /api/config/reload) or a restart. See docs/03-api.md §9.
{
  "schemaVersion": 1,

  "server": {
    // Loopback only by default. Cowrite has no authentication — if you bind 0.0.0.0
    // (e.g. Docker sets COWRITE_HOST), anyone who can reach the port can edit your works.
    "host": "127.0.0.1",
    "port": 2697, // C-O-W-R on a phone keypad
    "openBrowser": true,
    // Extra Host header names to accept (reverse proxies, tailnet names).
    "allowedHosts": [],
  },

  "storage": {
    // "~" is expanded at load on every platform.
    "dataDir": "~/.cowrite/data",
  },

  // Model endpoints are OpenAI-compatible ("baseUrl" ends in /v1). null = unconfigured:
  // the app still runs, and the web UI shows the setup screen until "high" is configured.
  // "apiKey" may be a literal key, "" for keyless local servers, or "\${env:MY_VAR}".
  "models": {
    "high": null,
    // "high": {
    //   "baseUrl": "https://api.example.com/v1",
    //   "apiKey": "\${env:COWRITE_HIGH_KEY}",
    //   "model": "your-model-name",
    //   "maxOutputTokens": 2048,
    //   "temperature": 0.8,
    // },
    "low": null,
  },

  // ComfyUI for illustrations (optional). null = disabled.
  // "comfyui": {
  //   "baseUrl": "http://127.0.0.1:8188",
  //   // Workflow JSON files live in <configDir>/workflows by default:
  //   // "workflows": { "default": { "file": "default.json", "label": "Default" } },
  // },
  "comfyui": null,

  // Per-task-kind lane overrides, e.g. { "continue": "high", "enrich-section": "low" }.
  "routing": {},

  // Context-budget overrides (docs/06 knobs) — sparse; set only what you want to change.
  // The override chain: these app-level values < per-work "contextOverrides" in work.json.
  "budgets": {},

  // Agent-harness timeouts/retries (docs/05 §6.4) — sparse overrides.
  "harness": {},

  "retention": {
    // Prune finished run logs after N months; null = keep forever.
    "pruneRunsAfterMonths": null,
  },
}
`

export interface FirstRunOptions {
  configPath: string
  /** Effective (tilde-expanded) storage.dataDir to create. */
  dataDir: string
}

export interface FirstRunResult {
  wroteTemplate: boolean
}

export async function ensureFirstRun(opts: FirstRunOptions): Promise<FirstRunResult> {
  await ensureDir(path.dirname(opts.configPath))
  await ensureDir(opts.dataDir)
  const existing = await readIfExists(opts.configPath)
  if (existing !== null) return { wroteTemplate: false }
  await writeFileAtomic(opts.configPath, CONFIG_TEMPLATE)
  return { wroteTemplate: true }
}
