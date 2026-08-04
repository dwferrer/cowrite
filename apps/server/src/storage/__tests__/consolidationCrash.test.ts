import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  applyPlannedOp,
  applyPlannedOpWithRollback,
  planConsolidation,
  purgeAppliedOp,
  replayPendingOp,
  undoAppliedOp,
} from '../consolidation.js'
import { FIX, SNIP1_FILE, SNIP2_FILE, SNIP3_FILE, snippetFileText } from '../index/fixture.js'
import { type PendingOp, readPendingOp, writePendingOp } from '../journal.js'
import { listSnippetFiles, reviseSnippet } from '../snippetStore.js'

/**
 * Journal crash-recovery property tests (spec 02 §9.2, §12): kill points are injected
 * at EVERY step of the §6.4 apply — including inside the step-3 move loop — and of the
 * undo's reverse replay. After each simulated crash, `replayPendingOp` must converge
 * the work directory to a byte-identical reference state:
 *
 * - any crash during APPLY (journal 'planned') rolls FORWARD to the applied tree;
 * - a crash during UNDO before any section deletion rolls FORWARD to the applied tree
 *   (all content.md present ⇒ the section wins; restored frontier copies re-staged);
 * - a crash during UNDO after deletion begins completes the undo (rolled BACK to the
 *   pre-consolidation tree).
 *
 * Timestamps are injected (`now`) so replayed trees compare byte-for-byte.
 */

const NOW = '2026-07-06T15:00:00Z'
const now = (): string => NOW
const GRACE_MS = 300_000

const S1 = {
  id: FIX.snip1,
  orderKey: 'a0',
  createdAt: '2026-07-06T13:00:00Z',
  updatedAt: '2026-07-06T13:40:00Z',
  authorship: 'mixed' as const,
  originRunId: FIX.run1,
  rev: 3,
}
const S2 = {
  id: FIX.snip2,
  orderKey: 'a1',
  createdAt: '2026-07-06T13:50:00Z',
  updatedAt: '2026-07-06T13:50:00Z',
  authorship: 'user' as const,
  originRunId: null,
  rev: 1,
}
const S3 = {
  id: FIX.snip3,
  orderKey: 'a2',
  createdAt: '2026-07-06T14:02:11Z',
  updatedAt: '2026-07-06T14:02:11Z',
  authorship: 'agent' as const,
  originRunId: FIX.run1,
  rev: 1,
}
const BODY1 = 'Mara pressed her palm against the storm glass.\n'
const BODY2 = 'The tide gnawed the pilings.\n'
const BODY3 = 'Salt wind carried the signal bell.\n'

const revLine = (rev: number, author: 'user' | 'agent', text: string, runId?: string): string =>
  `${JSON.stringify({
    type: 'revision',
    rev,
    ts: '2026-07-06T13:00:00Z',
    author,
    ...(runId === undefined ? {} : { runId }),
    text,
  })}\n`

/** A minimal frontier-only work dir with three snippets and their revision logs. */
async function buildScratch(root: string, name: string): Promise<string> {
  const workDir = path.join(root, name)
  const snippetsDir = path.join(workDir, 'frontier', 'snippets')
  const revisionsDir = path.join(workDir, 'frontier', 'revisions')
  await fsp.mkdir(snippetsDir, { recursive: true })
  await fsp.mkdir(revisionsDir, { recursive: true })
  await fsp.mkdir(path.join(workDir, 'sections'), { recursive: true })
  await fsp.writeFile(path.join(snippetsDir, SNIP1_FILE), snippetFileText(S1, BODY1))
  await fsp.writeFile(path.join(snippetsDir, SNIP2_FILE), snippetFileText(S2, BODY2))
  await fsp.writeFile(path.join(snippetsDir, SNIP3_FILE), snippetFileText(S3, BODY3))
  await fsp.writeFile(
    path.join(revisionsDir, `${FIX.snip1}.jsonl`),
    revLine(1, 'agent', 'draft one', FIX.run1) +
      revLine(2, 'user', 'draft two') +
      revLine(3, 'user', BODY1.trim()),
  )
  await fsp.writeFile(path.join(revisionsDir, `${FIX.snip2}.jsonl`), revLine(1, 'user', BODY2))
  await fsp.writeFile(
    path.join(revisionsDir, `${FIX.snip3}.jsonl`),
    revLine(1, 'agent', BODY3, FIX.run1),
  )
  return workDir
}

/** Every file under `dir` as work-relative path → content (sorted, '/'-separated). */
async function treeSnapshot(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const walk = async (abs: string): Promise<void> => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fsp.readdir(abs, { withFileTypes: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
    }
    for (const entry of entries) {
      const full = path.join(abs, entry.name)
      if (entry.isDirectory()) await walk(full)
      else
        out.set(
          path.relative(dir, full).split(path.sep).join('/'),
          await fsp.readFile(full, 'utf8'),
        )
    }
  }
  await walk(dir)
  return new Map([...out.entries()].sort(([a], [b]) => (a < b ? -1 : 1)))
}

interface Reference {
  /** The op (planned phase) all scenario dirs share — fixed section ids/dirs. */
  op: PendingOp
  preApplyTree: Map<string, string>
  appliedTree: Map<string, string>
  undoneTree: Map<string, string>
  applyKillPoints: string[]
  undoKillPoints: string[]
}

async function buildReference(root: string): Promise<Reference> {
  // Plan once against a pristine scratch dir; the SAME op drives every scenario so
  // minted section ULIDs/dirs match across dirs and trees compare byte-for-byte.
  const planDir = await buildScratch(root, 'plan')
  const files = await listSnippetFiles(planDir)
  const op = await planConsolidation(
    planDir,
    files,
    [
      { afterSnippetId: FIX.snip1, kind: 'chapter', title: 'One' },
      { afterSnippetId: FIX.snip2, kind: 'chapter', title: 'Two' },
    ],
    { boundaryRunId: FIX.run2, now },
  )

  const preApplyTree = await treeSnapshot(planDir)

  // reference APPLY (records every kill point on the way)
  const applyDir = await buildScratch(root, 'ref-apply')
  const applyKillPoints: string[] = []
  await writePendingOp(applyDir, op)
  const applied = await applyPlannedOp(applyDir, op, GRACE_MS, {
    now,
    kill: (p) => {
      applyKillPoints.push(p)
    },
  })
  expect(applied.phase).toBe('applied')
  const appliedTree = await treeSnapshot(applyDir)

  // reference UNDO (from a fresh applied dir, recording undo kill points)
  const undoDir = await buildScratch(root, 'ref-undo')
  await writePendingOp(undoDir, op)
  const undoApplied = await applyPlannedOp(undoDir, op, GRACE_MS, { now })
  const undoKillPoints: string[] = []
  await undoAppliedOp(undoDir, undoApplied, {
    kill: (p) => {
      undoKillPoints.push(p)
    },
  })
  const undoneTree = await treeSnapshot(undoDir)
  // the undo restored the frontier byte-identically (§6.4)
  expect(undoneTree).toEqual(preApplyTree)

  return { op, preApplyTree, appliedTree, undoneTree, applyKillPoints, undoKillPoints }
}

describe('journal crash recovery (§9.2, §12) — kill points at every step', () => {
  it('apply crashes roll forward; undo crashes resolve deterministically', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'cowrite-crash-'))
    try {
      const ref = await buildReference(root)
      expect(ref.applyKillPoints.length).toBeGreaterThan(10)
      expect(ref.undoKillPoints.length).toBeGreaterThan(6)
      // the move loop is covered per snippet and per revision log
      expect(ref.applyKillPoints).toContain(`move-snippet:${FIX.snip1}`)
      expect(ref.applyKillPoints).toContain(`move-revlog:${FIX.snip2}`)

      // ---- crash at EVERY apply step, then replay: byte-identical applied tree ----
      for (const point of ref.applyKillPoints) {
        const dir = await buildScratch(root, `apply-${point.replace(/[^a-z0-9]/gi, '_')}`)
        await writePendingOp(dir, ref.op)
        await expect(
          applyPlannedOp(dir, ref.op, GRACE_MS, {
            now,
            kill: (p) => {
              if (p === point) throw new Error(`kill:${point}`)
            },
          }),
        ).rejects.toThrow(`kill:${point}`)

        const replayed = await replayPendingOp(dir, GRACE_MS, { now })
        expect(replayed?.outcome, point).toBe('rolled-forward')
        expect(await treeSnapshot(dir), point).toEqual(ref.appliedTree)
        expect((await readPendingOp(dir))?.phase, point).toBe('applied')
      }

      // ---- crash at EVERY undo step, then replay ---------------------------------
      // Before the first section dir is deleted, every content.md still exists, so
      // recovery re-stages the restored frontier copies and the op stays APPLIED
      // (§9.2: the section wins). From the first deletion on, recovery completes the
      // undo and the tree returns to the pre-consolidation bytes.
      const firstDeletion = ref.undoKillPoints.indexOf('remove-section:1')
      expect(firstDeletion).toBeGreaterThan(0)
      for (const [i, point] of ref.undoKillPoints.entries()) {
        const dir = await buildScratch(root, `undo-${point.replace(/[^a-z0-9]/gi, '_')}`)
        await writePendingOp(dir, ref.op)
        const applied = await applyPlannedOp(dir, ref.op, GRACE_MS, { now })
        await expect(
          undoAppliedOp(dir, applied, {
            kill: (p) => {
              if (p === point) throw new Error(`kill:${point}`)
            },
          }),
        ).rejects.toThrow(`kill:${point}`)

        const replayed = await replayPendingOp(dir, GRACE_MS, { now })
        if (i < firstDeletion) {
          expect(replayed?.outcome, point).toBe('grace-resumed')
          expect(await treeSnapshot(dir), point).toEqual(ref.appliedTree)
        } else {
          expect(replayed?.outcome, point).toBe('undo-completed')
          expect(await treeSnapshot(dir), point).toEqual(ref.undoneTree)
          expect(await readPendingOp(dir), point).toBeNull()
        }
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  it('purge crashes (and second crashes during the recovery purge) replay to the purged state', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'cowrite-crash-purge-'))
    try {
      // Plan once (shared op) and build the purged reference tree: applied with an
      // ALREADY-EXPIRED deadline, then purged cleanly.
      const planDir = await buildScratch(root, 'plan')
      const files = await listSnippetFiles(planDir)
      const op = await planConsolidation(
        planDir,
        files,
        [{ afterSnippetId: FIX.snip1, kind: 'chapter', title: 'One' }],
        { boundaryRunId: null, now },
      )
      const refDir = await buildScratch(root, 'ref-purged')
      await writePendingOp(refDir, op)
      const refApplied = await applyPlannedOp(refDir, op, -60_000, { now })
      const purgeKillPoints: string[] = []
      await purgeAppliedOp(refDir, refApplied, {
        kill: (p) => {
          purgeKillPoints.push(p)
        },
      })
      const purgedTree = await treeSnapshot(refDir)
      expect(purgeKillPoints).toEqual(['purge-rm-staging', 'purge-clear-journal'])
      expect(await readPendingOp(refDir)).toBeNull()

      for (const point of purgeKillPoints) {
        const dir = await buildScratch(root, `purge-${point.replace(/[^a-z0-9]/gi, '_')}`)
        await writePendingOp(dir, op)
        const applied = await applyPlannedOp(dir, op, -60_000, { now })
        await expect(
          purgeAppliedOp(dir, applied, {
            kill: (p) => {
              if (p === point) throw new Error(`kill:${point}`)
            },
          }),
        ).rejects.toThrow(`kill:${point}`)

        // a SECOND crash at the same point inside the recovery's own purge…
        await expect(
          replayPendingOp(dir, -60_000, {
            now,
            kill: (p) => {
              if (p === point) throw new Error(`kill2:${point}`)
            },
          }),
        ).rejects.toThrow(`kill2:${point}`)

        // …and the next replay still converges to the purged reference bytes
        const replayed = await replayPendingOp(dir, -60_000, { now })
        expect(replayed?.outcome, point).toBe('purged')
        expect(await treeSnapshot(dir), point).toEqual(purgedTree)
        expect(await readPendingOp(dir), point).toBeNull()
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  it('crashes inside the recovery RE-STAGE loop replay to the applied tree (§9.2)', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'cowrite-crash-restage-'))
    try {
      const ref = await buildReference(root)
      const restagePoints = ref.op.sections.flatMap((s) =>
        s.snippets.flatMap((p) => [
          `restage-snippet:${p.snippetId}`,
          `restage-revlog:${p.snippetId}`,
        ]),
      )
      for (const point of restagePoints) {
        const dir = await buildScratch(root, `restage-${point.replace(/[^a-z0-9]/gi, '_')}`)
        await writePendingOp(dir, ref.op)
        const applied = await applyPlannedOp(dir, ref.op, GRACE_MS, { now })
        // Crash the undo at the first deletion point: every restore is done, every
        // content.md still present ⇒ recovery must RE-STAGE the restored copies.
        await expect(
          undoAppliedOp(dir, applied, {
            kill: (p) => {
              if (p === 'remove-section:0') throw new Error('kill:remove-section:0')
            },
          }),
        ).rejects.toThrow('kill:remove-section:0')

        // …and that recovery itself crashes inside the re-stage loop (second crash)
        await expect(
          replayPendingOp(dir, GRACE_MS, {
            now,
            kill: (p) => {
              if (p === point) throw new Error(`kill:${point}`)
            },
          }),
        ).rejects.toThrow(`kill:${point}`)

        // the NEXT replay converges: applied tree, grace resumed
        const replayed = await replayPendingOp(dir, GRACE_MS, { now })
        expect(replayed?.outcome, point).toBe('grace-resumed')
        expect(await treeSnapshot(dir), point).toEqual(ref.appliedTree)
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  it('a thrown LIVE apply rolls back immediately: pre-apply bytes, journal cleared', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'cowrite-crash-rollback-'))
    try {
      const planDir = await buildScratch(root, 'plan')
      const files = await listSnippetFiles(planDir)
      const op = await planConsolidation(
        planDir,
        files,
        [{ afterSnippetId: FIX.snip2, kind: 'chapter', title: 'Rolled Back' }],
        { boundaryRunId: null, now },
      )
      const preApplyTree = await treeSnapshot(planDir)

      const dir = await buildScratch(root, 'rollback')
      await writePendingOp(dir, op)
      await expect(
        applyPlannedOpWithRollback(dir, op, GRACE_MS, {
          now,
          kill: (p) => {
            if (p === `move-revlog:${FIX.snip2}`) throw new Error('kill:mid-move')
          },
        }),
      ).rejects.toThrow('kill:mid-move')

      // the reverse replay ran: byte-identical pre-apply tree, no lingering journal
      expect(await treeSnapshot(dir)).toEqual(preApplyTree)
      expect(await readPendingOp(dir)).toBeNull()
    } finally {
      await fsp.rm(root, { recursive: true, force: true })
    }
  })

  it('folds a mid-flight edit into content.md at apply time (§6.4 step 2)', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'cowrite-foldin-'))
    try {
      const dir = await buildScratch(root, 'work')
      const files = await listSnippetFiles(dir)
      const op = await planConsolidation(
        dir,
        files,
        [{ afterSnippetId: FIX.snip2, kind: 'chapter', title: 'Folded' }],
        { boundaryRunId: null, now },
      )
      await writePendingOp(dir, op)

      // An edit lands between plan and apply (the boundary agent was thinking).
      const edited = 'The tide gnawed the pilings, and the wind rose with it.\n'
      const revised = await reviseSnippet(dir, FIX.snip2, edited, { author: 'user', baseRev: 1 })
      expect(revised.ok).toBe(true)

      const applied = await applyPlannedOp(dir, op, GRACE_MS, { now })
      const section = applied.sections[0]
      if (section === undefined) throw new Error('missing planned section')
      const dirAbs = path.join(dir, 'sections', section.dirName)

      // the NEWER text is what content.md holds (§6.4: never lost)
      const content = await fsp.readFile(path.join(dirAbs, 'content.md'), 'utf8')
      expect(content).toBe(`${BODY1.trim()}\n\n${edited.trim()}\n`)

      // and history.jsonl records the folded-in finalRev/finalText
      const lines = (await fsp.readFile(path.join(dirAbs, 'history.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { snippetId: string; finalRev: number; finalText: string })
      const snip2Line = lines.find((l) => l.snippetId === FIX.snip2)
      expect(snip2Line?.finalRev).toBe(2)
      expect(snip2Line?.finalText).toBe(edited)
    } finally {
      await fsp.rm(root, { recursive: true, force: true })
    }
  })
})
