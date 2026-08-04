import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveEffectiveConfig } from './effective.js'

/**
 * ONE mock-mode/config resolution for BOTH composition roots (docs/09 §2.3): the server
 * (src/index.ts) and the dev CLI (cliAgents.ts createCliRuntime) call exactly this
 * function, so the overlay semantic — tolerant load + mock-lane overlay, defaults on an
 * invalid file — can never drift between them. The CLI-root path is exercised end-to-end
 * in cliAgents.test.ts ("mock-mode fallback").
 */

async function tmpConfig(contents: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'cowrite-effective-'))
  const configPath = path.join(dir, 'config.jsonc')
  await writeFile(configPath, contents)
  return configPath
}

describe('resolveEffectiveConfig', () => {
  it('normal mode: a valid file loads; mock is off', async () => {
    const configPath = await tmpConfig('{ "server": { "port": 4123 } }')
    const resolved = await resolveEffectiveConfig({ env: { COWRITE_CONFIG: configPath } })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) throw new Error('unreachable')
    expect(resolved.config.server.port).toBe(4123)
    expect(resolved.mock).toBe(false)
    expect(resolved.fellBack).toBe(false)
    expect(resolved.warnings).toEqual([])
  })

  it('normal mode: an invalid file is a fatal, file-positioned error', async () => {
    const configPath = await tmpConfig('{ "server": { "port": "not-a-number" } }')
    const resolved = await resolveEffectiveConfig({ env: { COWRITE_CONFIG: configPath } })
    expect(resolved.ok).toBe(false)
    if (resolved.ok) throw new Error('unreachable')
    expect(resolved.issues.some((i) => i.path.includes('server.port'))).toBe(true)
  })

  it('mock mode OVERLAYS a valid config: user settings survive, lanes get mocked later', async () => {
    const configPath = await tmpConfig(
      '{ "server": { "port": 4124 }, "harness": { "spendWarnUsd": 2 } }',
    )
    const resolved = await resolveEffectiveConfig({
      env: { COWRITE_CONFIG: configPath, COWRITE_MOCK_LLM: '1' },
    })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) throw new Error('unreachable')
    expect(resolved.mock).toBe(true)
    expect(resolved.fellBack).toBe(false)
    // The user's non-model settings are PRESERVED (overlay, not replacement).
    expect(resolved.config.server.port).toBe(4124)
    expect(resolved.config.harness.spendWarnUsd).toBe(2)
  })

  it('mock mode + INVALID config: defaults with a printed warning, never fatal', async () => {
    const configPath = await tmpConfig('{ "server": { "port": "nope" } }')
    const resolved = await resolveEffectiveConfig({
      env: { COWRITE_CONFIG: configPath, COWRITE_MOCK_LLM: '1' },
    })
    expect(resolved.ok).toBe(true) // dev/e2e must always be reachable under mock mode
    if (!resolved.ok) throw new Error('unreachable')
    expect(resolved.mock).toBe(true)
    expect(resolved.fellBack).toBe(true)
    expect(resolved.config.server.port).toBe(2697) // schema default
    expect(resolved.warnings.join('\n')).toContain('running on defaults under mock mode')
    // The synthesized load result still gives the server root a usable ConfigService seed.
    expect(resolved.loaded.configPath).toBe(configPath)
  })

  it('accepts both COWRITE_MOCK_LLM spellings ("1" and "true")', async () => {
    const configPath = await tmpConfig('{ "server": { "port": "nope" } }')
    for (const spelling of ['1', 'true']) {
      const resolved = await resolveEffectiveConfig({
        env: { COWRITE_CONFIG: configPath, COWRITE_MOCK_LLM: spelling },
      })
      expect(resolved.ok).toBe(true)
    }
  })
})
