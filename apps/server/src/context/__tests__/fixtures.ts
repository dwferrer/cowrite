import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { UsageEvent } from '@cowrite/shared'
import { templateRenderer } from '../../prompt/renderer.js'
import { loadTemplates, type TemplateSet } from '../../prompt/templates/loader.js'
import { ContextEngine, type EngineDeps } from '../engine.js'
import { createSyncHasher, type SyncHasher } from '../estimate.js'
import type { PromptRenderer } from '../renderTypes.js'
import { captureSnapshot, type SectionSource, type WorkSnapshot } from '../snapshot.js'

/**
 * Test-only synthetic works for the context-engine suite: in-memory readers implementing
 * the EngineDeps seam, deterministic ids, and a tmp contextDir per engine. Everything the
 * engine reads is mutable between tasks, so snapshot-isolation tests can edit the "work"
 * mid-task and watch nothing change until the next beginTask.
 */

/** Deterministic, syntactically valid ULID (digits are in the ULID alphabet). */
export const tid = (n: number): string => String(n).padStart(26, '0')

export const WORK_ID = tid(999)

/** Deterministic fake content hash in the shared Hash format. */
export function fakeHash(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `xxh64:${(hash >>> 0).toString(16).padStart(16, '0')}`
}

export type FakeSection = SectionSource & { content?: string }

export interface FakeData {
  levelScheme: string[]
  sections: FakeSection[]
  snippets: Array<{ id: string; orderKey: string; text: string }>
  world: Array<{ id: string; name: string; shortSummary: string | null; body: string }>
  situation: string
}

export function section(opts: {
  id: string
  parentId?: string | null
  kind?: string
  orderKey: string
  title?: string | null
  content?: string
  short?: string | null
  long?: string | null
  frozenAt?: string | null
}): FakeSection {
  const content = opts.content
  return {
    id: opts.id,
    parentId: opts.parentId ?? null,
    kind: opts.kind ?? 'chapter',
    orderKey: opts.orderKey,
    title: opts.title ?? null,
    contentHash: content === undefined ? null : fakeHash(content),
    frozenAt: opts.frozenAt ?? (content === undefined ? null : '2026-07-01T00:00:00Z'),
    wordCount: content === undefined ? 0 : content.split(/\s+/).filter((w) => w !== '').length,
    shortSummary: opts.short ?? null,
    longSummary: opts.long ?? null,
    ...(content === undefined ? {} : { content }),
  }
}

export function paragraphs(seed: string, count: number, sentencesPer = 3): string {
  const out: string[] = []
  for (let p = 0; p < count; p++) {
    const sentences: string[] = []
    for (let s = 0; s < sentencesPer; s++) {
      sentences.push(
        `The ${seed} wind carried paragraph ${p + 1} sentence ${s + 1} over the grey water.`,
      )
    }
    out.push(sentences.join(' '))
  }
  return out.join('\n\n')
}

export function readersFor(data: FakeData): {
  manuscript: EngineDeps['manuscript']
  worldInfo: EngineDeps['worldInfo']
  situation: EngineDeps['situation']
} {
  return {
    manuscript: {
      levelScheme: () => data.levelScheme,
      listSections: () =>
        data.sections.map((s) => {
          const { content, ...rest } = s
          return {
            ...rest,
            contentHash: content === undefined ? null : fakeHash(content),
            wordCount:
              content === undefined ? 0 : content.split(/\s+/).filter((w) => w !== '').length,
          }
        }),
      getSectionContent: async (sectionId: string) => {
        const s = data.sections.find((x) => x.id === sectionId)
        if (s === undefined || s.content === undefined) {
          throw new Error(`no content for section ${sectionId}`)
        }
        return { text: s.content, contentHash: fakeHash(s.content) }
      },
      listSnippets: async () => data.snippets.map((s) => ({ ...s })),
    },
    worldInfo: {
      listEntries: async () => data.world.map((e) => ({ ...e })),
    },
    situation: {
      getSituation: async () => ({ text: data.situation }),
    },
  }
}

let sharedHasher: SyncHasher | null = null
export async function hasher(): Promise<SyncHasher> {
  sharedHasher ??= await createSyncHasher()
  return sharedHasher
}

let sharedTemplates: Promise<TemplateSet> | null = null
export function templates(): Promise<TemplateSet> {
  sharedTemplates ??= loadTemplates()
  return sharedTemplates
}

/** The production template-backed renderer (07 §6) — the suite's default. */
export async function renderer(): Promise<PromptRenderer> {
  return templateRenderer(await templates())
}

export async function snapshotOf(data: FakeData): Promise<WorkSnapshot> {
  return captureSnapshot(readersFor(data), await hasher())
}

/** A three-chapter work exercising the rule-2/3/4 mix + world entries + situation. */
export function sampleWork(): FakeData {
  return {
    levelScheme: ['chapter'],
    sections: [
      section({
        id: tid(1),
        orderKey: 'a0',
        title: 'One',
        content: paragraphs('first', 4),
        short: 'Chapter one short summary: the keeper arrives.',
        long: 'Chapter one long summary. The keeper arrives at the light and finds the lamp room sealed from the inside.',
      }),
      section({
        id: tid(2),
        orderKey: 'a1',
        title: 'Two',
        content: paragraphs('second', 4),
        short: 'Chapter two short summary: the glass blooms.',
      }),
      section({
        id: tid(3),
        orderKey: 'a2',
        title: 'Three',
        content: paragraphs('third', 4),
        // no summaries: rule-2 full inclusion
      }),
    ],
    snippets: [
      { id: tid(11), orderKey: 'b0', text: paragraphs('frontier-one', 2) },
      { id: tid(12), orderKey: 'b1', text: paragraphs('frontier-two', 2) },
    ],
    world: [
      {
        id: tid(21),
        name: 'Mara Voss',
        shortSummary: 'Keeper of the Saltmarsh light.',
        body: 'Mara Voss has kept the light for eleven years. Her left hand is ruined.',
      },
      {
        id: tid(22),
        name: 'The storm glass',
        shortSummary: null,
        body: 'A sealed spirit-glass whose crystals bloom before weather arrives.',
      },
    ],
    situation: 'Mara confronts the harbormaster; storm building.',
  }
}

export interface EngineHarness {
  engine: ContextEngine
  data: FakeData
  dir: string
  usage: UsageEvent[]
  warnings: string[]
  enrichmentWanted: string[]
  /** Fire the in-process `enrichment.completed` channel. */
  fireEnrichmentCompleted(sectionId: string): void
  cleanup(): Promise<void>
}

export async function makeEngine(
  data: FakeData = sampleWork(),
  extra: Partial<EngineDeps> = {},
): Promise<EngineHarness> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cowrite-context-'))
  const usage: UsageEvent[] = []
  const warnings: string[] = []
  const enrichmentWanted: string[] = []
  const callbacks: Array<(sectionId: string) => void> = []
  let tick = 0
  const engine = await ContextEngine.load({
    workId: WORK_ID,
    contextDir: dir,
    renderer: await renderer(),
    ...readersFor(data),
    channels: {
      emitEnrichmentWanted: (sectionId) => {
        enrichmentWanted.push(sectionId)
      },
      onEnrichmentCompleted: (cb) => {
        callbacks.push(cb)
        return () => {}
      },
    },
    onUsage: (e) => {
      usage.push(e)
    },
    warn: (m) => {
      warnings.push(m)
    },
    now: () => new Date(Date.UTC(2026, 6, 1, 0, 0, tick++)),
    ...extra,
  })
  return {
    engine,
    data,
    dir,
    usage,
    warnings,
    enrichmentWanted,
    fireEnrichmentCompleted: (sectionId) => {
      for (const cb of callbacks) cb(sectionId)
    },
    cleanup: async () => {
      await engine.close() // detaches subscriptions + awaits the usage-append tail
      await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    },
  }
}
