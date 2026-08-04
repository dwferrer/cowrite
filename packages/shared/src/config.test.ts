import { describe, expect, it } from 'vitest'
import {
  AppConfig,
  ConfigTestReq,
  ConfigUpdate,
  ConfigWriteRes,
  HarnessKnobs,
  HarnessKnobsOverrides,
  ModelEndpoint,
  ProbeResult,
  PublicConfig,
} from './config.js'

const highEndpoint = {
  baseUrl: 'http://127.0.0.1:8080/v1',
  apiKey: 'sk-local',
  model: 'llama-3.3-70b',
} as const

/** What firstRun.ts writes once the JSONC comments are stripped (03 §9.4): all models null,
 *  sample workflow entries commented out — i.e. explicit nulls and empty containers. */
const firstRunTemplate = {
  schemaVersion: 1,
  server: { host: '127.0.0.1', port: 2697, openBrowser: true, allowedHosts: [] },
  storage: { dataDir: '~/.cowrite/data' },
  models: { high: null, low: null },
  comfyui: null,
  routing: {},
  budgets: {},
  harness: {},
  retention: { pruneRunsAfterMonths: null },
}

describe('AppConfig — the named regression (03 §12)', () => {
  it('parses the all-defaults empty object', () => {
    const parsed = AppConfig.parse({})
    expect(parsed.schemaVersion).toBe(1)
    expect(parsed.server).toEqual({
      host: '127.0.0.1',
      port: 2697,
      openBrowser: true,
      allowedHosts: [],
    })
    expect(parsed.storage.dataDir).toBe('~/.cowrite/data')
    expect(parsed.models).toEqual({ high: null, low: null })
    expect(parsed.comfyui).toBeNull()
    expect(parsed.routing).toEqual({})
    expect(parsed.budgets).toEqual({})
    expect(parsed.harness).toEqual({})
    expect(parsed.retention.pruneRunsAfterMonths).toBeNull()
  })

  it('parses the first-run template, identical to the all-defaults object', () => {
    expect(AppConfig.parse(firstRunTemplate)).toEqual(AppConfig.parse({}))
  })
})

describe('AppConfig fields', () => {
  it('routing is a sparse per-kind record over kebab-case TaskKind keys', () => {
    const parsed = AppConfig.parse({ routing: { continue: 'high', 'enrich-section': 'low' } })
    expect(parsed.routing).toEqual({ continue: 'high', 'enrich-section': 'low' })
    expect(AppConfig.safeParse({ routing: { quickEdit: 'low' } }).success).toBe(false)
    expect(AppConfig.safeParse({ routing: { continue: 'medium' } }).success).toBe(false)
  })

  it('budgets and harness overrides stay sparse (no re-materialized defaults)', () => {
    const parsed = AppConfig.parse({
      budgets: { softBudget: 16_000 },
      harness: { retry: { maxAttempts: 5 } },
    })
    expect(parsed.budgets).toEqual({ softBudget: 16_000 })
    expect(parsed.harness).toEqual({ retry: { maxAttempts: 5 } })
  })

  it('embeds ComfyConfig: a bare baseUrl block materializes route/loop/timeout defaults', () => {
    const parsed = AppConfig.parse({ comfyui: { baseUrl: 'http://127.0.0.1:8188' } })
    expect(parsed.comfyui?.route).toEqual({ section: 'default', world: 'default' })
    expect(parsed.comfyui?.loop).toEqual({ maxAttempts: 3, acceptScore: 7 })
    expect(parsed.comfyui?.timeouts.execTimeoutMs).toBe(300_000)
    expect(parsed.comfyui?.workflows).toEqual({})
  })

  it('rejects out-of-range ports and a wrong schemaVersion', () => {
    expect(AppConfig.safeParse({ server: { port: 0 } }).success).toBe(false)
    expect(AppConfig.safeParse({ server: { port: 70_000 } }).success).toBe(false)
    expect(AppConfig.safeParse({ schemaVersion: 2 }).success).toBe(false)
  })
})

describe('HarnessKnobs (05 §6.4 — the config.harness fragment)', () => {
  it('materializes every documented default from {}', () => {
    expect(HarnessKnobs.parse({})).toEqual({
      connectTimeoutMs: 15_000,
      firstTokenTimeoutMs: 60_000,
      idleTokenTimeoutMs: 30_000,
      totalTimeoutMs: { high: 300_000, low: 300_000 },
      illustrationBudgetMs: 600_000,
      retry: { maxAttempts: 3, backoffMs: 1_000, backoffMaxMs: 4_000 },
      spendWarnUsd: 5,
      spendStopUsd: null,
    })
  })

  it('carries no planning caps — those are BudgetKnobs fields (06 §8.1), never duplicated', () => {
    expect(Object.keys(HarnessKnobs.shape)).toEqual([
      'connectTimeoutMs',
      'firstTokenTimeoutMs',
      'idleTokenTimeoutMs',
      'totalTimeoutMs',
      'illustrationBudgetMs',
      'retry',
      'spendWarnUsd',
      'spendStopUsd',
    ])
  })

  it('spend-guard knobs: warn defaults on at $5, stop defaults off (null)', () => {
    const knobs = HarnessKnobs.parse({ spendWarnUsd: null, spendStopUsd: 12.5 })
    expect(knobs.spendWarnUsd).toBeNull() // null disables the threshold
    expect(knobs.spendStopUsd).toBe(12.5)
    expect(HarnessKnobs.safeParse({ spendStopUsd: -1 }).success).toBe(false)
  })

  it('overrides stay sparse — no re-materialized defaults (the zod 4 .partial() gotcha)', () => {
    expect(HarnessKnobsOverrides.parse({})).toEqual({})
    expect(HarnessKnobsOverrides.parse({ totalTimeoutMs: { high: 600_000 } })).toEqual({
      totalTimeoutMs: { high: 600_000 },
    })
    expect(HarnessKnobsOverrides.safeParse({ retry: { maxAttempts: 0 } }).success).toBe(false)
  })
})

describe('ModelEndpoint', () => {
  it('defaults apiKey "", 8192 max output tokens, temperature 0.8, null prices', () => {
    const parsed = ModelEndpoint.parse({ baseUrl: highEndpoint.baseUrl, model: 'm' })
    expect(parsed.apiKey).toBe('')
    expect(parsed.maxOutputTokens).toBe(8192)
    expect(parsed.temperature).toBe(0.8)
    expect(parsed.promptCostPerMTok).toBeNull()
    expect(parsed.completionCostPerMTok).toBeNull()
  })

  it('rejects a non-URL baseUrl, empty model, out-of-range temperature', () => {
    expect(ModelEndpoint.safeParse({ baseUrl: 'not a url', model: 'm' }).success).toBe(false)
    expect(ModelEndpoint.safeParse({ baseUrl: highEndpoint.baseUrl, model: '' }).success).toBe(
      false,
    )
    expect(ModelEndpoint.safeParse({ ...highEndpoint, temperature: 2.5 }).success).toBe(false)
  })

  it('stored config rejects apiKey null — that sentinel exists only in the update direction', () => {
    expect(
      AppConfig.safeParse({ models: { high: { ...highEndpoint, apiKey: null }, low: null } })
        .success,
    ).toBe(false)
  })
})

describe('ConfigUpdate (§9.5 sentinels)', () => {
  it('apiKey null = keep the stored key; "" = keyless', () => {
    const keep = ConfigUpdate.parse({
      models: { high: { ...highEndpoint, apiKey: null }, low: null },
    })
    expect(keep.models.high?.apiKey).toBeNull()
    const keyless = ConfigUpdate.parse({
      models: { high: { ...highEndpoint, apiKey: '' }, low: null },
    })
    expect(keyless.models.high?.apiKey).toBe('')
  })

  it('clearing a section is literal null', () => {
    const parsed = ConfigUpdate.parse({ ...firstRunTemplate, comfyui: null })
    expect(parsed.comfyui).toBeNull()
    expect(parsed.models.high).toBeNull()
  })
})

describe('PublicConfig (redaction + provenance)', () => {
  const publicDoc = {
    ...firstRunTemplate,
    models: { high: { ...highEndpoint, apiKey: { set: true } }, low: null },
    setup: { highConfigured: true, lowConfigured: false, comfyConfigured: false },
    overrides: [{ path: 'server.host', by: 'env' }],
  }

  it('carries apiKey as {set: boolean}, never a string', () => {
    const parsed = PublicConfig.parse(publicDoc)
    expect(parsed.models.high?.apiKey).toEqual({ set: true })
    expect(
      PublicConfig.safeParse({
        ...publicDoc,
        models: { high: highEndpoint, low: null },
      }).success,
    ).toBe(false)
  })

  it('requires setup flags and typed override provenance', () => {
    expect(PublicConfig.safeParse({ ...publicDoc, setup: undefined }).success).toBe(false)
    expect(
      PublicConfig.safeParse({
        ...publicDoc,
        overrides: [{ path: 'server.host', by: 'file' }],
      }).success,
    ).toBe(false)
    const res = ConfigWriteRes.parse({
      config: publicDoc,
      restartRequired: ['server.port'],
    })
    expect(res.restartRequired).toEqual(['server.port'])
  })
})

describe('ProbeResult / ConfigTestReq', () => {
  it('parses ok and failure variants', () => {
    expect(ProbeResult.parse({ ok: true, latencyMs: 42 }).ok).toBe(true)
    const failed = ProbeResult.parse({ ok: false, code: 'timeout', message: 'probe timed out' })
    expect(failed.ok).toBe(false)
    expect(ProbeResult.safeParse({ ok: false, code: 'nonsense', message: 'x' }).success).toBe(false)
  })

  it('accepts a candidate document deep-merged over the saved config', () => {
    const req = ConfigTestReq.parse({
      target: 'high',
      candidate: { models: { high: { ...highEndpoint, apiKey: null }, low: null } },
    })
    expect(req.target).toBe('high')
    expect(ConfigTestReq.safeParse({ target: 'medium' }).success).toBe(false)
  })
})
