import type { ContextSnapshot, TaskSpec } from '@cowrite/shared'

/**
 * The typed seam between the context engine and the prompt renderer
 * (docs/06-context-engine.md §5 hands region CONTENT to 07's renderer; the renderer
 * module lives at apps/server/src/prompt/renderer.ts, backed by the checked-in
 * prompt/templates/*.md set). The engine owns region ordering, region bodies (item
 * markup per 07 §2.2, rendered via prompt/regions.ts — ONE grammar), and token
 * accounting; the renderer owns the system prompt, per-kind `<instructions>` and
 * `<task>` wording, region-tag concatenation, and the refresh-turn cue wording. The
 * templates are the ONE wording source: both composition roots inject the
 * template-backed renderer via `EngineDeps.renderer`.
 */

/** Canonical region-name strings (07 §2.1) in 06 §5.1 stability order. */
export const REGION_ORDER = [
  'instructions',
  'world-info',
  'global-context',
  'voice-anchors',
  'expanded-context',
  'situation',
  'task',
  'local-context',
  'target',
] as const
export type RegionName = (typeof REGION_ORDER)[number]

/**
 * One assembled region: `body` is the region's inner bytes (item tags included, rendered
 * by assemble.ts), `attrs` are attributes on the region tag itself (`<task kind="…">`),
 * `tokens` counts the fully wrapped region including its tag lines.
 */
export interface RegionContent {
  name: RegionName
  attrs?: Record<string, string>
  body: string
  tokens: number
}

/** The `<task>` region as the renderer hands it to assembly: tag attrs + inner body. */
export interface TaskRegionContent {
  attrs: Record<string, string>
  body: string
}

/** What the renderer must provide the engine (a subset of 07's surface). */
export interface PromptRenderer {
  /** The per-work system message (07 §6.1) — identical bytes for every interactive task. */
  systemPrompt(): string
  /** The `<instructions>` region body (07 §6.2–§6.3), byte-stable per (kind, target). */
  instructionsBody(spec: TaskSpec): string
  /** The `<task>` region (07 §6.2–§6.3) — directive wording + user material wrapping. */
  taskRegion(spec: TaskSpec): TaskRegionContent
  /** Wrap ordered regions into the first user message (blank line between regions). */
  composeUserMessage(regions: RegionContent[]): string
  /** The append-only refresh turn (06 §5.3 shape, 07 §6.7 wording). */
  refreshTurn(localContextTail: string): string
}

// ---------------------------------------------------------------------------
// The chat surface the session hands to 05's runner. Kept structurally minimal so the
// harness (built in parallel) can adopt or adapt them; they mirror the OpenAI chat shape.
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
}

/** An OpenAI function-tool definition — identical bytes on every request of a run. */
export interface ToolDef {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

/** One tool invocation from the model, as the harness hands it to `handleToolCall`. */
export interface ToolCall {
  /** Provider call id (echoed back in the tool message); optional for tests/CLI. */
  id?: string
  name: string
  /** Parsed JSON arguments (the harness parses the provider's argument string). */
  args: unknown
  /**
   * 0-based planning-round index, when the harness tracks it (05 §4.2 drives one round
   * per assistant turn). The engine caps rounds only when this is provided; the tool-call
   * cap applies regardless.
   */
  round?: number
}

/** The engine's answer: rendered result text plus the runner-facing signals (06 §6). */
export interface ToolResult {
  name: string
  /** Human label for `task.tool` events ("opened Chapter 7 — full, 1,043 tok"). */
  label: string
  /** Rendered result bytes (item grammar + budget status line), capped per 06 §6. */
  output: string
  /** Planning must end: the model called finish_planning. */
  finishedPlanning: boolean
  /** Planning must end: an engine-owned cap tripped (06 §6 — same path as finish). */
  planningCapReached: boolean
}

export interface AssembledPrompt {
  messages: ChatMessage[]
  tools: ToolDef[]
  snapshot: ContextSnapshot
}
