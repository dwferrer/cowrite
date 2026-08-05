import type { CritiqueResult, IllustrationMeta, RunEventInput } from '@cowrite/shared'
import type { ChatOpts, ChatRequest, ChatResult } from '../models/client.js'
import type { NormalizedUsage } from '../models/usage.js'
import type { TemplateSet } from '../prompt/templates/loader.js'
import type { ResolvedWorkflow, WorkflowRegistry } from './comfy/registry.js'
import type {
  BriefWorldEntry,
  ComfyClient,
  ComfyGenerateRequest,
  ComfyResult,
  IllustrationProgress,
  IllustrationStorage,
  ImageOps,
  RunContext,
} from './ctx.js'

/**
 * Shared fakes for the illustration unit tests (docs/08 §11 tier 1): a scripted low client, a
 * scriptable ComfyUI client, an identity downscaler, and a configurable storage stub — no HTTP,
 * no models, no ComfyUI, no `sharp`. Not shipped behavior; test scaffolding only.
 */

export const USAGE: NormalizedUsage = { promptTokens: 10, completionTokens: 5, estimated: false }

/** Wrap a paragraph in a well-formed `<image-prompt>` block (with leading chatter, discarded). */
export function imagePromptText(paragraph: string): string {
  return `Sure, here is the prompt:\n<image-prompt>\n${paragraph}\n</image-prompt>`
}

/** A full `CritiqueResult` as a fenced JSON block, with defaults for the unstated axes. */
export function critiqueText(c: {
  verdict: 'accept' | 'revise'
  overall: number
  problems?: string[]
  promptAdvice?: string
  scores?: CritiqueResult['scores']
}): string {
  const body = {
    verdict: c.verdict,
    scores: c.scores ?? { subject: 4, consistency: 4, craft: 4, mood: 4 },
    overall: c.overall,
    problems: c.problems ?? [],
    promptAdvice: c.promptAdvice ?? '',
  }
  return `Here is my review:\n\`\`\`json\n${JSON.stringify(body, null, 2)}\n\`\`\``
}

/** A scripted low client: text calls and image (critique) calls draw from separate queues. */
export class FakeLowClient {
  promptResponses: string[] = []
  critiqueResponses: string[] = []
  readonly requests: ChatRequest[] = []

  chat(request: ChatRequest, _opts?: ChatOpts): Promise<ChatResult> {
    this.requests.push(request)
    const hasImage = request.messages.some(
      (m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'),
    )
    const queue = hasImage ? this.critiqueResponses : this.promptResponses
    const text = queue.shift()
    if (text === undefined) {
      throw new Error(`FakeLowClient: no scripted ${hasImage ? 'critique' : 'prompt'} response`)
    }
    return Promise.resolve({ text, toolCalls: [], usage: USAGE, finishReason: 'stop' })
  }
}

/** A scriptable ComfyUI client: per-call PNGs and optional per-call failures. */
export class FakeComfy implements ComfyClient {
  healthOk = true
  healthDetail: string | undefined
  pngs: Buffer[] = [Buffer.from('png-default')]
  /** index-aligned; a set entry throws on that generate call. */
  failWith: (Error | null)[] = []
  readonly generateCalls: ComfyGenerateRequest[] = []

  health(): Promise<{ ok: boolean; detail?: string }> {
    return Promise.resolve(
      this.healthOk ? { ok: true } : { ok: false, detail: this.healthDetail ?? 'down' },
    )
  }

  generate(req: ComfyGenerateRequest): Promise<ComfyResult> {
    const i = this.generateCalls.length
    this.generateCalls.push(req)
    const err = this.failWith[i]
    if (err) return Promise.reject(err)
    req.onProgress({ phase: 'generating', pct: 50 })
    const png = this.pngs[i] ?? this.pngs[this.pngs.length - 1] ?? Buffer.from('png')
    return Promise.resolve({ png, filename: `out-${i}.png`, durationMs: 10, promptId: `p${i}` })
  }
}

export const identityImageOps: ImageOps = {
  downscalePng: (png) => Promise.resolve(png),
  transcodeToPng: (png) => Promise.resolve(png),
}

/** A ResolvedWorkflow with just enough shape for the loop (§2.3 injection map + timeout). */
export function fakeWorkflow(overrides: Partial<ResolvedWorkflow> = {}): ResolvedWorkflow {
  return {
    name: 'default',
    label: 'Default',
    json: {
      '6': { class_type: 'CLIPTextEncode', _meta: { title: '%prompt%' }, inputs: { text: '' } },
      '3': { class_type: 'KSampler', _meta: { title: 'K %seed%' }, inputs: { seed: 0 } },
      '9': { class_type: 'SaveImage', _meta: { title: '%output%' }, inputs: {} },
    },
    injections: { promptNodeId: '6', seedNodeIds: ['3'], outputNodeId: '9' },
    execTimeoutMs: 300_000,
    contentHash: 'xxh64:0000000000000000',
    ...overrides,
  }
}

export function fakeRegistry(section: ResolvedWorkflow, world = section): WorkflowRegistry {
  return {
    report: {
      workflows: [{ name: section.name, label: section.label, ok: true }],
      route: { section: { name: section.name, ok: true }, world: { name: world.name, ok: true } },
    },
    resolve: (kind) => (kind === 'section' ? section : world),
  }
}

/** A configurable storage stub; unset methods reject/return empty. */
export class FakeStorage implements IllustrationStorage {
  sections = new Map<
    string,
    {
      row: import('../storage/index/db.js').SectionRow
      content: string
      contentHash: string
      long: string | null
    }
  >()
  worldEntries = new Map<string, { meta: { id: string; name: string }; body: string }>()
  matched: BriefWorldEntry[] = []
  metas: Array<{ kind: 'section' | 'world'; id: string; meta: IllustrationMeta }> = []
  /** Every `listIllustrationMetasByEntities` call's entity-id argument, for the targeted-read spy. */
  readonly metaQueries: string[][] = []
  readonly puts: Array<{
    kind: 'section' | 'world'
    id: string
    png: Uint8Array
    meta: IllustrationMeta
  }> = []
  /** Simulate a vanished commit target: put* rejects with a `not_found`-coded error. */
  putShouldThrow = false
  /** Simulate a non-vanished commit failure (disk/permission): put* rejects with THIS error. */
  putThrow: Error | null = null

  private putRejection(): Promise<never> {
    if (this.putThrow !== null) return Promise.reject(this.putThrow)
    // A vanished section/entry surfaces as a typed not_found (§15).
    return Promise.reject(Object.assign(new Error('commit target gone'), { code: 'not_found' }))
  }

  getSection(id: string): import('../storage/index/db.js').SectionRow | null {
    return this.sections.get(id)?.row ?? null
  }
  getSectionContent(id: string): Promise<{ text: string; contentHash: string }> {
    const s = this.sections.get(id)
    if (s === undefined) return Promise.reject(new Error('no section'))
    return Promise.resolve({ text: s.content, contentHash: s.contentHash })
  }
  getSummaries(id: string): Promise<{ short: string | null; long: string | null }> {
    return Promise.resolve({ short: null, long: this.sections.get(id)?.long ?? null })
  }
  getWorldEntry(id: string): Promise<{ meta: { id: string; name: string }; body: string }> {
    const e = this.worldEntries.get(id)
    if (e === undefined) return Promise.reject(new Error('no entry'))
    return Promise.resolve(e)
  }
  matchWorldEntries(_text: string): Promise<BriefWorldEntry[]> {
    return Promise.resolve(this.matched)
  }
  listIllustrationMetasByEntities(
    entityIds: string[],
  ): Promise<Array<{ kind: 'section' | 'world'; id: string; meta: IllustrationMeta }>> {
    this.metaQueries.push([...entityIds])
    // Mirror the real storage's server-side entity filter so tests exercise the targeted read:
    // only metas sharing a requested entity come back.
    const wanted = new Set(entityIds)
    return Promise.resolve(this.metas.filter((m) => m.meta.entities.some((e) => wanted.has(e))))
  }
  putIllustration(id: string, png: Uint8Array, meta: IllustrationMeta): Promise<void> {
    if (this.putShouldThrow || this.putThrow !== null) return this.putRejection()
    this.puts.push({ kind: 'section', id, png, meta })
    return Promise.resolve()
  }
  putWorldImage(
    id: string,
    png: Uint8Array,
    meta: IllustrationMeta,
  ): Promise<{ imagePath: string }> {
    if (this.putShouldThrow || this.putThrow !== null) return this.putRejection()
    this.puts.push({ kind: 'world', id, png, meta })
    return Promise.resolve({ imagePath: `world/images/${id}.png` })
  }
}

export interface CtxHarness {
  ctx: RunContext
  events: RunEventInput[]
  progress: IllustrationProgress[]
  lowClient: FakeLowClient
  comfy: FakeComfy
  storage: FakeStorage
  abort(): void
}

export interface CtxOverrides {
  lowClient?: FakeLowClient
  comfy?: FakeComfy
  storage?: FakeStorage
  imageOps?: ImageOps
  registry?: WorkflowRegistry
  loop?: { maxAttempts: number; acceptScore: number }
  remainingMs?: () => number
  runId?: string
}

export function makeCtx(templates: TemplateSet, o: CtxOverrides = {}): CtxHarness {
  const events: RunEventInput[] = []
  const progress: IllustrationProgress[] = []
  const controller = new AbortController()
  const lowClient = o.lowClient ?? new FakeLowClient()
  const comfy = o.comfy ?? new FakeComfy()
  const storage = o.storage ?? new FakeStorage()
  const ctx: RunContext = {
    runId: o.runId ?? '01J2P7R9GT5W0ZNXK3M8QAB4CD',
    lowClient,
    comfy,
    storage,
    imageOps: o.imageOps ?? identityImageOps,
    registry: o.registry ?? fakeRegistry(fakeWorkflow()),
    loop: o.loop ?? { maxAttempts: 3, acceptScore: 7 },
    templates,
    emit: (e) => events.push(e),
    progress: (p) => progress.push(p),
    signal: controller.signal,
    remainingMs: o.remainingMs ?? (() => 600_000),
  }
  return { ctx, events, progress, lowClient, comfy, storage, abort: () => controller.abort() }
}
