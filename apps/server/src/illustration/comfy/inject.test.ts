import { describe, expect, it } from 'vitest'
import { deriveInjectionMap, inject, resolveOutputImages, scanMarkers } from './inject.js'

/** Typed accessor for a node's `inputs` in test assertions (avoids `any`). */
function inputsOf(graph: Record<string, unknown>, id: string): Record<string, unknown> {
  return (graph[id] as { inputs: Record<string, unknown> }).inputs
}

/** A minimal but valid SDXL-shaped api-format graph with %prompt%/%seed%/%output% markers. */
function validGraph(): Record<string, unknown> {
  return {
    '6': {
      class_type: 'CLIPTextEncode',
      _meta: { title: '%prompt%' },
      inputs: { text: 'placeholder', clip: ['4', 1] },
    },
    '7': {
      class_type: 'CLIPTextEncode',
      _meta: { title: 'Negative' },
      inputs: { text: 'blurry', clip: ['4', 1] },
    },
    '3': {
      class_type: 'KSampler',
      _meta: { title: 'KSampler %seed%' },
      inputs: {
        seed: 0,
        steps: 28,
        model: ['4', 0],
        positive: ['6', 0],
        negative: ['7', 0],
        latent_image: ['5', 0],
      },
    },
    '5': {
      class_type: 'EmptyLatentImage',
      _meta: { title: '%width% %height%' },
      inputs: { width: 1216, height: 832 },
    },
    '9': {
      class_type: 'SaveImage',
      _meta: { title: '%output%' },
      inputs: { images: ['8', 0], filename_prefix: 'cowrite' },
    },
  }
}

describe('scanMarkers', () => {
  it('collects node ids per marker, including two markers in one title', () => {
    const scan = scanMarkers(validGraph())
    expect(scan.prompt).toEqual(['6'])
    expect(scan.seed).toEqual(['3'])
    expect(scan.width).toEqual(['5'])
    expect(scan.height).toEqual(['5'])
    expect(scan.output).toEqual(['9'])
  })

  it('ignores unknown markers and non-object nodes', () => {
    const scan = scanMarkers({
      a: { _meta: { title: '%refimage% %prompt%' }, inputs: { text: 'x' } },
      b: 'not-a-node',
      c: { _meta: { title: 'plain title' } },
    })
    expect(scan.prompt).toEqual(['a'])
    expect(scan.seed).toEqual([])
  })
})

describe('deriveInjectionMap', () => {
  it('maps every field from a valid graph', () => {
    const res = deriveInjectionMap(validGraph())
    expect(res).toEqual({
      ok: true,
      injections: {
        promptNodeId: '6',
        seedNodeIds: ['3'],
        widthNodeId: '5',
        heightNodeId: '5',
        outputNodeId: '9',
      },
    })
  })

  it('maps multiple %seed% nodes', () => {
    const graph = validGraph()
    graph['10'] = {
      class_type: 'KSampler',
      _meta: { title: 'Refiner %seed%' },
      inputs: { noise_seed: 0 },
    }
    const res = deriveInjectionMap(graph)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.injections.seedNodeIds).toEqual(['3', '10'])
  })

  it('%output% wins over whitelist nodes', () => {
    const graph = validGraph()
    // Add a second SaveImage — ambiguous WITHOUT %output%, but %output% resolves it.
    graph['11'] = {
      class_type: 'SaveImage',
      _meta: { title: 'Extra save' },
      inputs: { images: ['8', 0] },
    }
    const res = deriveInjectionMap(graph)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.injections.outputNodeId).toBe('9')
  })

  it('falls back to the unique whitelisted class when %output% is absent', () => {
    const graph = validGraph()
    graph['9'] = { class_type: 'SaveImage', _meta: { title: 'Save' }, inputs: { images: ['8', 0] } }
    const res = deriveInjectionMap(graph)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.injections.outputNodeId).toBe('9')
  })
})

describe('deriveInjectionMap — validation matrix (§11)', () => {
  it('missing %prompt%', () => {
    const graph = validGraph()
    graph['6'] = {
      class_type: 'CLIPTextEncode',
      _meta: { title: 'Positive' },
      inputs: { text: 'x' },
    }
    const res = deriveInjectionMap(graph)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/No %prompt% marker/)
  })

  it('duplicate %prompt%', () => {
    const graph = validGraph()
    graph['12'] = {
      class_type: 'CLIPTextEncode',
      _meta: { title: 'Second %prompt%' },
      inputs: { text: 'y' },
    }
    const res = deriveInjectionMap(graph)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/Multiple %prompt% markers/)
  })

  it('%prompt% node without a string text input', () => {
    const graph = validGraph()
    graph['6'] = { class_type: 'KSampler', _meta: { title: '%prompt%' }, inputs: { seed: 0 } }
    const res = deriveInjectionMap(graph)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/no string "text" input/)
  })

  it('missing %seed%', () => {
    const graph = validGraph()
    graph['3'] = {
      class_type: 'KSampler',
      _meta: { title: 'KSampler' },
      inputs: { seed: 0, model: ['4', 0], positive: ['6', 0] },
    }
    const res = deriveInjectionMap(graph)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/No %seed% marker/)
  })

  it('%seed% node without an integer seed/noise_seed input', () => {
    const graph = validGraph()
    graph['3'] = { class_type: 'KSampler', _meta: { title: '%seed%' }, inputs: { steps: 20 } }
    const res = deriveInjectionMap(graph)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/no integer "seed" or "noise_seed"/)
  })

  it('zero whitelist output nodes without %output%', () => {
    const graph = validGraph()
    graph['9'] = {
      class_type: 'VAEDecode',
      _meta: { title: 'Decode' },
      inputs: { samples: ['3', 0] },
    }
    const res = deriveInjectionMap(graph)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/no SaveImage\/PreviewImage node found/)
  })

  it('multiple whitelist output nodes without %output%', () => {
    const graph = validGraph()
    graph['9'] = {
      class_type: 'SaveImage',
      _meta: { title: 'Save A' },
      inputs: { images: ['8', 0] },
    }
    graph['11'] = {
      class_type: 'PreviewImage',
      _meta: { title: 'Preview B' },
      inputs: { images: ['8', 0] },
    }
    const res = deriveInjectionMap(graph)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/multiple output-capable nodes/)
  })

  it('multiple %output% markers', () => {
    const graph = validGraph()
    graph['11'] = {
      class_type: 'SaveImage',
      _meta: { title: '%output%' },
      inputs: { images: ['8', 0] },
    }
    const res = deriveInjectionMap(graph)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/Multiple %output% markers/)
  })

  it('empty / non-object graph', () => {
    expect(deriveInjectionMap({}).ok).toBe(false)
    expect(deriveInjectionMap([] as unknown as Record<string, unknown>).ok).toBe(false)
  })
})

describe('inject (pure)', () => {
  function resolved() {
    const json = validGraph()
    const derived = deriveInjectionMap(json)
    if (!derived.ok) throw new Error('fixture must be valid')
    return { json, injections: derived.injections }
  }

  it('sets inputs.text on the prompt node and seed on the seed node', () => {
    const wf = resolved()
    const out = inject(wf, { prompt: 'a lighthouse at dusk', seed: 42 })
    expect(inputsOf(out, '6').text).toBe('a lighthouse at dusk')
    expect(inputsOf(out, '3').seed).toBe(42)
  })

  it('prefers noise_seed when the node has no seed field', () => {
    const json = validGraph()
    json['3'] = { class_type: 'KSampler', _meta: { title: '%seed%' }, inputs: { noise_seed: 0 } }
    const derived = deriveInjectionMap(json)
    if (!derived.ok) throw new Error('unexpected')
    const out = inject({ json, injections: derived.injections }, { prompt: 'x', seed: 7 })
    expect(inputsOf(out, '3').noise_seed).toBe(7)
    expect('seed' in inputsOf(out, '3')).toBe(false)
  })

  it('injects noise_seed when seed is a LINKED input, matching validation (§17)', () => {
    // The seed field is a link (`['12', 0]`) — not a plain integer — but noise_seed is a valid
    // integer. Validation accepts (noise_seed drives the sampler) and inject must write the SAME
    // field, or every attempt renders an identical image.
    const json = validGraph()
    json['3'] = {
      class_type: 'KSampler',
      _meta: { title: '%seed%' },
      inputs: { seed: ['12', 0], noise_seed: 45 },
    }
    const derived = deriveInjectionMap(json)
    expect(derived.ok).toBe(true)
    if (!derived.ok) throw new Error('unexpected')
    const out = inject({ json, injections: derived.injections }, { prompt: 'x', seed: 7 })
    // noise_seed (the valid integer field) got the fresh seed; the linked seed is untouched.
    expect(inputsOf(out, '3').noise_seed).toBe(7)
    expect(inputsOf(out, '3').seed).toEqual(['12', 0])
  })

  it('rejects a %seed% node whose only seed field is a non-integer link (§17)', () => {
    const json = validGraph()
    json['3'] = {
      class_type: 'KSampler',
      _meta: { title: '%seed%' },
      inputs: { seed: ['12', 0] }, // linked, no noise_seed
    }
    const res = deriveInjectionMap(json)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/no integer "seed" or "noise_seed"/)
  })

  it('writes the same seed to every %seed% node', () => {
    const json = validGraph()
    json['10'] = {
      class_type: 'KSampler',
      _meta: { title: 'Refiner %seed%' },
      inputs: { noise_seed: 0 },
    }
    const derived = deriveInjectionMap(json)
    if (!derived.ok) throw new Error('unexpected')
    const out = inject({ json, injections: derived.injections }, { prompt: 'x', seed: 99 })
    expect(inputsOf(out, '3').seed).toBe(99)
    expect(inputsOf(out, '10').noise_seed).toBe(99)
  })

  it('property: only mapped fields change and the template is never mutated', () => {
    for (const [prompt, seed] of [
      ['first prompt', 1],
      ['another moment', 2_000_000],
      ['', 9_007_199_254_740_990],
    ] as const) {
      const json = validGraph()
      const before = structuredClone(json)
      const derived = deriveInjectionMap(json)
      if (!derived.ok) throw new Error('unexpected')
      const out = inject({ json, injections: derived.injections }, { prompt, seed })

      // Template untouched (deep-equal to its pre-call snapshot).
      expect(json).toEqual(before)

      // Output differs from the template ONLY at inputs.text of the prompt node and
      // inputs.seed of the seed node.
      for (const id of Object.keys(json)) {
        const tNode = structuredClone(json[id]) as { inputs: Record<string, unknown> }
        const oNode = out[id]
        if (id === '6') tNode.inputs.text = prompt
        if (id === '3') tNode.inputs.seed = seed
        expect(oNode).toEqual(tNode)
      }
    }
  })

  it('returns a deep clone with no shared references to the template', () => {
    const wf = resolved()
    const out = inject(wf, { prompt: 'x', seed: 1 })
    expect(out).not.toBe(wf.json)
    expect(inputsOf(out, '3')).not.toBe(inputsOf(wf.json, '3'))
  })
})

describe('resolveOutputImages (runtime backstop, §2.2)', () => {
  it('uses the chosen output node when it has images', () => {
    const r = resolveOutputImages('9', { '9': { images: [{ filename: 'a.png' }] } })
    expect(r).toEqual({ nodeId: '9' })
  })

  it('falls back to the unique other producer and warns', () => {
    const r = resolveOutputImages('9', {
      '9': { images: [] },
      '12': { images: [{ filename: 'b.png' }] },
    })
    expect(r?.nodeId).toBe('12')
    expect(r?.warn).toMatch(/add %output%/)
  })

  it('returns null when no node produced images', () => {
    expect(resolveOutputImages('9', { '9': { images: [] } })).toBeNull()
  })

  it('returns null when multiple other nodes produced images (ambiguous)', () => {
    const r = resolveOutputImages('9', {
      '9': { images: [] },
      '12': { images: [{ filename: 'b.png' }] },
      '13': { images: [{ filename: 'c.png' }] },
    })
    expect(r).toBeNull()
  })
})
