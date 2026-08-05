import type { IllustrationMeta } from '@cowrite/shared'
import { beforeAll, describe, expect, it } from 'vitest'
import { loadTemplates, type TemplateSet } from '../prompt/templates/loader.js'
import {
  buildIntentBrief,
  capTokens,
  compose,
  type IntentBrief,
  revise,
  TRUNCATION_MARKER,
  truncateContent,
} from './composer.js'
import { FakeStorage, imagePromptText, makeCtx } from './testkit.js'

const ULID_A = '01J2N8Q3F7VWXK2MR9T5BCAD01'
const ULID_B = '01J2N9AAE2QRSTK4MP7Y3XCD02'

let templates: TemplateSet
beforeAll(async () => {
  templates = await loadTemplates()
})

function fakeMeta(overrides: Partial<IllustrationMeta>): IllustrationMeta {
  return {
    source: 'agent',
    runId: ULID_A,
    generatedAt: '2026-08-01T00:00:00.000Z',
    sourceHash: null,
    sourceWordCount: null,
    entities: [],
    prompt: null,
    workflow: 'default',
    workflowHash: 'xxh64:0000000000000000',
    seed: 1,
    attempts: 1,
    score: 8,
    guidance: null,
    ...overrides,
  }
}

describe('truncateContent (§4.2 content fallback)', () => {
  it('passes short bodies through unchanged', () => {
    const short = 'one two three four five'
    expect(truncateContent(short, 1000, 2000)).toEqual({ text: short, truncated: false })
  })

  it('keeps the head and tail with a […] marker, eliding the middle', () => {
    const head = Array.from({ length: 10 }, (_, i) => `H${i}`)
    const middle = Array.from({ length: 50 }, (_, i) => `M${i}`)
    const tail = Array.from({ length: 20 }, (_, i) => `T${i}`)
    const content = [...head, ...middle, ...tail].join(' ')
    const { text, truncated } = truncateContent(content, 10, 20)
    expect(truncated).toBe(true)
    expect(text).toContain(TRUNCATION_MARKER)
    expect(text).toContain('H0')
    expect(text).toContain('H9')
    expect(text).toContain('T0')
    expect(text).toContain('T19')
    expect(text).not.toContain('M25') // the middle is elided
  })
})

describe('capTokens', () => {
  it('clamps to N whitespace words', () => {
    expect(capTokens('a b c d e', 3)).toBe('a b c')
    expect(capTokens('a b', 5)).toBe('a b')
  })
})

describe('buildIntentBrief (§4.2)', () => {
  it('records matched world-entry ids as the brief entities and caps at 4', async () => {
    const storage = new FakeStorage()
    storage.matched = [
      {
        meta: { id: ULID_A, name: 'Mara Voss' },
        body: 'A weathered woman with cropped grey hair.',
      },
      { meta: { id: ULID_B, name: 'The storm glass' }, body: 'A teardrop of cloudy glass.' },
    ]
    const brief = await buildIntentBrief(storage, {
      kind: 'section',
      title: 'The Storm Glass',
      longSummary: 'Mara retrieves the storm glass from the sealed lamp room.',
      content: 'Mara and the storm glass.',
    })
    expect(brief.entities).toEqual([ULID_A, ULID_B])
    expect(brief.worldEntries.map((e) => e.name)).toEqual(['Mara Voss', 'The storm glass'])
    expect(brief.targetText).toContain('sealed lamp room')
  })

  it('falls back to truncated content when no long summary exists', async () => {
    const storage = new FakeStorage()
    const content = Array.from({ length: 4000 }, (_, i) => `w${i}`).join(' ')
    const brief = await buildIntentBrief(storage, {
      kind: 'section',
      title: 'X',
      longSummary: null,
      content,
    })
    expect(brief.targetText).toContain(TRUNCATION_MARKER)
  })

  it('established imagery = prior winning prompts sharing an entity id, newest first', async () => {
    const storage = new FakeStorage()
    storage.matched = [{ meta: { id: ULID_A, name: 'Mara Voss' }, body: 'cropped grey hair' }]
    storage.metas = [
      {
        kind: 'section',
        id: 'sec-old',
        meta: fakeMeta({
          entities: [ULID_A],
          prompt: 'OLD winner, cropped grey hair',
          generatedAt: '2026-01-01T00:00:00.000Z',
        }),
      },
      {
        kind: 'section',
        id: 'sec-new',
        meta: fakeMeta({
          entities: [ULID_A],
          prompt: 'NEW winner, cropped grey hair',
          generatedAt: '2026-07-01T00:00:00.000Z',
        }),
      },
      {
        kind: 'section',
        id: 'sec-unrelated',
        meta: fakeMeta({ entities: [ULID_B], prompt: 'unrelated' }),
      },
    ]
    const brief = await buildIntentBrief(storage, {
      kind: 'section',
      title: 'Later chapter',
      longSummary: 'Mara again.',
      content: 'Mara.',
    })
    expect(brief.establishedImagery.map((i) => i.text)).toEqual([
      'NEW winner, cropped grey hair',
      'OLD winner, cropped grey hair',
    ])
    expect(brief.establishedImagery[0]?.from).toBe('Mara Voss')
  })

  it('reads established imagery BY the matched entity ids only, not the whole work (§4.2)', async () => {
    const storage = new FakeStorage()
    storage.matched = [{ meta: { id: ULID_A, name: 'Mara Voss' }, body: 'cropped grey hair' }]
    // A large work: one prior shares the matched entity; 200 others do not.
    storage.metas = [
      {
        kind: 'section',
        id: 'sec-shared',
        meta: fakeMeta({ entities: [ULID_A], prompt: 'the one relevant winner' }),
      },
      ...Array.from({ length: 200 }, (_, i) => ({
        kind: 'section' as const,
        id: `sec-${i}`,
        meta: fakeMeta({ entities: [`01J2N9ZZZZZZZZZZZZZZZZZZ${i.toString().padStart(3, '0')}`] }),
      })),
    ]
    const brief = await buildIntentBrief(storage, {
      kind: 'section',
      title: 'Later chapter',
      longSummary: 'Mara again.',
      content: 'Mara.',
    })
    // The compose queried by the matched entity ids exactly once…
    expect(storage.metaQueries).toEqual([[ULID_A]])
    // …and only the entity-sharing prior survived — the 200 unrelated metas were never in play.
    expect(brief.establishedImagery.map((i) => i.text)).toEqual(['the one relevant winner'])
  })

  it('world-image brief uses [entryId] as its entities and looks up that entity', async () => {
    const storage = new FakeStorage()
    storage.metas = [
      {
        kind: 'world',
        id: ULID_B,
        meta: fakeMeta({ entities: [ULID_B], prompt: 'the glass, glowing' }),
      },
    ]
    const brief = await buildIntentBrief(storage, {
      kind: 'world',
      entryId: ULID_B,
      name: 'The storm glass',
      body: 'A teardrop of cloudy glass.',
    })
    expect(brief.entities).toEqual([ULID_B])
    expect(brief.worldEntries).toEqual([])
    expect(brief.establishedImagery.map((i) => i.text)).toEqual(['the glass, glowing'])
  })

  it('clamps guidance to 500 chars and drops blank guidance', async () => {
    const storage = new FakeStorage()
    const long = 'x'.repeat(600)
    const brief = await buildIntentBrief(
      storage,
      { kind: 'world', entryId: ULID_A, name: 'n', body: 'b' },
      long,
    )
    expect(brief.guidance?.length).toBe(500)
    const blank = await buildIntentBrief(
      storage,
      { kind: 'world', entryId: ULID_A, name: 'n', body: 'b' },
      '   ',
    )
    expect(blank.guidance).toBeNull()
  })
})

function sectionBrief(): IntentBrief {
  return {
    kind: 'section',
    title: 'The Storm Glass',
    targetText: 'Mara retrieves the storm glass.',
    worldEntries: [{ id: ULID_A, name: 'Mara Voss', body: 'cropped grey hair' }],
    establishedImagery: [{ from: 'Mara Voss', text: 'a woman with cropped grey hair' }],
    guidance: 'dusk light',
    entities: [ULID_A],
  }
}

describe('compose (§4.2 output parsing + run events)', () => {
  it('parses the <image-prompt> paragraph and emits message/output/usage', async () => {
    const h = makeCtx(templates)
    h.lowClient.promptResponses = [
      imagePromptText('A woman with cropped grey hair holds a lantern.'),
    ]
    const prompt = await compose(h.ctx, sectionBrief())
    expect(prompt).toBe('A woman with cropped grey hair holds a lantern.')

    const userMsg = h.events.find((e) => e.type === 'message' && e.role === 'user')
    expect(userMsg && 'text' in userMsg ? userMsg.text : '').toContain('<target>')
    expect(userMsg && 'text' in userMsg ? userMsg.text : '').toContain('cropped grey hair')
    expect(h.events.some((e) => e.type === 'output')).toBe(true)
    const usage = h.events.find((e) => e.type === 'usage')
    expect(usage && 'call' in usage ? usage.call : '').toBe('pipeline')
  })

  it('runs one repair turn when the first reply omits the block', async () => {
    const h = makeCtx(templates)
    h.lowClient.promptResponses = [
      'I could not decide on a moment.',
      imagePromptText('A lantern glows in the fog.'),
    ]
    const prompt = await compose(h.ctx, sectionBrief())
    expect(prompt).toBe('A lantern glows in the fog.')
    expect(h.lowClient.requests).toHaveLength(2)
  })
})

describe('revise (§4.3)', () => {
  it('embeds the previous prompt and the critic advice, returns the new paragraph', async () => {
    const h = makeCtx(templates)
    h.lowClient.promptResponses = [imagePromptText('A closer view at dusk, warm light.')]
    const next = await revise(h.ctx, sectionBrief(), 'the old prompt', 'add the missing lighthouse')
    expect(next).toBe('A closer view at dusk, warm light.')
    const userMsg = h.events.find((e) => e.type === 'message' && e.role === 'user')
    const text = userMsg && 'text' in userMsg ? userMsg.text : ''
    expect(text).toContain('the old prompt')
    expect(text).toContain('add the missing lighthouse')
  })
})
