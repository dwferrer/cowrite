import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AppConfig } from '@cowrite/shared'
import { type ParseError, parse as parseJsonc } from 'jsonc-parser'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CONFIG_TEMPLATE, ensureFirstRun } from './firstRun.js'
import { loadConfig } from './load.js'

let dir: string

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cowrite-firstrun-'))
})

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true })
})

describe('the first-run template', () => {
  // The named Zod-4 regression (docs/03 §12, docs/09 §4): the template AND the empty
  // object must both parse against AppConfig.
  it('parses as JSONC and validates against AppConfig', () => {
    const errors: ParseError[] = []
    const value: unknown = parseJsonc(CONFIG_TEMPLATE, errors, { allowTrailingComma: true })
    expect(errors).toEqual([])
    const parsed = AppConfig.parse(value)
    expect(parsed.models.high).toBeNull()
    expect(parsed.models.low).toBeNull()
    expect(parsed.comfyui).toBeNull()
  })

  it('the empty object parses too, and matches the template defaults', () => {
    const errors: ParseError[] = []
    const templateValue: unknown = parseJsonc(CONFIG_TEMPLATE, errors, { allowTrailingComma: true })
    expect(AppConfig.parse(templateValue)).toEqual(AppConfig.parse({}))
  })
})

describe('ensureFirstRun', () => {
  it('writes the template and creates dataDir when nothing exists', async () => {
    const configPath = path.join(dir, '.cowrite', 'config.jsonc')
    const dataDir = path.join(dir, '.cowrite', 'data')
    const result = await ensureFirstRun({ configPath, dataDir })
    expect(result.wroteTemplate).toBe(true)
    expect(await fsp.readFile(configPath, 'utf8')).toBe(CONFIG_TEMPLATE)
    expect((await fsp.stat(dataDir)).isDirectory()).toBe(true)
  })

  it('is idempotent — an existing config file is never touched', async () => {
    const configPath = path.join(dir, 'config.jsonc')
    const dataDir = path.join(dir, 'data')
    await fsp.writeFile(configPath, '{ "server": { "port": 4009 } }', 'utf8')
    const result = await ensureFirstRun({ configPath, dataDir })
    expect(result.wroteTemplate).toBe(false)
    expect(await fsp.readFile(configPath, 'utf8')).toBe('{ "server": { "port": 4009 } }')
    expect((await fsp.stat(dataDir)).isDirectory()).toBe(true)
  })

  it('the written template loads cleanly through loadConfig', async () => {
    const configPath = path.join(dir, 'config.jsonc')
    await ensureFirstRun({ configPath, dataDir: path.join(dir, 'data') })
    const result = await loadConfig({ env: { COWRITE_CONFIG: configPath }, homedir: dir })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.firstRun).toBe(false)
    expect(result.config.server.port).toBe(2697)
  })
})
