import fsp from 'node:fs/promises'
import { Hash, IsoTime, OrderKey, Ulid } from '@cowrite/shared'
import { z } from 'zod'
import { StorageError } from './errors.js'
import { ensureDir, readIfExists, writeFileAtomic } from './lib/fsx.js'
import { cowriteDir, journalPath } from './lib/paths.js'

/**
 * The multi-file-operation journal `.cowrite/pending-ops.json` (spec 02 §9.2): a single
 * pending op, present only while a consolidation is in flight ('planned') or inside its
 * undo grace window ('applied'). Absent when idle. The journal is what makes the one
 * multi-file operation (consolidation, §6.4) a two-phase, idempotent, crash-replayable
 * apply; every replay step is keyed by `opId`.
 */

/** One consumed snippet as captured at plan time (§6.4 step 1). */
export const PlannedSnippet = z.object({
  snippetId: Ulid,
  /** Frontier file name at plan time — the staging move and undo restore both use it. */
  fileName: z.string().min(1),
  orderKey: OrderKey,
  /** Plan-time content hash; apply re-reads and folds in newer text regardless (§6.4). */
  planContentHash: Hash,
})
export type PlannedSnippet = z.infer<typeof PlannedSnippet>

/** One section the op creates, with the snippets that collapse into it, in order. */
export const PlannedSection = z.object({
  sectionId: Ulid,
  /** Directory name under sections/ (root-level; M1 splits are single-level, 02 §13). */
  dirName: z.string().min(1),
  kind: z.string().min(1),
  title: z.string().nullable(),
  orderKey: OrderKey,
  snippets: z.array(PlannedSnippet).min(1),
})
export type PlannedSection = z.infer<typeof PlannedSection>

export const PendingOp = z.object({
  schemaVersion: z.literal(1),
  type: z.literal('consolidation'),
  opId: Ulid,
  /** §6.4 phases: 'planned' → roll forward at recovery; 'applied' → resume grace. */
  phase: z.enum(['planned', 'applied']),
  boundaryRunId: Ulid.nullable(),
  createdAt: IsoTime,
  /** Undo-grace deadline; set when the phase flips to 'applied', null before. */
  expiresAt: IsoTime.nullable(),
  sections: z.array(PlannedSection).min(1),
})
export type PendingOp = z.infer<typeof PendingOp>

/**
 * Read and validate the pending-ops journal; null when absent (the idle state, §5.2).
 * A present-but-unparsable journal is real corruption and throws — replaying garbage
 * could move user files to the wrong place, which is strictly worse than failing the
 * open loudly (deleting `.cowrite/` remains the documented repair, §5.2).
 */
export async function readPendingOp(workDirPath: string): Promise<PendingOp | null> {
  const raw = await readIfExists(journalPath(workDirPath))
  if (raw === null) return null
  try {
    return PendingOp.parse(JSON.parse(raw))
  } catch (err) {
    throw new StorageError(
      `unreadable consolidation journal at ${journalPath(workDirPath)}: ${String(err)}`,
      'invalid',
      { kind: 'work' },
    )
  }
}

/** Validate and atomically replace the journal (§9.1 single-file write). */
export async function writePendingOp(workDirPath: string, op: PendingOp): Promise<void> {
  const valid = PendingOp.parse(op)
  await ensureDir(cowriteDir(workDirPath))
  await writeFileAtomic(journalPath(workDirPath), `${JSON.stringify(valid, null, 2)}\n`)
}

/** Delete the journal — the op is finished (grace expired, purged, or undone). */
export async function clearPendingOp(workDirPath: string): Promise<void> {
  await fsp.rm(journalPath(workDirPath), { force: true })
}
