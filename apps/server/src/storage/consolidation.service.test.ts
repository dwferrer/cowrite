import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  ConsolidatedSnippet,
  type ConsolidationSettings,
  SectionMeta,
  type WorkSettings,
} from '@cowrite/shared'
import { ulid } from 'ulid'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { frontierSnapshot, settingsWith } from '../harness/stage4Fixtures.js'
import { applyPlannedOp, planConsolidation } from './consolidation.js'
import type { StorageChange } from './events.js'
import { buildFixtureWork, FIX, SNIP1_FILE, SNIP2_FILE } from './index/fixture.js'
import { readPendingOp, writePendingOp } from './journal.js'
import { xxh64OfString } from './lib/hash.js'
import { journalPath, undoDir } from './lib/paths.js'
import { createStorage, type StorageService, type WorkHandle } from './service.js'
import { listSnippetFiles } from './snippetStore.js'

/**
 * Service-level integration of the consolidation engine (spec 02 §6, §9.2): trigger +
 * guards through `maybeConsolidate`, deferral back-off with the log-only notice,
 * golden apply of the fixture frontier (section dir + history.jsonl contents), the
 * byte-identical undo round trip, the scene-break heuristic path, grace expiry, close
 * purge, and journal recovery through the real openWork lifecycle.
 */

const SLUG = 'salt-and-signal'

/** Typed alias over the kit's `settingsWith` for this suite's partial blocks. */
const settings = (consolidation: Partial<ConsolidationSettings>): WorkSettings =>
  settingsWith(consolidation)

async function freshWork(prefix: string): Promise<{ dataDir: string; storage: StorageService }> {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix))
  await buildFixtureWork(path.join(dataDir, 'works'))
  return { dataDir, storage: createStorage(dataDir) }
}

const fileExists = async (p: string): Promise<boolean> =>
  fsp.stat(p).then(
    () => true,
    () => false,
  )

describe('trigger evaluation, guards, and deferral back-off (§6.2, §6.3)', () => {
  let dataDir: string
  let storage: StorageService
  let handle: WorkHandle
  const notices: string[] = []

  beforeAll(async () => {
    ;({ dataDir, storage } = await freshWork('cowrite-consol-eval-'))
    handle = await storage.openWork(SLUG, { onNotice: (m) => notices.push(m) })
  })

  afterAll(async () => {
    await handle.close().catch(() => {})
    await fsp.rm(dataDir, { recursive: true, force: true })
  })

  it('is idle below the thresholds, and with force but no eligible prefix', async () => {
    // 3 snippets ≪ 18/9000 defaults ⇒ below thresholds
    await expect(handle.maybeConsolidate({ taskTargetIds: [] })).resolves.toEqual({
      status: 'idle',
    })
    // force skips the gate, but the default 6-snippet active window still swallows all 3
    await expect(handle.maybeConsolidate({ taskTargetIds: [], force: true })).resolves.toEqual({
      status: 'idle',
    })
  })

  it('returns needs-boundaries with the eligible prefix once over thresholds', async () => {
    await handle.updateWork({
      settings: settings({
        activeWindowSnippets: 1,
        activeWindowWords: 1,
        maxFrontierSnippets: 2,
      }),
    })
    await expect(handle.maybeConsolidate({ taskTargetIds: [] })).resolves.toEqual({
      status: 'needs-boundaries',
      eligibleSnippetIds: [FIX.snip1, FIX.snip2],
    })
  })

  it('honors the editor-open and task-target guards (§6.2)', async () => {
    handle.setEditingSnippet(FIX.snip1)
    await expect(handle.maybeConsolidate({ taskTargetIds: [] })).resolves.toEqual({
      status: 'idle', // prefix truncated at index 0
    })
    handle.setEditingSnippet(null)

    await expect(handle.maybeConsolidate({ taskTargetIds: [FIX.snip2] })).resolves.toEqual({
      status: 'needs-boundaries',
      eligibleSnippetIds: [FIX.snip1], // truncated at the task target
    })
  })

  it('defers on out-of-prefix boundaries, grows the back-off, and notices after 3', async () => {
    // a syntactically valid boundary pointing at a snippet that is not in the prefix
    await expect(
      handle.applyBoundaries(
        { boundaries: [{ afterSnippetId: ulid(), kind: 'chapter', title: 'Nope' }] },
        { boundaryRunId: null },
      ),
    ).resolves.toEqual({ ok: false, deferred: true, droppedBoundaries: 1 })

    // thresholds are now ×1.5 in memory: ceil(2×1.5)=3, and 3 snippets > 3 is false
    await expect(handle.maybeConsolidate({ taskTargetIds: [] })).resolves.toEqual({
      status: 'idle',
    })

    // a second recorded deferral (the harness's garbage-output path) caps the
    // multiplier at 2×: ceil(2×2)=4, still idle — storage's DeferralBackoff owns the
    // scaling outright (no caller-supplied thresholdScale exists any more)
    expect(notices).toHaveLength(0)
    handle.noteBoundaryDeferral('boundary agent returned garbage')
    await expect(handle.maybeConsolidate({ taskTargetIds: [] })).resolves.toEqual({
      status: 'idle',
    })
    expect(notices).toHaveLength(0)
    handle.noteBoundaryDeferral('boundary agent returned garbage')
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('consider splitting manually')
  })

  it('resets the back-off on a successful consolidation (§6.3)', async () => {
    const res = await handle.applyBoundaries(
      { boundaries: [{ afterSnippetId: FIX.snip1, kind: 'bogus-kind', title: 'Reset' }] },
      { boundaryRunId: FIX.run1 },
    )
    expect(res.ok).toBe(true)

    // a kind outside the level scheme fell back to the deepest level (chapter)
    const rows = handle.listSections()
    expect(rows.find((r) => r.title === 'Reset')?.kind).toBe('chapter')

    // frontier is now 2 snippets; with maxFrontierSnippets=1 the gate only trips at
    // multiplier 1 (ceil(1×2)=2 would read idle) — proving the reset happened
    await handle.updateWork({
      settings: settings({
        activeWindowSnippets: 1,
        activeWindowWords: 1,
        maxFrontierSnippets: 1,
      }),
    })
    await expect(handle.maybeConsolidate({ taskTargetIds: [] })).resolves.toEqual({
      status: 'needs-boundaries',
      eligibleSnippetIds: [FIX.snip2],
    })
  })
})

describe('the threshold gate answers from the index (§7.2)', () => {
  // Efficiency regression: the debounced evaluation fires on every quiet frontier, and
  // an under-threshold pass used to read every snippet file just to count words. The
  // gate must answer from index rows alone — zero frontier file I/O below thresholds.
  it('an under-threshold evaluation performs zero snippet file reads', async () => {
    const { dataDir, storage } = await freshWork('cowrite-consol-gate-')
    const handle = await storage.openWork(SLUG)
    try {
      const readFile = vi.spyOn(fsp, 'readFile')
      const readdir = vi.spyOn(fsp, 'readdir')
      try {
        // 3 snippets ≪ the 18/9000 defaults ⇒ idle, decided purely off index rows
        await expect(handle.maybeConsolidate({ taskTargetIds: [] })).resolves.toEqual({
          status: 'idle',
        })
        const frontierTouches = [...readFile.mock.calls, ...readdir.mock.calls]
          .map((call) => String(call[0]).replaceAll('\\', '/'))
          .filter((p) => p.includes('frontier/'))
        expect(frontierTouches).toEqual([])
      } finally {
        readFile.mockRestore()
        readdir.mockRestore()
      }
      // sanity: force still walks the files (the gate, not the walk, is index-answered)
      await expect(handle.maybeConsolidate({ taskTargetIds: [], force: true })).resolves.toEqual({
        status: 'idle', // default 6-snippet active window swallows all 3
      })
    } finally {
      await handle.close().catch(() => {})
      await fsp.rm(dataDir, { recursive: true, force: true })
    }
  })
})

describe('golden apply + byte-identical undo round trip (§6.4, §12)', () => {
  let dataDir: string
  let storage: StorageService
  let handle: WorkHandle
  let workDir: string
  const events: StorageChange[] = []
  let before: Map<string, string>
  let opId = ''
  let sectionId = ''
  let sectionDirAbs = ''

  beforeAll(async () => {
    ;({ dataDir, storage } = await freshWork('cowrite-consol-golden-'))
    workDir = path.join(dataDir, 'works', SLUG)
    handle = await storage.openWork(SLUG)
    handle.onChange((e) => events.push(e))
    await handle.updateWork({
      settings: settings({ activeWindowSnippets: 1, activeWindowWords: 1 }),
    })
    before = await frontierSnapshot(workDir)
  })

  afterAll(async () => {
    await handle.close().catch(() => {})
    await fsp.rm(dataDir, { recursive: true, force: true })
  })

  it('applies a validated boundary: section dir, content.md, history.jsonl, events', async () => {
    const res = await handle.applyBoundaries(
      { boundaries: [{ afterSnippetId: FIX.snip2, kind: 'chapter', title: 'The Harbormaster' }] },
      { boundaryRunId: FIX.run2 },
    )
    if (!res.ok) throw new Error('expected ok apply')
    opId = res.opId
    expect(res.sectionIds).toHaveLength(1)
    sectionId = res.sectionIds[0] ?? ''
    expect(Date.parse(res.undoDeadline)).toBeGreaterThan(Date.now())

    // --- the created section dir (golden §5.2 shape) --------------------------
    const dirs = (await fsp.readdir(path.join(workDir, 'sections'))).sort()
    const newDir = dirs.find((d) => d.startsWith('030-'))
    expect(newDir).toMatch(/^030-the-harbormaster\.[0-9a-hjkmnp-tv-z]{6}$/)
    sectionDirAbs = path.join(workDir, 'sections', newDir ?? '')

    // content.md: final texts in frontier order, blank-line joined (§6.4)
    const content = await fsp.readFile(path.join(sectionDirAbs, 'content.md'), 'utf8')
    expect(content).toBe(
      'Mara pressed her palm against the storm glass and felt it hum beneath her skin.\n\n' +
        'The tide gnawed the pilings.\n',
    )

    // section.json: frozen leaf, illustration slot written null (Stage 5 fills it)
    const meta = SectionMeta.parse(
      JSON.parse(await fsp.readFile(path.join(sectionDirAbs, 'section.json'), 'utf8')),
    )
    expect(meta.id).toBe(sectionId)
    expect(meta.kind).toBe('chapter')
    expect(meta.title).toBe('The Harbormaster')
    expect(meta.titleSource).toBe('agent')
    expect(meta.frozenAt).not.toBeNull()
    expect(meta.contentHash).toBe(await xxh64OfString(content))
    expect(meta.enrichments).toEqual({ shortSummary: null, longSummary: null, illustration: null })

    // history.jsonl: one ConsolidatedSnippet per consumed snippet, full provenance
    const lines = (await fsp.readFile(path.join(sectionDirAbs, 'history.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((l) => ConsolidatedSnippet.parse(JSON.parse(l)))
    expect(lines).toEqual([
      {
        type: 'consolidated',
        snippetId: FIX.snip1,
        orderKey: 'a0',
        authorship: 'mixed',
        originRunId: FIX.run1,
        finalRev: 3,
        finalText:
          'Mara pressed her palm against the storm glass and felt it hum beneath her skin.\n',
        revisionRunIds: [FIX.run1], // the one agent run that ever touched it
        consolidatedAt: expect.any(String),
        boundaryRunId: FIX.run2,
      },
      {
        type: 'consolidated',
        snippetId: FIX.snip2,
        orderKey: 'a1',
        authorship: 'user',
        originRunId: null,
        finalRev: 1,
        finalText: 'The tide gnawed the pilings.\n',
        revisionRunIds: [],
        consolidatedAt: expect.any(String),
        boundaryRunId: FIX.run2,
      },
    ])

    // consumed files moved to staging — the tree asserts one truth per byte (§6.4)
    expect(await fileExists(path.join(workDir, 'frontier', 'snippets', SNIP1_FILE))).toBe(false)
    expect(await fileExists(path.join(workDir, 'frontier', 'snippets', SNIP2_FILE))).toBe(false)
    const staged = await fsp.readdir(path.join(undoDir(workDir, opId), 'snippets'))
    expect(staged.sort()).toEqual([SNIP1_FILE, SNIP2_FILE].sort())
    expect(handle.listSnippets().map((s) => s.id)).toEqual([FIX.snip3])

    // index: the new section row rides the same operation
    const row = handle.listSections().find((r) => r.id === sectionId)
    expect(row).toMatchObject({
      kind: 'chapter',
      title: 'The Harbormaster',
      frozenAt: meta.frozenAt,
      contentHash: meta.contentHash,
      parentId: null,
    })
    expect(row && row.orderKey > 'a1').toBe(true)

    // events: the §11 storage changes for the canonical rows
    expect(events.some((e) => e.type === 'sections.restructured')).toBe(true)
    const applied = events.find((e) => e.type === 'consolidation.applied')
    expect(applied).toEqual({
      type: 'consolidation.applied',
      opId,
      sectionIds: [sectionId],
      undoToken: opId,
      undoDeadline: res.undoDeadline,
    })

    await expect(handle.pendingConsolidation()).resolves.toEqual({
      opId,
      sectionIds: [sectionId],
      undoDeadline: res.undoDeadline,
    })
  })

  it('reproduces the post-apply state from a full index rebuild (§7.3, §12)', async () => {
    const sectionsBefore = handle.listSections()
    const snippetsBefore = handle.listSnippets()
    await handle.rebuildIndex()
    expect(handle.listSections()).toEqual(sectionsBefore)
    expect(handle.listSnippets()).toEqual(snippetsBefore)
  })

  it('undoes within the grace window: byte-identical frontier, sections removed', async () => {
    await handle.undoConsolidation(opId)

    expect(await frontierSnapshot(workDir)).toEqual(before)
    expect(await fileExists(sectionDirAbs)).toBe(false)
    expect(await fileExists(undoDir(workDir, opId))).toBe(false)
    expect(await readPendingOp(workDir)).toBeNull()

    expect(handle.listSnippets().map((s) => s.id)).toEqual([FIX.snip1, FIX.snip2, FIX.snip3])
    expect(handle.listSections().map((r) => r.id)).toEqual([FIX.sec1, FIX.sec2])
    await expect(handle.pendingConsolidation()).resolves.toBeNull()

    const undone = events.find((e) => e.type === 'consolidation.undone')
    expect(undone).toEqual({ type: 'consolidation.undone', opId, sectionIds: [sectionId] })

    // the token is spent: a second undo is the §3.8 conflict
    await expect(handle.undoConsolidation(opId)).rejects.toMatchObject({ code: 'conflict' })

    // and the rebuilt index still matches the live one after the round trip
    const sectionsBefore = handle.listSections()
    const snippetsBefore = handle.listSnippets()
    await handle.rebuildIndex()
    expect(handle.listSections()).toEqual(sectionsBefore)
    expect(handle.listSnippets()).toEqual(snippetsBefore)
  })
})

describe('scene-break heuristic path (§6.3 rule 1)', () => {
  let dataDir: string
  let storage: StorageService
  let handle: WorkHandle

  beforeAll(async () => {
    ;({ dataDir, storage } = await freshWork('cowrite-consol-break-'))
    handle = await storage.openWork(SLUG)
    await handle.updateWork({
      settings: settings({
        activeWindowSnippets: 1,
        activeWindowWords: 1,
        maxFrontierSnippets: 1,
      }),
    })
  })

  afterAll(async () => {
    await handle.close().catch(() => {})
    await fsp.rm(dataDir, { recursive: true, force: true })
  })

  it('applies immediately on an explicit marker: untitled section, null boundaryRunId', async () => {
    // the user typed a scene break at the end of the first snippet
    const revised = await handle.reviseSnippet(
      FIX.snip1,
      'Mara pressed her palm against the storm glass.\n\n***\n',
      { author: 'user', baseRev: 3 },
    )
    expect(revised.ok).toBe(true)

    const res = await handle.maybeConsolidate({ taskTargetIds: [] })
    if (res.status !== 'applied') throw new Error(`expected applied, got ${res.status}`)
    expect(res.sectionIds).toHaveLength(1)

    const row = handle.listSections().find((r) => r.id === res.sectionIds[0])
    expect(row?.title).toBeNull() // heuristic splits start untitled — enrichment names them
    expect(row?.kind).toBe('chapter')

    const workDir = path.join(dataDir, 'works', SLUG)
    const dirAbs = path.join(workDir, 'sections', row?.dirPath.split('/')[1] ?? '')
    const content = await fsp.readFile(path.join(dirAbs, 'content.md'), 'utf8')
    expect(content).toBe('Mara pressed her palm against the storm glass.\n\n***\n') // marker verbatim

    const history = (await fsp.readFile(path.join(dirAbs, 'history.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((l) => ConsolidatedSnippet.parse(JSON.parse(l)))
    expect(history).toHaveLength(1)
    expect(history[0]?.boundaryRunId).toBeNull() // pure-heuristic break (§10.5)
    expect(history[0]?.finalRev).toBe(4)

    expect(handle.listSnippets().map((s) => s.id)).toEqual([FIX.snip2, FIX.snip3])
  })
})

describe('marker-only snippet glue (§6.3 rule 1)', () => {
  // BUG regression: a '***'-only snippet used to emit boundaries on BOTH sides,
  // minting a junk section whose whole content was the marker (and a junk enrich
  // task for it). Marker-only snippets attach to the preceding section instead.
  it("a '***'-only snippet joins the preceding section's tail — no junk section", async () => {
    const { dataDir, storage } = await freshWork('cowrite-consol-markeronly-')
    const handle = await storage.openWork(SLUG)
    try {
      await handle.updateWork({
        settings: settings({
          activeWindowSnippets: 1,
          activeWindowWords: 1,
          maxFrontierSnippets: 1,
        }),
      })
      const revised = await handle.reviseSnippet(FIX.snip2, '***\n', { author: 'user', baseRev: 1 })
      expect(revised.ok).toBe(true)

      const res = await handle.maybeConsolidate({ taskTargetIds: [] })
      if (res.status !== 'applied') throw new Error(`expected applied, got ${res.status}`)
      // ONE section — never a marker-only junk section alongside it
      expect(res.sectionIds).toHaveLength(1)

      const workDir = path.join(dataDir, 'works', SLUG)
      const row = handle.listSections().find((r) => r.id === res.sectionIds[0])
      const dirAbs = path.join(workDir, 'sections', row?.dirPath.split('/')[1] ?? '')
      const content = await fsp.readFile(path.join(dirAbs, 'content.md'), 'utf8')
      // the marker is preserved verbatim at the preceding section's content tail
      expect(content).toBe(
        'Mara pressed her palm against the storm glass and felt it hum beneath her skin.\n\n***\n',
      )
      expect(handle.listSnippets().map((s) => s.id)).toEqual([FIX.snip3])
      expect(handle.listSections()).toHaveLength(3) // 2 fixture sections + the new one
    } finally {
      await handle.close().catch(() => {})
      await fsp.rm(dataDir, { recursive: true, force: true })
    }
  })
})

describe('a planned journal from a crashed apply is rolled forward, never purged (§9.2)', () => {
  /** Simulate a live-process crash mid-apply AFTER the handle is open: plan + kill
   *  inside the move loop, leaving a 'planned' journal, a fully created section, and
   *  the consumed snippet still present in frontier/. */
  async function crashPlannedApply(
    workDir: string,
    title: string,
    killPoint: string,
  ): Promise<{ opId: string }> {
    const files = await listSnippetFiles(workDir)
    const op = await planConsolidation(
      workDir,
      files.slice(0, 1),
      [{ afterSnippetId: FIX.snip1, kind: 'chapter', title }],
      { boundaryRunId: null },
    )
    await writePendingOp(workDir, op)
    await expect(
      applyPlannedOp(workDir, op, 300_000, {
        kill: (p) => {
          if (p === killPoint) throw new Error(`crash:${killPoint}`)
        },
      }),
    ).rejects.toThrow(`crash:${killPoint}`)
    expect((await readPendingOp(workDir))?.phase).toBe('planned')
    return { opId: op.opId }
  }

  it('the next apply rolls it forward first — frontier prose never consolidates twice', async () => {
    const { dataDir, storage } = await freshWork('cowrite-consol-planned-')
    const workDir = path.join(dataDir, 'works', SLUG)
    const handle = await storage.openWork(SLUG)
    const events: StorageChange[] = []
    handle.onChange((e) => events.push(e))
    try {
      await handle.updateWork({
        settings: settings({ activeWindowSnippets: 1, activeWindowWords: 1 }),
      })
      // crash BEFORE the move: the section is complete but snip1 still sits in frontier/
      const crashed = await crashPlannedApply(workDir, 'Crashed', `move-snippet:${FIX.snip1}`)

      const res = await handle.applyBoundaries(
        { boundaries: [{ afterSnippetId: FIX.snip2, kind: 'chapter', title: 'Fresh' }] },
        { boundaryRunId: null },
      )
      if (!res.ok) throw new Error('expected ok apply')

      // the crashed op was rolled FORWARD then finalized — never purged as garbage
      expect(events.some((e) => e.type === 'consolidation.finalized' && e.opId === crashed.opId)) //
        .toBe(true)

      // snip1's prose lives in EXACTLY one section (the rolled-forward one); the new
      // apply did not re-consume it out of frontier/
      const snip1Text =
        'Mara pressed her palm against the storm glass and felt it hum beneath her skin.'
      const sections = handle.listSections()
      let containing = 0
      for (const row of sections) {
        if (row.contentHash === null) continue
        const { text } = await handle.getSectionContent(row.id)
        if (text.includes(snip1Text)) containing++
      }
      expect(containing).toBe(1)
      expect(sections.map((r) => r.title)).toContain('Crashed')
      expect(sections.map((r) => r.title)).toContain('Fresh')
      // staged originals of the crashed op are finalized away; frontier holds snip3 only
      expect(handle.listSnippets().map((s) => s.id)).toEqual([FIX.snip3])
      // the NEW op owns the grace window
      const pending = await handle.pendingConsolidation()
      expect(pending?.opId).toBe(res.opId)

      // and a full rebuild reproduces the same tree (replay converged, §7.3/§12)
      const sectionsBefore = handle.listSections()
      const snippetsBefore = handle.listSnippets()
      await handle.rebuildIndex()
      expect(handle.listSections()).toEqual(sectionsBefore)
      expect(handle.listSnippets()).toEqual(snippetsBefore)
    } finally {
      await handle.close().catch(() => {})
      await fsp.rm(dataDir, { recursive: true, force: true })
    }
  })

  it('close PRESERVES a planned journal and its staged files for the next open (§9.4)', async () => {
    const { dataDir, storage } = await freshWork('cowrite-consol-plannedclose-')
    const workDir = path.join(dataDir, 'works', SLUG)
    let handle = await storage.openWork(SLUG)
    try {
      // crash AFTER the snippet move: snip1 already staged under .cowrite/undo/<op>/
      const crashed = await crashPlannedApply(workDir, 'Kept Planned', `move-revlog:${FIX.snip1}`)
      await handle.close()

      // the journal survives the close at phase 'planned', staged originals intact —
      // purging here would delete the only undo copies and corrupt the §9.2 replay
      expect((await readPendingOp(workDir))?.phase).toBe('planned')
      expect(await fileExists(path.join(undoDir(workDir, crashed.opId), 'snippets', SNIP1_FILE))) //
        .toBe(true)

      // the next open rolls it forward and resumes a grace window
      handle = await storage.openWork(SLUG)
      expect(handle.listSections().map((r) => r.title)).toContain('Kept Planned')
      expect(handle.listSnippets().map((s) => s.id)).toEqual([FIX.snip2, FIX.snip3])
      expect((await handle.pendingConsolidation())?.opId).toBe(crashed.opId)
    } finally {
      await handle.close().catch(() => {})
      await fsp.rm(dataDir, { recursive: true, force: true })
    }
  })
})

describe('consolidation.finalized on every purge path (§6.4)', () => {
  it('grace expiry purges AND emits consolidation.finalized', async () => {
    const { dataDir, storage } = await freshWork('cowrite-consol-fin-expiry-')
    const handle = await storage.openWork(SLUG)
    const events: StorageChange[] = []
    handle.onChange((e) => events.push(e))
    try {
      await handle.updateWork({
        settings: settings({ activeWindowSnippets: 1, activeWindowWords: 1, undoGraceMs: 40 }),
      })
      const res = await handle.applyBoundaries(
        { boundaries: [{ afterSnippetId: FIX.snip1, kind: 'chapter', title: 'Expiring' }] },
        { boundaryRunId: null },
      )
      if (!res.ok) throw new Error('expected ok apply')
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(events.some((e) => e.type === 'consolidation.finalized' && e.opId === res.opId)).toBe(
        true,
      )
    } finally {
      await handle.close().catch(() => {})
      await fsp.rm(dataDir, { recursive: true, force: true })
    }
  })

  it('a new apply early-finalizes the previous op and emits consolidation.finalized', async () => {
    const { dataDir, storage } = await freshWork('cowrite-consol-fin-super-')
    const handle = await storage.openWork(SLUG)
    const events: StorageChange[] = []
    handle.onChange((e) => events.push(e))
    try {
      await handle.updateWork({
        settings: settings({ activeWindowSnippets: 1, activeWindowWords: 1 }),
      })
      const first = await handle.applyBoundaries(
        { boundaries: [{ afterSnippetId: FIX.snip1, kind: 'chapter', title: 'First' }] },
        { boundaryRunId: null },
      )
      if (!first.ok) throw new Error('expected ok first apply')
      const second = await handle.applyBoundaries(
        { boundaries: [{ afterSnippetId: FIX.snip2, kind: 'chapter', title: 'Second' }] },
        { boundaryRunId: null },
      )
      if (!second.ok) throw new Error('expected ok second apply')

      // the superseded op finalized (its toast dismisses client-side), the new one pends
      expect(
        events.some((e) => e.type === 'consolidation.finalized' && e.opId === first.opId),
      ).toBe(true)
      await expect(handle.undoConsolidation(first.opId)).rejects.toMatchObject({
        code: 'conflict',
      })
      expect((await handle.pendingConsolidation())?.opId).toBe(second.opId)
    } finally {
      await handle.close().catch(() => {})
      await fsp.rm(dataDir, { recursive: true, force: true })
    }
  })
})

describe('grace window: expiry, close purge, and §9.2 recovery through openWork', () => {
  it('purges staging and journal when the grace timer expires', async () => {
    const { dataDir, storage } = await freshWork('cowrite-consol-grace-')
    const workDir = path.join(dataDir, 'works', SLUG)
    const handle = await storage.openWork(SLUG)
    try {
      await handle.updateWork({
        settings: settings({ activeWindowSnippets: 1, activeWindowWords: 1, undoGraceMs: 40 }),
      })
      const res = await handle.applyBoundaries(
        { boundaries: [{ afterSnippetId: FIX.snip1, kind: 'chapter', title: 'Brief' }] },
        { boundaryRunId: null },
      )
      if (!res.ok) throw new Error('expected ok apply')

      // wait out the grace window
      await new Promise((resolve) => setTimeout(resolve, 400))
      await expect(handle.pendingConsolidation()).resolves.toBeNull()
      expect(await fileExists(journalPath(workDir))).toBe(false)
      expect(await fileExists(undoDir(workDir, res.opId))).toBe(false)
      // the consolidation itself is final
      expect(handle.listSections()).toHaveLength(3)
      await expect(handle.undoConsolidation(res.opId)).rejects.toMatchObject({ code: 'conflict' })
    } finally {
      await handle.close().catch(() => {})
      await fsp.rm(dataDir, { recursive: true, force: true })
    }
  })

  it('purges the grace window at close — it does not survive a close (§9.4)', async () => {
    const { dataDir, storage } = await freshWork('cowrite-consol-close-')
    const workDir = path.join(dataDir, 'works', SLUG)
    let handle = await storage.openWork(SLUG)
    try {
      await handle.updateWork({
        settings: settings({ activeWindowSnippets: 1, activeWindowWords: 1 }),
      })
      const res = await handle.applyBoundaries(
        { boundaries: [{ afterSnippetId: FIX.snip1, kind: 'chapter', title: 'Kept' }] },
        { boundaryRunId: null },
      )
      if (!res.ok) throw new Error('expected ok apply')
      await handle.close()

      expect(await fileExists(journalPath(workDir))).toBe(false)
      // the APPLIED op's staging is purged (only a 'planned' journal survives a close)
      expect(await fileExists(undoDir(workDir, res.opId))).toBe(false)

      handle = await storage.openWork(SLUG)
      expect(handle.listSections()).toHaveLength(3) // the freeze is final
      await expect(handle.pendingConsolidation()).resolves.toBeNull()
    } finally {
      await handle.close().catch(() => {})
      await fsp.rm(dataDir, { recursive: true, force: true })
    }
  })

  it('rolls a planned journal forward at open and arms a fresh grace window', async () => {
    const { dataDir, storage } = await freshWork('cowrite-consol-replay-')
    const workDir = path.join(dataDir, 'works', SLUG)
    // Crash simulation: a planned journal exists but the apply never ran.
    const files = await listSnippetFiles(workDir)
    const op = await planConsolidation(
      workDir,
      files,
      [{ afterSnippetId: FIX.snip1, kind: 'chapter', title: 'Recovered' }],
      { boundaryRunId: null },
    )
    await writePendingOp(workDir, op)

    const handle = await storage.openWork(SLUG)
    try {
      // rolled forward: section exists, snippet consumed, index reflects it
      expect(handle.listSections().map((r) => r.title)).toContain('Recovered')
      expect(handle.listSnippets().map((s) => s.id)).toEqual([FIX.snip2, FIX.snip3])
      const pending = await handle.pendingConsolidation()
      expect(pending?.opId).toBe(op.opId)

      // …and the recovered op is still undoable inside its (fresh) grace window
      await handle.undoConsolidation(op.opId)
      expect(handle.listSnippets().map((s) => s.id)).toEqual([FIX.snip1, FIX.snip2, FIX.snip3])
      expect(handle.listSections().map((r) => r.id)).toEqual([FIX.sec1, FIX.sec2])
    } finally {
      await handle.close().catch(() => {})
      await fsp.rm(dataDir, { recursive: true, force: true })
    }
  })

  it('purges an applied journal whose grace deadline passed while the server was down', async () => {
    const { dataDir, storage } = await freshWork('cowrite-consol-expired-')
    const workDir = path.join(dataDir, 'works', SLUG)
    const files = await listSnippetFiles(workDir)
    const op = await planConsolidation(
      workDir,
      files,
      [{ afterSnippetId: FIX.snip1, kind: 'chapter', title: 'Expired' }],
      { boundaryRunId: null },
    )
    await writePendingOp(workDir, op)
    await applyPlannedOp(workDir, op, -60_000) // deadline already in the past

    const handle = await storage.openWork(SLUG)
    try {
      await expect(handle.pendingConsolidation()).resolves.toBeNull()
      expect(await fileExists(journalPath(workDir))).toBe(false)
      expect(await fileExists(undoDir(workDir, op.opId))).toBe(false)
      expect(handle.listSections().map((r) => r.title)).toContain('Expired')
      expect(handle.listSnippets().map((s) => s.id)).toEqual([FIX.snip2, FIX.snip3])
    } finally {
      await handle.close().catch(() => {})
      await fsp.rm(dataDir, { recursive: true, force: true })
    }
  })
})
