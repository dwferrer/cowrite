import type { ContextState, ElevatedItem, TaskSpec } from '@cowrite/shared'
import { BudgetKnobs } from '@cowrite/shared'
import { describe, expect, it } from 'vitest'
import { closeTagLine, openTagLine } from '../../prompt/tags.js'
import { selectAnchors } from '../anchors.js'
import { type Assembly, assemble, clampSelection } from '../assemble.js'
import { computeDefaultMap } from '../defaults.js'
import { TokenEstimator } from '../estimate.js'
import { REGION_ORDER, type RegionContent } from '../renderTypes.js'
import type { WorkSnapshot } from '../snapshot.js'
import {
  type FakeData,
  hasher,
  paragraphs,
  renderer,
  sampleWork,
  section,
  snapshotOf,
  tid,
  WORK_ID,
} from './fixtures.js'

/**
 * Assembly and byte-stability (docs/06-context-engine.md §5, §13 golden-prefix tests):
 * stability-ordered regions, append-only <expanded-context>, byte-identical prefixes
 * across elevations / frontier growth / consolidation-shaped events, and the coverage
 * invariant on every assembly. Instructions/task wording comes from the template-backed
 * renderer (prompt/renderer.ts) — the ONE wording source (07 §6).
 */

const est = new TokenEstimator()
const knobs = BudgetKnobs.parse({})

/** One region wrapped the way the renderer's composeUserMessage does (tags.ts grammar). */
function wrapRegion(region: RegionContent): string {
  return `${openTagLine(region.name, Object.entries(region.attrs ?? {}))}\n${region.body}\n${closeTagLine(region.name)}`
}

async function build(
  data: FakeData,
  over: { state?: Partial<ContextState>; spec?: TaskSpec; withAnchors?: boolean } = {},
): Promise<{ assembly: Assembly; snapshot: WorkSnapshot; state: ContextState }> {
  const snapshot = await snapshotOf(data)
  const h = await hasher()
  const r = await renderer()
  const state: ContextState = {
    version: 1,
    taskCounter: 0,
    elevated: [],
    anchors: {
      refreshedAtTask: 0,
      excerpts: over.withAnchors === false ? [] : selectAnchors(snapshot, 4000, est, h),
    },
    ...over.state,
  }
  const map = computeDefaultMap(snapshot, knobs, est)
  const spec = over.spec ?? { kind: 'continue' as const }
  const assembly = assemble({
    snapshot,
    state,
    map,
    knobs,
    spec,
    instructionsBody: r.instructionsBody(spec),
    task: r.taskRegion(spec),
    est,
    workId: WORK_ID,
  })
  return { assembly, snapshot, state }
}

function regionNames(a: Assembly): string[] {
  return a.regions.map((r) => r.name)
}

function regionBody(a: Assembly, name: string): string | undefined {
  return a.regions.find((r) => r.name === name)?.body
}

async function makeElevation(over: Partial<ElevatedItem> = {}): Promise<ElevatedItem> {
  const h = await hasher()
  return {
    kind: 'world',
    id: tid(21),
    fidelity: 'full',
    ttl: 3,
    source: 'tool',
    elevatedAtTask: 1,
    lastCitedTask: 1,
    tokens: 20,
    sourceHash: h.hash('x'),
    ...over,
  }
}

describe('region ordering and contents (§5.1)', () => {
  it('emits regions in decreasing-stability canonical order, omitting empty ones', async () => {
    const { assembly } = await build(sampleWork())
    const names = regionNames(assembly)
    // subsequence of the canonical order
    const canonical = [...REGION_ORDER] as string[]
    expect([...names].sort((a, b) => canonical.indexOf(a) - canonical.indexOf(b))).toEqual(names)
    expect(names).toContain('instructions')
    expect(names).toContain('world-info')
    expect(names).toContain('global-context')
    expect(names).toContain('situation')
    expect(names).toContain('task')
    expect(names).toContain('local-context')
    expect(names).not.toContain('expanded-context') // empty ledger ⇒ omitted
  })

  it('omits <situation> when the pane is empty (no husk regions)', async () => {
    const data = sampleWork()
    data.situation = '   '
    const { assembly } = await build(data)
    expect(regionNames(assembly)).not.toContain('situation')
  })

  it('total coverage: every section id and every snippet text appears in the prompt', async () => {
    const { assembly, snapshot } = await build(sampleWork())
    const global = regionBody(assembly, 'global-context') ?? ''
    for (const s of snapshot.sections) {
      expect(global).toContain(s.id)
    }
    const local = regionBody(assembly, 'local-context') ?? ''
    for (const snippet of snapshot.snippets) {
      expect(local).toContain(snippet.text)
      expect(local).toContain(snippet.id)
    }
  })

  it('un-enriched frozen leaves render their full prose in the skeleton (rule 2)', async () => {
    const { assembly, snapshot } = await build(sampleWork())
    const global = regionBody(assembly, 'global-context') ?? ''
    const bare = snapshot.sectionById.get(tid(3))
    expect(global).toContain(bare?.content ?? 'MISSING')
  })

  it('the ContextSnapshot lists every region with tokens and typed items', async () => {
    const { assembly } = await build(sampleWork())
    const snap = assembly.contextSnapshot
    expect(snap.regions.map((r) => r.name)).toEqual(regionNames(assembly))
    for (const r of snap.regions) expect(r.tokens).toBeGreaterThan(0)
    const kinds = new Set(snap.items.map((i) => i.kind))
    expect(kinds).toContain('section')
    expect(kinds).toContain('world')
    expect(kinds).toContain('snippet')
    expect(kinds).toContain('situation')
    expect(kinds).toContain('anchor')
    const situationItem = snap.items.find((i) => i.kind === 'situation')
    expect(situationItem?.id).toBe(WORK_ID)
    expect(assembly.totalTokens).toBe(assembly.regions.reduce((s, r) => s + r.tokens, 0))
  })
})

describe('golden prefix — the cache contract (§13)', () => {
  it('elevating one item is a pure append: byte-identical prefix through <voice-anchors>', async () => {
    const data = sampleWork()
    const before = await build(data)
    const after = await build(data, {
      state: {
        anchors: before.state.anchors,
        elevated: [await makeElevation()],
      },
    })

    // regions through <voice-anchors> byte-identical
    const stableNames = ['instructions', 'world-info', 'global-context', 'voice-anchors']
    for (const name of stableNames) {
      expect(regionBody(after.assembly, name)).toBe(regionBody(before.assembly, name))
    }
    // the change is the appended <expanded-context> region only
    expect(regionNames(before.assembly)).not.toContain('expanded-context')
    expect(regionNames(after.assembly)).toContain('expanded-context')
    // regions below it unchanged
    for (const name of ['situation', 'task', 'local-context']) {
      expect(regionBody(after.assembly, name)).toBe(regionBody(before.assembly, name))
    }
    // full-message prefix through voice-anchors is byte-identical
    const wrapAll = (a: Assembly, upTo: string): string => {
      const idx = a.regions.findIndex((r) => r.name === upTo)
      return a.regions
        .slice(0, idx + 1)
        .map(wrapRegion)
        .join('\n\n')
    }
    expect(wrapAll(after.assembly, 'voice-anchors')).toBe(wrapAll(before.assembly, 'voice-anchors'))
  })

  it('a second elevation appends after the first inside <expanded-context>', async () => {
    const data = sampleWork()
    const one = await makeElevation()
    const two = await makeElevation({
      kind: 'section',
      id: tid(1),
      fidelity: 'full',
      elevatedAtTask: 2,
    })
    const first = await build(data, { state: { elevated: [one] } })
    const both = await build(data, {
      state: { anchors: first.state.anchors, elevated: [one, two] },
    })
    const firstBody = regionBody(first.assembly, 'expanded-context') ?? ''
    const bothBody = regionBody(both.assembly, 'expanded-context') ?? ''
    expect(bothBody.startsWith(firstBody)).toBe(true) // pure append
  })

  it('frontier growth changes only <local-context> (and its tokens)', async () => {
    const data = sampleWork()
    const before = await build(data)
    data.snippets.push({ id: tid(13), orderKey: 'b2', text: paragraphs('fresh', 1) })
    const after = await build(data, { state: { anchors: before.state.anchors } })
    for (const name of [
      'instructions',
      'world-info',
      'global-context',
      'voice-anchors',
      'situation',
      'task',
    ]) {
      expect(regionBody(after.assembly, name)).toBe(regionBody(before.assembly, name))
    }
    expect(regionBody(after.assembly, 'local-context')).not.toBe(
      regionBody(before.assembly, 'local-context'),
    )
  })

  it('a consolidation-shaped event touches only skeleton + local-context', async () => {
    const data = sampleWork()
    const before = await build(data)
    // snippets consolidate into a new frozen (un-enriched) section
    const consumed = data.snippets.splice(0, 1)[0]
    data.sections.push(
      section({
        id: tid(4),
        orderKey: 'a3',
        title: 'Four',
        content: consumed?.text ?? '',
      }),
    )
    const after = await build(data, { state: { anchors: before.state.anchors } })
    for (const name of ['instructions', 'world-info', 'voice-anchors', 'situation', 'task']) {
      expect(regionBody(after.assembly, name)).toBe(regionBody(before.assembly, name))
    }
    expect(regionBody(after.assembly, 'global-context')).not.toBe(
      regionBody(before.assembly, 'global-context'),
    )
    expect(regionBody(after.assembly, 'local-context')).not.toBe(
      regionBody(before.assembly, 'local-context'),
    )
  })

  it('assembly is byte-deterministic for identical inputs', async () => {
    const data = sampleWork()
    const a = await build(data)
    const b = await build(data, { state: { anchors: a.state.anchors } })
    expect(b.assembly.regions).toEqual(a.assembly.regions)
  })

  it('the plain-continue <task> region is a byte-constant', async () => {
    const a = await build(sampleWork())
    expect(regionBody(a.assembly, 'task')).toBe(
      'Continue the story directly from the end of <local-context>.',
    )
    expect(a.assembly.regions.find((r) => r.name === 'task')?.attrs).toEqual({ kind: 'continue' })
  })
})

describe('task kinds (§9)', () => {
  it('instructed-continue wraps the instruction in <user-instructions>', async () => {
    const { assembly } = await build(sampleWork(), {
      spec: { kind: 'instructed-continue', instruction: 'Bring in the storm.' },
    })
    const task = regionBody(assembly, 'task') ?? ''
    expect(task).toContain('<user-instructions>\nBring in the storm.\n</user-instructions>')
  })

  it('quick-edit marks the target snippet in place with role + selection markers', async () => {
    const data = sampleWork()
    const target = data.snippets[0]
    if (target === undefined) throw new Error('fixture')
    const start = target.text.indexOf('paragraph 1')
    const spec: TaskSpec = {
      kind: 'quick-edit',
      instruction: 'Tighten this.',
      target: { type: 'snippet', snippetId: target.id, baseRev: 1 },
      selection: { text: 'paragraph 1', start, end: start + 'paragraph 1'.length },
    }
    const { assembly } = await build(data, { spec })
    const local = regionBody(assembly, 'local-context') ?? ''
    expect(local).toContain(`<snippet id="${target.id}" role="edit-target">`)
    expect(local).toContain('<selection>paragraph 1</selection>')
    const task = regionBody(assembly, 'task') ?? ''
    expect(task).toContain('<selection-excerpt>\nparagraph 1\n</selection-excerpt>')
    // the target snippet item carries source 'target' in the ContextSnapshot
    const item = assembly.contextSnapshot.items.find((i) => i.id === target.id)
    expect(item?.source).toBe('target')
  })

  it('clampSelection clamps out-of-range offsets instead of throwing (07 §2.4)', () => {
    expect(clampSelection('abc', -5, 99)).toEqual({ start: 0, end: 3 })
    expect(clampSelection('abc', 2, 1)).toEqual({ start: 2, end: 2 })
  })

  it('background kinds are rejected', async () => {
    await expect(
      build(sampleWork(), { spec: { kind: 'enrich-section', sectionId: tid(1) } as TaskSpec }),
    ).rejects.toThrow(/no engine-session instructions|never opens an engine session/)
  })
})
