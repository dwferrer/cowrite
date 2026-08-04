import { ConsolidationSettings, type SnippetMeta } from '@cowrite/shared'
import { ulid } from 'ulid'
import { describe, expect, it } from 'vitest'
import {
  activeWindowSize,
  computeEligiblePrefix,
  DEFERRAL_NOT_BEFORE_CAP_MS,
  DeferralBackoff,
  effectiveThresholds,
  heuristicBoundaryIds,
  isSceneBreakLine,
  joinSnippetTexts,
} from './consolidation.js'
import { wordCount } from './lib/hash.js'
import type { SnippetFile } from './storageTypes.js'

/**
 * Unit tests for the pure consolidation helpers (spec 02 §6.2–§6.3): the active-window
 * keeps-more rule, eligible-prefix guards (task targets, editor-open), the scene-break
 * heuristic, and the capped in-memory deferral back-off.
 */

const T = '2026-07-06T12:00:00Z'

function snippetFile(orderKey: string, text: string): SnippetFile {
  const id = ulid()
  const meta: SnippetMeta = {
    id,
    orderKey,
    createdAt: T,
    updatedAt: T,
    authorship: 'user',
    originRunId: null,
    rev: 1,
  }
  return {
    meta,
    text,
    filePath: `/work/frontier/snippets/010.${id.slice(-6).toLowerCase()}.md`,
    fileName: `010.${id.slice(-6).toLowerCase()}.md`,
    wordCount: wordCount(text),
  }
}

/** n snippets of `wordsEach` words with orderKeys k00, k01, …. */
function frontier(n: number, wordsEach: number): SnippetFile[] {
  const files: SnippetFile[] = []
  for (let i = 0; i < n; i++) {
    const text = `${Array.from({ length: wordsEach }, (_, w) => `w${i}x${w}`).join(' ')}\n`
    files.push(snippetFile(`k${String(i).padStart(2, '0')}`, text))
  }
  return files
}

const settings = (patch: Partial<ConsolidationSettings>): ConsolidationSettings =>
  ConsolidationSettings.parse(patch)

describe('active window & eligible prefix (§6.2)', () => {
  it('keeps the WORD window when it holds more snippets than the count window', () => {
    // 10 snippets × 10 words; word window 50 ⇒ 5 trailing snippets > count window 3
    const files = frontier(10, 10)
    const s = settings({ activeWindowSnippets: 3, activeWindowWords: 50 })
    expect(activeWindowSize(files, s)).toBe(5)
    const prefix = computeEligiblePrefix(files, s, { taskTargetIds: [], editingSnippetId: null })
    expect(prefix.map((f) => f.meta.id)).toEqual(files.slice(0, 5).map((f) => f.meta.id))
  })

  it('keeps the SNIPPET window when it holds more than the word window', () => {
    // word window 20 ⇒ 2 trailing snippets; count window 6 keeps more
    const files = frontier(10, 10)
    const s = settings({ activeWindowSnippets: 6, activeWindowWords: 20 })
    expect(activeWindowSize(files, s)).toBe(6)
    expect(
      computeEligiblePrefix(files, s, { taskTargetIds: [], editingSnippetId: null }),
    ).toHaveLength(4)
  })

  it('never exceeds the frontier itself and empties the prefix on small frontiers', () => {
    const files = frontier(4, 10)
    const s = settings({}) // defaults: 6 snippets / 3000 words
    expect(activeWindowSize(files, s)).toBe(4)
    expect(computeEligiblePrefix(files, s, { taskTargetIds: [], editingSnippetId: null })).toEqual(
      [],
    )
  })

  it('truncates the prefix at the first task-target snippet (§6.2)', () => {
    const files = frontier(10, 10)
    const s = settings({ activeWindowSnippets: 2, activeWindowWords: 1 })
    const target = files[3]?.meta.id ?? ''
    const prefix = computeEligiblePrefix(files, s, {
      taskTargetIds: [target],
      editingSnippetId: null,
    })
    expect(prefix.map((f) => f.meta.id)).toEqual(files.slice(0, 3).map((f) => f.meta.id))
  })

  it('truncates at the editor-open snippet; a guard at index 0 empties the prefix', () => {
    const files = frontier(10, 10)
    const s = settings({ activeWindowSnippets: 2, activeWindowWords: 1 })
    expect(
      computeEligiblePrefix(files, s, {
        taskTargetIds: [],
        editingSnippetId: files[0]?.meta.id ?? '',
      }),
    ).toEqual([])
  })

  it('ignores guards that sit inside the active window anyway', () => {
    const files = frontier(10, 10)
    const s = settings({ activeWindowSnippets: 4, activeWindowWords: 1 })
    const inWindow = files[8]?.meta.id ?? ''
    expect(
      computeEligiblePrefix(files, s, { taskTargetIds: [inWindow], editingSnippetId: null }),
    ).toHaveLength(6)
  })

  it('scales trigger thresholds with ceil(configured × multiplier)', () => {
    const s = settings({ maxFrontierSnippets: 18, maxFrontierWords: 9000 })
    expect(effectiveThresholds(s, 1)).toEqual({ maxFrontierSnippets: 18, maxFrontierWords: 9000 })
    expect(effectiveThresholds(s, 1.5)).toEqual({
      maxFrontierSnippets: 27,
      maxFrontierWords: 13_500,
    })
  })
})

describe('scene-break heuristic (§6.3 rule 1)', () => {
  it('recognizes ***, ---, longer runs, and spaced variants as break lines', () => {
    for (const line of ['***', '---', '****', '-----', '* * *', '  ***  ', '- - -']) {
      expect(isSceneBreakLine(line), line).toBe(true)
    }
    for (const line of ['**', '--', 'chapter', '*-*', '— — —', '']) {
      expect(isSceneBreakLine(line), line).toBe(false)
    }
  })

  it('breaks after a snippet ending in a marker and before one starting with a marker', () => {
    const a = snippetFile('a0', 'Scene one prose.\n\n***\n')
    const b = snippetFile('a1', 'Scene two prose.\n')
    const c = snippetFile('a2', '---\n\nScene three opens here.\n')
    const d = snippetFile('a3', 'Tail prose.\n')
    // a ends with *** ⇒ after a; c starts with --- ⇒ after b
    expect(heuristicBoundaryIds([a, b, c, d])).toEqual([a.meta.id, b.meta.id])
  })

  it('ignores mid-snippet markers and a marker opening the very first snippet', () => {
    const a = snippetFile('a0', '***\n\nOpens with a marker.\n')
    const b = snippetFile('a1', 'Before.\n\n***\n\nAfter — same snippet.\n')
    expect(heuristicBoundaryIds([a, b])).toEqual([])
  })

  it('dedupes: marker at the end of one snippet AND the start of the next is one break', () => {
    const a = snippetFile('a0', 'One.\n\n***\n')
    const b = snippetFile('a1', '***\n\nTwo.\n')
    expect(heuristicBoundaryIds([a, b])).toEqual([a.meta.id])
  })

  // BUG regression: a snippet whose text is ONLY marker line(s) used to emit boundaries
  // on BOTH sides — minting a junk section containing nothing but the marker (and a
  // junk enrich task with it). Marker-only snippets are glue.
  it('a marker-only snippet is glue: one boundary AFTER it, no junk section', () => {
    const a = snippetFile('a0', 'Scene one.\n')
    const b = snippetFile('a1', '***\n')
    const c = snippetFile('a2', 'Scene two.\n')
    expect(heuristicBoundaryIds([a, b, c])).toEqual([b.meta.id])
  })

  it('a marker-ending snippet followed by marker-only glue emits ONE boundary (after the glue)', () => {
    const a = snippetFile('a0', 'Scene one.\n\n***\n')
    const b = snippetFile('a1', '* * *\n')
    const c = snippetFile('a2', 'Scene two.\n')
    expect(heuristicBoundaryIds([a, b, c])).toEqual([b.meta.id])
  })

  it('consecutive marker-only snippets collapse into one boundary after the last', () => {
    const a = snippetFile('a0', 'Scene one.\n')
    const b = snippetFile('a1', '***\n')
    const c = snippetFile('a2', '---\n')
    const d = snippetFile('a3', 'Scene two.\n')
    expect(heuristicBoundaryIds([a, b, c, d])).toEqual([c.meta.id])
  })

  it('a LEADING marker-only snippet attaches to the FOLLOWING section: no boundary', () => {
    const a = snippetFile('a0', '***\n')
    const b = snippetFile('a1', 'Opens the first scene.\n')
    expect(heuristicBoundaryIds([a, b])).toEqual([])
    // …and a marker-opening prose snippet does not re-emit the suppressed boundary
    const c = snippetFile('a1', '---\n\nOpens the first scene.\n')
    expect(heuristicBoundaryIds([a, c])).toEqual([])
  })
})

describe('deferral back-off (§6.3 rule 3)', () => {
  it('grows ×1.5 per deferral, caps at 2×, notices from the 3rd, resets on success', () => {
    const backoff = new DeferralBackoff(() => 0)
    expect(backoff.thresholdMultiplier).toBe(1)

    expect(backoff.recordDeferral()).toEqual({ noticeDue: false })
    expect(backoff.thresholdMultiplier).toBe(1.5)

    expect(backoff.recordDeferral()).toEqual({ noticeDue: false })
    expect(backoff.thresholdMultiplier).toBe(2) // 2.25 capped at 2×

    expect(backoff.recordDeferral()).toEqual({ noticeDue: true })
    expect(backoff.thresholdMultiplier).toBe(2)

    // growth has stopped; the notice stays due
    expect(backoff.recordDeferral()).toEqual({ noticeDue: true })
    expect(backoff.thresholdMultiplier).toBe(2)
    expect(backoff.consecutiveDeferrals).toBe(4)

    backoff.reset()
    expect(backoff.thresholdMultiplier).toBe(1)
    expect(backoff.consecutiveDeferrals).toBe(0)
  })

  // BUG regression: repeated deferrals used to allow an immediate boundary re-run over
  // the identical prefix — a pure model-spend loop. The temporal back-off arms a
  // not-before deadline (2^n × debounceMs, capped) AND requires prefix growth.
  it('blocks boundary re-runs until the not-before deadline AND the prefix grew', () => {
    let t = 0
    const backoff = new DeferralBackoff(() => t)
    backoff.noteEligiblePrefix(4)
    expect(backoff.blocksBoundaryRun(4)).toBe(false) // nothing deferred yet

    backoff.recordDeferral(1_000) // n=1 ⇒ not before t=2 000
    expect(backoff.blocksBoundaryRun(9)).toBe(true) // inside the window, growth irrelevant
    t = 1_999
    expect(backoff.blocksBoundaryRun(9)).toBe(true)
    t = 2_000
    expect(backoff.blocksBoundaryRun(4)).toBe(true) // deadline passed but prefix unchanged
    expect(backoff.blocksBoundaryRun(5)).toBe(false) // grew ⇒ eligible again

    backoff.recordDeferral(1_000) // n=2 ⇒ not before t+4 000
    t = 2_000 + 3_999
    expect(backoff.blocksBoundaryRun(99)).toBe(true)
    t = 2_000 + 4_000
    expect(backoff.blocksBoundaryRun(99)).toBe(false)

    backoff.reset()
    expect(backoff.blocksBoundaryRun(1)).toBe(false)
  })

  it('caps the not-before window at ~30 minutes', () => {
    let t = 0
    const backoff = new DeferralBackoff(() => t)
    backoff.noteEligiblePrefix(1)
    for (let i = 0; i < 20; i++) backoff.recordDeferral(60_000) // 2^20 × 60 s ≫ cap
    t = DEFERRAL_NOT_BEFORE_CAP_MS - 1
    expect(backoff.blocksBoundaryRun(2)).toBe(true)
    t = DEFERRAL_NOT_BEFORE_CAP_MS
    expect(backoff.blocksBoundaryRun(2)).toBe(false)
  })
})

describe('content join rule (§6.4)', () => {
  it('joins final texts with blank lines and a single trailing newline', () => {
    expect(joinSnippetTexts(['One.\n', 'Two.\n\n', 'Three.'])).toBe('One.\n\nTwo.\n\nThree.\n')
  })
})
