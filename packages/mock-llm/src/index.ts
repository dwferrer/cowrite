/**
 * @cowrite/mock-llm — scriptable OpenAI-compatible + ComfyUI mock servers (docs/09 §2).
 *
 * In-process from Vitest: `const llm = await createMockLlm()` / `await createMockComfy()`,
 * script `llm.scenario`, drive the code under test at `llm.url`, then
 * `llm.scenario.assertDrained()` and `await llm.close()`.
 * Cross-process (e2e): spawn `tsx src/standalone.ts` and script via `POST /__mock/scenario`.
 */

export type {
  CapturedPromptRequest,
  ComfyMatch,
  ComfyStep,
  MockComfy,
  MockComfyOptions,
} from './comfy.js'
export { ComfyScenario, createMockComfy } from './comfy.js'
export type { PngOptions } from './png.js'
export { addTextChunk, buildPng, crc32, inflateIdat, PNG_SIGNATURE, readTextChunks } from './png.js'
export type { ScenarioState } from './scenario.js'
export { ScenarioError, ScenarioQueue } from './scenario.js'
export type {
  CapturedChatRequest,
  LlmMatch,
  LlmStep,
  LlmToolCall,
  MockLlm,
  MockLlmOptions,
} from './server.js'
export { createMockLlm, LlmScenario } from './server.js'
