import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { RunEvent, RunEventInput } from '@cowrite/shared'
import { ulid } from 'ulid'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runsDir } from './lib/paths.js'
import { finalizeCrashedRuns, RunNotFoundError, readRun, recordRun } from './runStore.js'

let workDir: string

beforeEach(async () => {
  workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cowrite-run-'))
})

afterEach(async () => {
  await fsp.rm(workDir, { recursive: true, force: true })
})

const STARTED_AT = '2026-07-06T14:01:58Z'

function metaEvent(runId: string): RunEventInput {
  return {
    type: 'meta',
    runId,
    kind: 'continue',
    lane: 'high',
    model: 'glm-5',
    spec: { kind: 'continue' },
    params: { maxTokens: 2048 },
    contextSnapshot: null,
    startedAt: STARTED_AT,
  }
}

function resultEvent(): RunEventInput {
  return {
    type: 'result',
    status: 'ok',
    usageTotal: { promptTokens: 6412, completionTokens: 388 },
    partialText: null,
    artifacts: [],
    endedAt: '2026-07-06T14:02:11Z',
  }
}

describe('recordRun sink', () => {
  it('writes one validated JSONL line per event into the month shard', async () => {
    const runId = ulid()
    const sink = await recordRun(workDir, runId, STARTED_AT)
    expect(sink.filePath).toBe(path.join(runsDir(workDir), '2026-07', `${runId}.jsonl`))
    await sink.append(metaEvent(runId))
    await sink.append({ type: 'output', text: 'Mara pressed her palm...' })
    await sink.append(resultEvent())

    const raw = await fsp.readFile(sink.filePath, 'utf8')
    expect(raw.split('\n').filter(Boolean)).toHaveLength(3)
    const events = await readRun(workDir, runId)
    expect(events.map((e) => e.type)).toEqual(['meta', 'output', 'result'])
  })

  it('keeps line order for un-awaited appends', async () => {
    const runId = ulid()
    const sink = await recordRun(workDir, runId, STARTED_AT)
    await Promise.all([
      sink.append(metaEvent(runId)),
      sink.append({ type: 'output', text: 'a' }),
      sink.append({ type: 'output', text: 'b' }),
    ])
    const events = await readRun(workDir, runId)
    expect(events.map((e) => (e.type === 'output' ? e.text : e.type))).toEqual(['meta', 'a', 'b'])
  })

  it('becomes write-once after the result event', async () => {
    const sink = await recordRun(workDir, ulid(), STARTED_AT)
    expect(sink.closed).toBe(false)
    await sink.append(resultEvent())
    expect(sink.closed).toBe(true)
    await expect(sink.append({ type: 'output', text: 'late' })).rejects.toThrow(/closed/)
  })

  it('a sink re-opened on a finished run file is born closed (§10.7 write-once)', async () => {
    const runId = ulid()
    const first = await recordRun(workDir, runId, STARTED_AT)
    await first.append(metaEvent(runId))
    await first.append(resultEvent())

    const reopened = await recordRun(workDir, runId, STARTED_AT)
    expect(reopened.closed).toBe(true)
    await expect(reopened.append({ type: 'output', text: 'late' })).rejects.toThrow(/closed/)
    expect(await readRun(workDir, runId)).toHaveLength(2) // nothing was appended
  })

  it('truncates a torn tail at open so the first append starts a fresh line (§9.1)', async () => {
    const runId = ulid()
    const first = await recordRun(workDir, runId, STARTED_AT)
    await first.append(metaEvent(runId))
    await fsp.appendFile(first.filePath, '{"type":"output","text":"torn', 'utf8')

    const reopened = await recordRun(workDir, runId, STARTED_AT)
    expect(reopened.closed).toBe(false)
    await reopened.append({ type: 'output', text: 'fresh line' })
    const raw = await fsp.readFile(reopened.filePath, 'utf8')
    for (const line of raw.split('\n').filter(Boolean)) {
      expect(() => JSON.parse(line)).not.toThrow() // no fused mid-file corruption
    }
    const events = await readRun(workDir, runId)
    expect(events.map((e) => (e.type === 'output' ? e.text : e.type))).toEqual([
      'meta',
      'fresh line',
    ])
  })

  it('rejects events that fail the shared RunEvent schema, writing nothing', async () => {
    const runId = ulid()
    const sink = await recordRun(workDir, runId, STARTED_AT)
    await expect(sink.append({ type: 'bogus' } as unknown as RunEvent)).rejects.toThrow()
    await expect(fsp.stat(sink.filePath)).rejects.toThrow() // no line was written
  })
})

describe('readRun', () => {
  it('scans month shards and tolerates a torn tail', async () => {
    const runId = ulid()
    const sink = await recordRun(workDir, runId, STARTED_AT)
    await sink.append(metaEvent(runId))
    await fsp.appendFile(sink.filePath, '{"type":"output","text":"torn', 'utf8')
    const events = await readRun(workDir, runId)
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('meta')
  })

  it('throws RunNotFoundError for unknown ids', async () => {
    await expect(readRun(workDir, ulid())).rejects.toBeInstanceOf(RunNotFoundError)
  })
})

describe('finalizeCrashedRuns (§10.7)', () => {
  it('appends a synthesized crash result to runs without one', async () => {
    const crashed = ulid()
    const sink = await recordRun(workDir, crashed, STARTED_AT)
    await sink.append(metaEvent(crashed))
    await sink.append({ type: 'output', text: 'Mara pressed ' })
    await sink.append({
      type: 'usage',
      promptTokens: 100,
      completionTokens: 20,
      estimated: false,
      call: 'writing',
    })
    await sink.append({ type: 'output', text: 'her palm' })

    const healthy = ulid()
    const healthySink = await recordRun(workDir, healthy, STARTED_AT)
    await healthySink.append(metaEvent(healthy))
    await healthySink.append(resultEvent())

    const report = await finalizeCrashedRuns(workDir)
    expect(report.finalized.map((f) => f.runId)).toEqual([crashed])
    expect(report.skipped).toEqual([])

    const events = await readRun(workDir, crashed)
    const last = events[events.length - 1]
    if (last?.type !== 'result') throw new Error('expected a result line')
    expect(last.status).toBe('error')
    expect(last.error).toEqual({
      code: 'crash',
      message: expect.stringContaining('without a result'),
    })
    expect(last.usageTotal).toEqual({ promptTokens: 100, estimated: false, completionTokens: 20 })
    expect(last.partialText).toBe('Mara pressed her palm')

    // The healthy run was untouched.
    expect(await readRun(workDir, healthy)).toHaveLength(2)
  })

  it('crash after a mid-stream retry: partialText is the FINAL attempt only (05 §6.5)', async () => {
    // Attempt 1 streamed and was abandoned; attempt 2 streamed, then the process died.
    // Joining both attempts would offer doubled prose — only attempt 2's text counts.
    const crashed = ulid()
    const sink = await recordRun(workDir, crashed, STARTED_AT)
    await sink.append(metaEvent(crashed))
    await sink.append({ type: 'output', text: 'Abandoned first-attempt prose. ', attempt: 1 })
    await sink.append({ type: 'attempt', n: 2, reason: 'endpoint_unreachable' })
    await sink.append({ type: 'output', text: 'Final attempt ', attempt: 2 })
    await sink.append({ type: 'output', text: 'prose only.', attempt: 2 })

    await finalizeCrashedRuns(workDir)
    const events = await readRun(workDir, crashed)
    const last = events[events.length - 1]
    if (last?.type !== 'result') throw new Error('expected a result line')
    expect(last.partialText).toBe('Final attempt prose only.')
    expect(last.partialText).not.toContain('Abandoned')
  })

  it('starts a fresh line under a torn tail', async () => {
    const runId = ulid()
    const sink = await recordRun(workDir, runId, STARTED_AT)
    await sink.append(metaEvent(runId))
    await fsp.appendFile(sink.filePath, '{"type":"output","text":"torn', 'utf8')

    await finalizeCrashedRuns(workDir)
    const events = await readRun(workDir, runId)
    expect(events.map((e) => e.type)).toEqual(['meta', 'result'])
  })

  it('is idempotent', async () => {
    const runId = ulid()
    const sink = await recordRun(workDir, runId, STARTED_AT)
    await sink.append(metaEvent(runId))
    expect((await finalizeCrashedRuns(workDir)).finalized).toHaveLength(1)
    expect((await finalizeCrashedRuns(workDir)).finalized).toHaveLength(0)
  })

  it('finalizes an empty run file (crash right after open)', async () => {
    const runId = ulid()
    const shard = path.join(runsDir(workDir), '2026-07')
    await fsp.mkdir(shard, { recursive: true })
    await fsp.writeFile(path.join(shard, `${runId}.jsonl`), '', 'utf8')
    expect((await finalizeCrashedRuns(workDir)).finalized.map((f) => f.runId)).toEqual([runId])
    const events = await readRun(workDir, runId)
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('result')
  })

  it('ignores foreign files and non-shard directories', async () => {
    const root = runsDir(workDir)
    await fsp.mkdir(path.join(root, '2026-07'), { recursive: true })
    await fsp.mkdir(path.join(root, 'not-a-shard'), { recursive: true })
    await fsp.writeFile(path.join(root, '2026-07', 'notes.txt'), 'x', 'utf8')
    await fsp.writeFile(path.join(root, 'not-a-shard', `${ulid()}.jsonl`), '', 'utf8')
    expect(await finalizeCrashedRuns(workDir)).toEqual({ finalized: [], skipped: [] })
  })

  it('skips a run file with corrupt MIDDLE lines, leaving it byte-identical (never throws)', async () => {
    // Regression: a mangled line in the middle of one old transcript used to make
    // finalizeCrashedRuns — and therefore every future openWork — throw forever.
    const crashedCorrupt = ulid()
    const sink = await recordRun(workDir, crashedCorrupt, STARTED_AT)
    await sink.append(metaEvent(crashedCorrupt))
    await fsp.appendFile(sink.filePath, 'not json at all\n', 'utf8')
    await sink.append({ type: 'output', text: 'after the mangled line' })
    const bytesBefore = await fsp.readFile(sink.filePath)

    const healthy = ulid()
    const healthySink = await recordRun(workDir, healthy, STARTED_AT)
    await healthySink.append(metaEvent(healthy))

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const report = await finalizeCrashedRuns(workDir)
      // the corrupt file is reported and untouched; the healthy crashed run still heals
      expect(report.skipped).toEqual([
        { filePath: sink.filePath, reason: expect.stringContaining('invalid JSONL') },
      ])
      expect(report.finalized.map((f) => f.runId)).toEqual([healthy])
      expect(await fsp.readFile(sink.filePath)).toEqual(bytesBefore)
      const events = await readRun(workDir, healthy)
      expect(events[events.length - 1]?.type).toBe('result')
    } finally {
      warn.mockRestore()
    }
  })

  it('never reads the full contents of finished runs (tail seek only)', async () => {
    for (let i = 0; i < 3; i++) {
      const runId = ulid()
      const sink = await recordRun(workDir, runId, STARTED_AT)
      await sink.append(metaEvent(runId))
      await sink.append({ type: 'output', text: `finished transcript ${i}` })
      await sink.append(resultEvent())
    }
    // readJsonl/truncateTornTail load whole files through fsp.readFile; the finished-run
    // probe must go through the boundary tail seek (fsp.open) instead.
    const readFile = vi.spyOn(fsp, 'readFile')
    try {
      expect((await finalizeCrashedRuns(workDir)).finalized).toEqual([])
      expect(readFile).not.toHaveBeenCalled()
    } finally {
      readFile.mockRestore()
    }
  })
})
