import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ApiErrorBody, api, ErrorCode, HealthRes, type RouteDef } from './api.js'
import { PreviewRequest, PreviewResponse } from './context.js'
import { Task, TaskEstimate, TaskSpec } from './tasks.js'

const entries = Object.entries(api) as [string, RouteDef][]

describe('ErrorCode (09 §shared: closed enum, spellings locked)', () => {
  it('is exactly the 03 §7 taxonomy', () => {
    expect(ErrorCode.options).toEqual([
      'validation',
      'forbidden_host',
      'not_found',
      'conflict',
      'busy',
      'readonly',
      'payload_too_large',
      'config_missing',
      'auth',
      'endpoint_unreachable',
      'rate_limited',
      'timeout',
      'output_invalid',
      'pipeline',
      'crash',
      'spend_stop',
      'not_implemented',
      'internal',
    ])
    expect(ErrorCode.safeParse('not-found').success).toBe(false)
  })
})

describe('ApiErrorBody', () => {
  it('parses the envelope with and without details', () => {
    expect(
      ApiErrorBody.parse({
        error: { code: 'conflict', message: 'stale baseRev', details: { currentRev: 4 } },
      }).error.code,
    ).toBe('conflict')
    expect(ApiErrorBody.parse({ error: { code: 'internal', message: 'boom' } })).toBeTruthy()
  })

  it('rejects a bare-string error and an off-taxonomy code', () => {
    expect(ApiErrorBody.safeParse({ error: 'boom' }).success).toBe(false)
    expect(ApiErrorBody.safeParse({ error: { code: 'oops', message: 'x' } }).success).toBe(false)
  })
})

describe('HealthRes', () => {
  it('is the 03 §3.12 readiness shape', () => {
    const parsed = HealthRes.parse({ ok: true, version: '0.0.1', uptime: 12.5 })
    expect(parsed.ok).toBe(true)
    expect(HealthRes.safeParse({ ok: false, version: '0.0.1', uptime: 1 }).success).toBe(false)
    expect(HealthRes.safeParse({ status: 'ok', app: 'cowrite', version: '0.0.1' }).success).toBe(
      false,
    )
  })
})

describe('api route registry (03 §6.2)', () => {
  it('every entry has a method and a path builder rooted at /api', () => {
    for (const [name, route] of entries) {
      expect(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], name).toContain(route.method)
      const args = Array.from({ length: route.path.length }, (_, i) => `id${i}`)
      const built = route.path(...args)
      expect(built.startsWith('/api'), `${name}: ${built}`).toBe(true)
      // every provided id must appear in the built path — no silently dropped params
      for (const arg of args) expect(built, name).toContain(arg)
    }
  })

  it('204 routes carry no response schema; JSON routes carry Zod schemas', () => {
    for (const [name, route] of entries) {
      if (route.status === 204) {
        expect(route.res, name).toBeUndefined()
      }
      if (route.res !== undefined) {
        expect(route.res, name).toBeInstanceOf(z.ZodType)
      }
      if (route.body !== undefined) {
        expect(route.body, name).toBeInstanceOf(z.ZodType)
        expect(['POST', 'PUT', 'PATCH'], name).toContain(route.method)
      }
    }
  })

  it('builds work-scoped paths with bare ULID segments', () => {
    expect(api.patchSnippet.path('w1', 's2')).toBe('/api/works/w1/snippets/s2')
    expect(api.undoConsolidation.path('w1', 'tok')).toBe('/api/works/w1/consolidations/tok/undo')
    expect(api.events.path('w1')).toBe('/api/works/w1/events')
    expect(api.health.path()).toBe('/api/health')
  })

  it('task/context entries bind the real shared schemas by identity (03 §3.7, §3.11)', () => {
    expect(api.createTask.body).toBe(TaskSpec)
    expect(api.createTask.res).toBe(Task)
    expect(api.createTask.status).toBe(202)
    expect(api.getTask.res).toBe(Task)
    expect(api.cancelTask.res).toBe(Task) // idempotent cancel echoes the Task envelope
    expect(api.cancelTask.status).toBe(202)
    expect(api.consolidateNow.res).toBe(Task)
    expect(api.estimateTask.body).toBe(TaskSpec)
    expect(api.estimateTask.res).toBe(TaskEstimate)
    expect(api.previewContext.body).toBe(PreviewRequest)
    expect(api.previewContext.res).toBe(PreviewResponse)
  })

  it('proposal routes: apply returns the committed artifact envelope; discard is 204', () => {
    expect(api.applyProposal.method).toBe('POST')
    expect(api.applyProposal.path('w1', 't2')).toBe('/api/works/w1/tasks/t2/proposal/apply')
    expect(api.discardProposal.path('w1', 't2')).toBe('/api/works/w1/tasks/t2/proposal/discard')
    expect(api.discardProposal.status).toBe(204)
    expect((api.discardProposal as RouteDef).res).toBeUndefined()
  })

  it('marks the non-JSON surfaces: PNG bytes and the SSE stream', () => {
    expect(api.getSectionIllustration.raw).toBe('image/png')
    expect(api.uploadWorldImage.raw).toBe('image/png')
    expect(api.events.raw).toBe('text/event-stream')
  })

  it('registers the Stage 2 surface plus the stubbed Stage 3/4 routes', () => {
    const names = Object.keys(api)
    for (const required of [
      'listWorks',
      'createWork',
      'getWork',
      'patchWork',
      'deleteWork',
      'listSections',
      'getSectionContent',
      'patchSectionContent',
      'getSectionSummaries',
      'putSectionSummaries',
      'listSnippets',
      'createSnippet',
      'patchSnippet',
      'deleteSnippet',
      'listSnippetRevisions',
      'restoreSnippet',
      'setEditing',
      'listWorldEntries',
      'getWorldEntry',
      'createWorldEntry',
      'patchWorldEntry',
      'deleteWorldEntry',
      'getSituation',
      'putSituation',
      'createTask',
      'listTasks',
      'getTask',
      'cancelTask',
      'applyProposal',
      'discardProposal',
      'consolidateNow',
      'undoConsolidation',
      'getRun',
      'listRuns',
      'health',
      'getConfig',
      'putConfig',
      'testConfig',
      'reloadConfig',
      'events',
    ]) {
      expect(names, required).toContain(required)
    }
  })
})
