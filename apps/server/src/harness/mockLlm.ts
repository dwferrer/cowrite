import type { AppConfig } from '@cowrite/shared'
import { ModelEndpoint } from '@cowrite/shared'

/**
 * COWRITE_MOCK_LLM=1 / --mock wiring (docs/09-testing.md §2.3): the composition root
 * boots `@cowrite/mock-llm` in-process and points BOTH model lanes at it with the
 * canonical `mock-high` / `mock-low` model names, so e2e and manual dev run modelless
 * and lane routing stays assertable. Config-pointing only — nothing else changes.
 */

export function isMockLlmRequested(env: NodeJS.ProcessEnv, mockFlag: boolean): boolean {
  // Accept the same spellings config/load.ts does — ONE mock-detection semantic.
  return mockFlag || env.COWRITE_MOCK_LLM === '1' || env.COWRITE_MOCK_LLM === 'true'
}

/** Overlay both lanes with mock endpoints rooted at the in-process mock's URL. */
export function withMockModels(config: AppConfig, mockUrl: string): AppConfig {
  const endpoint = (model: string) =>
    ModelEndpoint.parse({ baseUrl: `${mockUrl}/v1`, model, apiKey: '' })
  return {
    ...config,
    models: { high: endpoint('mock-high'), low: endpoint('mock-low') },
  }
}
