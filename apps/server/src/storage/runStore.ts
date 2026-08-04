import fsp from 'node:fs/promises'
import path from 'node:path'
import { RunEvent, type RunEventInput } from '@cowrite/shared'
import {
  appendJsonlLine,
  ensureDir,
  readJsonl,
  readJsonlBoundaryLines,
  truncateTornTail,
} from './lib/fsx.js'
import { runFilePath, runsDir } from './lib/paths.js'

/**
 * Agent-run transcript store (spec 02 §2.7, §10.7): one JSONL file per run at
 * `runs/<YYYY-MM>/<runId>.jsonl`, written through an append sink that becomes
 * write-once after the `result` event. Crash-orphaned runs are finalized at work open.
 */

const RUN_FILE = /^([0-9A-HJKMNP-TV-Z]{26})\.jsonl$/
const MONTH_SHARD = /^\d{4}-\d{2}$/

export class RunNotFoundError extends Error {
  constructor(readonly runId: string) {
    super(`run not found: ${runId}`)
    this.name = 'RunNotFoundError'
  }
}

export interface RunSink {
  readonly filePath: string
  /** true once a `result` event has been appended; further appends reject. */
  readonly closed: boolean
  /** Accepts the writer-side (input) shape; defaults are materialized by validation. */
  append(event: RunEventInput): Promise<void>
}

/**
 * The run file's last complete line as a schema-valid RunEvent, read via a tail seek —
 * never the full transcript. null for a missing/empty file or an unparseable last line.
 */
async function readLastRunEvent(filePath: string): Promise<RunEvent | null> {
  let last: string | null
  try {
    ;({ last } = await readJsonlBoundaryLines(filePath))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  if (last === null) return null
  let json: unknown
  try {
    json = JSON.parse(last)
  } catch {
    return null
  }
  const parsed = RunEvent.safeParse(json)
  return parsed.success ? parsed.data : null
}

/**
 * Open the append sink for a run. Every event is validated against the shared RunEvent
 * schema and becomes exactly one JSONL line; appends are internally serialized so
 * un-awaited callers cannot interleave lines. After a `result` event the sink is
 * write-once: subsequent appends reject (§10.7) — including a sink re-opened on an
 * already-finished run file. The single exception is the `proposal` resolution event,
 * which docs/05 §5.1 defines as appended AFTER the result by proposal apply/discard (the
 * durable idempotence marker). A torn tail left by a crash is physically dropped at open
 * so the first append never fuses with it into mid-file corruption (§9.1).
 */
export async function recordRun(
  workDirPath: string,
  runId: string,
  startedAtIso: string,
): Promise<RunSink> {
  const filePath = runFilePath(runsDir(workDirPath), runId, startedAtIso)
  await ensureDir(path.dirname(filePath))
  await truncateTornTail(filePath)
  // A `proposal` line can only ever follow a result (05 §5.1), so both mean "finished".
  const lastType = (await readLastRunEvent(filePath))?.type
  let closed = lastType === 'result' || lastType === 'proposal'
  let chain: Promise<void> = Promise.resolve()
  return {
    filePath,
    get closed() {
      return closed
    },
    async append(event: RunEventInput): Promise<void> {
      const valid = RunEvent.parse(event)
      // Write-once after the result — except the post-result proposal resolution (05 §5.1).
      if (closed && valid.type !== 'proposal') {
        throw new Error(`run ${runId} is closed (result already recorded)`)
      }
      // Close immediately, before the write flushes, so a racing append after a result
      // rejects even when neither call has been awaited yet.
      if (valid.type === 'result') closed = true
      const write = chain.then(() => appendJsonlLine(filePath, valid))
      chain = write.catch(() => {}) // a failed write must not poison later appends
      return write
    },
  }
}

async function listShardDirs(workDirPath: string): Promise<string[]> {
  const root = runsDir(workDirPath)
  try {
    const entries = await fsp.readdir(root, { withFileTypes: true })
    return entries
      .filter((e) => e.isDirectory() && MONTH_SHARD.test(e.name))
      .map((e) => path.join(root, e.name))
      .sort()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

async function findRunFile(workDirPath: string, runId: string): Promise<string | null> {
  for (const shard of await listShardDirs(workDirPath)) {
    const candidate = path.join(shard, `${runId}.jsonl`)
    try {
      await fsp.stat(candidate)
      return candidate
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }
  return null
}

/**
 * Read a run's events, scanning month shards. Torn-tail tolerant via readJsonl (§9.1);
 * lines that parse as JSON but fail the schema indicate corruption and throw.
 */
export async function readRun(workDirPath: string, runId: string): Promise<RunEvent[]> {
  const filePath = await findRunFile(workDirPath, runId)
  if (filePath === null) throw new RunNotFoundError(runId)
  const { lines } = await readJsonl(filePath)
  return lines.map((line) => RunEvent.parse(line))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export interface FinalizedRun {
  runId: string
  filePath: string
}

export interface SkippedRunFile {
  filePath: string
  reason: string
}

export interface CrashFinalizationReport {
  /** Runs that received a synthesized crash result; callers re-ingest these (§10.7). */
  finalized: FinalizedRun[]
  /** Unreadable/corrupt transcripts, logged and left untouched — never abort the open. */
  skipped: SkippedRunFile[]
}

/**
 * §10.7 crash finalization: for every run file whose last (complete) line is not a
 * `result`, append a synthesized `{type:'result', status:'error', code:'crash'}` line.
 * Usage totals are recovered by summing the file's `usage` events, and any streamed
 * `output` text is preserved as `partialText`. Idempotent — finalized files end in a
 * result and are skipped on the next pass.
 *
 * Finished runs are detected by their LAST line alone (tail seek): historical
 * transcripts are never re-read in full at every open. A file whose lines cannot be
 * read or parsed (mid-file corruption) is reported in `skipped` and left untouched —
 * a mangled old transcript must never make a work unopenable.
 */
export async function finalizeCrashedRuns(workDirPath: string): Promise<CrashFinalizationReport> {
  const finalized: FinalizedRun[] = []
  const skipped: SkippedRunFile[] = []
  for (const shard of await listShardDirs(workDirPath)) {
    for (const name of await fsp.readdir(shard)) {
      const match = RUN_FILE.exec(name)
      if (!match || match[1] === undefined) continue
      const filePath = path.join(shard, name)
      try {
        // Cheap probe: only the last line decides whether the run already finished
        // (a `proposal` resolution is only ever appended after a result — 05 §5.1).
        const lastType = (await readLastRunEvent(filePath))?.type
        if (lastType === 'result' || lastType === 'proposal') continue

        const { lines } = await readJsonl(filePath) // throws on mid-file corruption
        const last = lines[lines.length - 1]
        if (isRecord(last) && (last.type === 'result' || last.type === 'proposal')) continue

        let promptTokens = 0
        let completionTokens = 0
        let estimated = false
        const outputs: Array<{ text: string; attempt: number }> = []
        for (const line of lines) {
          if (!isRecord(line)) continue
          if (line.type === 'usage') {
            if (typeof line.promptTokens === 'number') promptTokens += line.promptTokens
            if (typeof line.completionTokens === 'number') {
              completionTokens += line.completionTokens
            }
            if (line.estimated === true) estimated = true
          } else if (line.type === 'output' && typeof line.text === 'string') {
            outputs.push({
              text: line.text,
              attempt: typeof line.attempt === 'number' ? line.attempt : 1,
            })
          }
        }
        // partialText joins ONLY the final attempt's output events (05 §6.5): a run that
        // died after a mid-stream retry recorded the abandoned attempt's text under an
        // earlier attempt index — fusing attempts would offer doubled prose.
        const finalAttempt = outputs.reduce((max, o) => Math.max(max, o.attempt), 1)
        const partialText = outputs
          .filter((o) => o.attempt === finalAttempt)
          .map((o) => o.text)
          .join('')
        const result = RunEvent.parse({
          type: 'result',
          status: 'error',
          error: { code: 'crash', message: 'run ended without a result; finalized at work open' },
          usageTotal: { promptTokens, completionTokens, estimated },
          partialText: partialText === '' ? null : partialText,
          artifacts: [],
          endedAt: new Date().toISOString(),
        })
        // A torn final line would become MID-file corruption once we append after it
        // (readers only tolerate torn tails, §9.1), so drop it — truncating a torn line
        // is exactly what every reader already does — before appending the result.
        await truncateTornTail(filePath)
        await appendJsonlLine(filePath, result)
        finalized.push({ runId: match[1], filePath })
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        console.warn(`finalizeCrashedRuns: skipping unreadable run file ${filePath}: ${reason}`)
        skipped.push({ filePath, reason })
      }
    }
  }
  return { finalized, skipped }
}
