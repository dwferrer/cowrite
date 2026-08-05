import { beforeAll, describe, expect, it } from 'vitest'
import { loadTemplates, type TemplateSet } from '../prompt/templates/loader.js'
import type { IntentBrief } from './composer.js'
import { asRevise, critique, NEUTRAL_CRITIQUE, parseCritique } from './critic.js'
import { critiqueText, makeCtx } from './testkit.js'

let templates: TemplateSet
beforeAll(async () => {
  templates = await loadTemplates()
})

const brief: IntentBrief = {
  kind: 'section',
  title: 'The Storm Glass',
  targetText: 'Mara retrieves the storm glass.',
  worldEntries: [
    { id: '01J2N8Q3F7VWXK2MR9T5BCAD01', name: 'Mara Voss', body: 'cropped grey hair' },
  ],
  establishedImagery: [],
  guidance: null,
  entities: ['01J2N8Q3F7VWXK2MR9T5BCAD01'],
}

const PNG = Buffer.from('fake-png-bytes')

describe('parseCritique / extractFencedJson', () => {
  it('parses a fenced JSON block', () => {
    const crit = parseCritique(critiqueText({ verdict: 'accept', overall: 8 }))
    expect(crit?.verdict).toBe('accept')
    expect(crit?.overall).toBe(8)
  })

  it('parses a bare JSON object without a fence', () => {
    const crit = parseCritique(
      'noise {"verdict":"revise","scores":{"subject":3,"consistency":3,"craft":3,"mood":3},"overall":5,"problems":[],"promptAdvice":"x"} trailing',
    )
    expect(crit?.verdict).toBe('revise')
  })

  it('returns null on unparseable / schema-invalid text', () => {
    expect(parseCritique('not json at all')).toBeNull()
    expect(parseCritique('```json\n{"verdict":"maybe"}\n```')).toBeNull()
  })
})

describe('asRevise coercion (§4.3)', () => {
  it('uses promptAdvice when present', () => {
    expect(asRevise({ ...NEUTRAL_CRITIQUE, promptAdvice: 'add the lighthouse' })).toBe(
      'add the lighthouse',
    )
  })

  it('falls back to joined problems when advice is blank', () => {
    expect(
      asRevise({
        ...NEUTRAL_CRITIQUE,
        promptAdvice: '  ',
        problems: ['no lighthouse', 'too dark'],
      }),
    ).toBe('no lighthouse; too dark')
  })

  it('falls back to a stock instruction when nothing is actionable', () => {
    expect(asRevise(NEUTRAL_CRITIQUE)).toBe(
      'keep the same moment; re-assert any listed elements; simplify the composition',
    )
  })
})

describe('critique (§4.3 call)', () => {
  it('parses a valid critique and records it as a vlm.critique toolCall', async () => {
    const h = makeCtx(templates)
    h.lowClient.critiqueResponses = [
      critiqueText({ verdict: 'accept', overall: 9, problems: [], promptAdvice: '' }),
    ]
    const crit = await critique(h.ctx, PNG, brief, 'the prompt')
    expect(crit.verdict).toBe('accept')
    expect(crit.overall).toBe(9)

    const tool = h.events.find((e) => e.type === 'toolCall')
    expect(tool && 'name' in tool ? tool.name : '').toBe('vlm.critique')
    // the image rode along as an image_url content part (low lane only)
    const req = h.lowClient.requests[0]
    const parts = req?.messages[0]?.content
    expect(Array.isArray(parts) && parts.some((p) => p.type === 'image_url')).toBe(true)
  })

  it('sends the established-imagery and guidance regions to the critic (§9)', async () => {
    const h = makeCtx(templates)
    h.lowClient.critiqueResponses = [critiqueText({ verdict: 'accept', overall: 8 })]
    const briefWithContext: IntentBrief = {
      ...brief,
      establishedImagery: [
        { from: 'Mara Voss', text: 'a woman with cropped grey hair, weathered coat' },
      ],
      guidance: 'make it dusk, warmer light',
    }
    await critique(h.ctx, PNG, briefWithContext, 'the prompt')
    const text = h.lowClient.requests[0]?.messages[0]?.content
    const userText = Array.isArray(text) ? text.find((p) => p.type === 'text') : undefined
    const rendered = userText && userText.type === 'text' ? userText.text : ''
    // the consistency axis needs the prior imagery; guidance must not be penalized.
    expect(rendered).toContain('<established-imagery>')
    expect(rendered).toContain('a woman with cropped grey hair, weathered coat')
    expect(rendered).toContain('<guidance>')
    expect(rendered).toContain('make it dusk, warmer light')
  })

  it('repairs once on a parse miss, then succeeds', async () => {
    const h = makeCtx(templates)
    h.lowClient.critiqueResponses = [
      'I think it looks pretty good honestly.',
      critiqueText({ verdict: 'revise', overall: 6, promptAdvice: 'brighten it' }),
    ]
    const crit = await critique(h.ctx, PNG, brief, 'the prompt')
    expect(crit.overall).toBe(6)
    expect(h.lowClient.requests).toHaveLength(2)
  })

  it('falls back to the neutral critique after the repair also fails', async () => {
    const h = makeCtx(templates)
    h.lowClient.critiqueResponses = ['garbage', 'still garbage']
    const crit = await critique(h.ctx, PNG, brief, 'the prompt')
    expect(crit).toEqual(NEUTRAL_CRITIQUE)
    expect(crit.verdict).toBe('revise')
    expect(crit.overall).toBe(5)
  })
})
