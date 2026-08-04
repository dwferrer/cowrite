import { afterEach, describe, expect, it } from 'vitest'
import type { EngineDeps } from '../engine.js'
import {
  type EngineHarness,
  type FakeData,
  makeEngine,
  paragraphs,
  readersFor,
  sampleWork,
} from './fixtures.js'

/**
 * Snapshot capture efficiency (E1): the contentHash-keyed section-content cache makes a
 * warm re-capture read zero section files, and the REST queries reuse the whole last
 * snapshot until a work change intervenes (via the onWorkChanged channel).
 */

interface Counts {
  listSections: number
  getSectionContent: number
  listSnippets: number
  listEntries: number
  getSituation: number
}

function countingReaders(data: FakeData): {
  counts: Counts
  readers: Pick<EngineDeps, 'manuscript' | 'worldInfo' | 'situation'>
} {
  const base = readersFor(data)
  const counts: Counts = {
    listSections: 0,
    getSectionContent: 0,
    listSnippets: 0,
    listEntries: 0,
    getSituation: 0,
  }
  return {
    counts,
    readers: {
      manuscript: {
        levelScheme: base.manuscript.levelScheme,
        listSections: () => {
          counts.listSections += 1
          return base.manuscript.listSections()
        },
        getSectionContent: (id) => {
          counts.getSectionContent += 1
          return base.manuscript.getSectionContent(id)
        },
        listSnippets: () => {
          counts.listSnippets += 1
          return base.manuscript.listSnippets()
        },
      },
      worldInfo: {
        listEntries: () => {
          counts.listEntries += 1
          return base.worldInfo.listEntries()
        },
      },
      situation: {
        getSituation: () => {
          counts.getSituation += 1
          return base.situation.getSituation()
        },
      },
    },
  }
}

let h: EngineHarness

afterEach(async () => {
  await h?.cleanup()
})

describe('section-content cache (contentHash-keyed)', () => {
  it('a warm beginTask performs ZERO full-manuscript content reads', async () => {
    const data = sampleWork()
    const { counts, readers } = countingReaders(data)
    h = await makeEngine(data, readers)

    const first = await h.engine.beginTask({ kind: 'continue' })
    first.abort()
    expect(counts.getSectionContent).toBe(3) // one cold read per leaf

    const second = await h.engine.beginTask({ kind: 'continue' })
    second.abort()
    expect(counts.getSectionContent).toBe(3) // warm: all served by contentHash
  })

  it('only a changed section re-reads; unchanged leaves stay cached', async () => {
    const data = sampleWork()
    const { counts, readers } = countingReaders(data)
    h = await makeEngine(data, readers)

    ;(await h.engine.beginTask({ kind: 'continue' })).abort()
    expect(counts.getSectionContent).toBe(3)

    const target = data.sections[0]
    if (target === undefined) throw new Error('fixture section missing')
    target.content = paragraphs('rewritten', 5)

    const session = await h.engine.beginTask({ kind: 'continue' })
    expect(counts.getSectionContent).toBe(4) // exactly the one changed leaf
    const prompt = session.assembleInitialPrompt()
    expect(prompt.messages[1]?.content).toContain('rewritten wind') // the fresh prose
    session.abort()
  })
})

describe('whole-snapshot reuse across REST queries (onWorkChanged channel)', () => {
  function makeWithChannel(data: FakeData) {
    const { counts, readers } = countingReaders(data)
    const changeCbs: Array<() => void> = []
    const harness = makeEngine(data, {
      ...readers,
      channels: {
        emitEnrichmentWanted: () => {},
        onEnrichmentCompleted: () => () => {},
        onWorkChanged: (cb) => {
          changeCbs.push(cb)
          return () => {}
        },
      },
    })
    const fireChange = () => {
      for (const cb of changeCbs) cb()
    }
    return { counts, harness, fireChange }
  }

  it('state/candidates/preview reuse the last snapshot until a change intervenes', async () => {
    const data = sampleWork()
    const { counts, harness, fireChange } = makeWithChannel(data)
    h = await harness

    await h.engine.stateRes()
    expect(counts.listSections).toBe(1)
    await h.engine.candidates()
    await h.engine.preview({ taskType: 'continue', selections: [], targets: [] })
    await h.engine.stateRes()
    // every query answered from the one capture: no further list or content reads
    expect(counts.listSections).toBe(1)
    expect(counts.getSectionContent).toBe(3)
    expect(counts.listSnippets).toBe(1)
    expect(counts.listEntries).toBe(1)
    expect(counts.getSituation).toBe(1)

    fireChange()
    await h.engine.candidates()
    expect(counts.listSections).toBe(2) // re-captured after the change signal
    expect(counts.getSectionContent).toBe(3) // …but contents came from the hash cache
  })

  it('a warm beginTask after a REST query does zero manuscript reads of any kind', async () => {
    const data = sampleWork()
    const { counts, harness } = makeWithChannel(data)
    h = await harness

    await h.engine.stateRes() // the capture
    const before = { ...counts }
    const session = await h.engine.beginTask({ kind: 'continue' })
    session.assembleInitialPrompt()
    session.abort()
    expect(counts).toEqual(before) // full reuse — not even a listSections
  })

  it('a work change between tasks re-captures at the next beginTask', async () => {
    const data = sampleWork()
    const { counts, harness, fireChange } = makeWithChannel(data)
    h = await harness
    ;(await h.engine.beginTask({ kind: 'continue' })).abort()
    expect(counts.listSections).toBe(1)

    data.snippets.push({ id: '00000000000000000000000013', orderKey: 'b2', text: 'New words.' })
    fireChange()

    const session = await h.engine.beginTask({ kind: 'continue' })
    expect(counts.listSections).toBe(2)
    expect(session.assembleInitialPrompt().messages[1]?.content).toContain('New words.')
    session.abort()
  })
})
