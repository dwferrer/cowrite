import fsp from 'node:fs/promises'
import path from 'node:path'
import { wordCount, xxh64OfString } from '../lib/hash.js'
import { shortId } from '../lib/paths.js'

/**
 * Test-only fixture builder (used by the colocated *.test.ts files, never by product
 * code): a small work directory hand-written to the spec 02 §5.3/§5.4 examples —
 * 2 sections, 3 snippets, 2 world entries, 2 runs (one crashed without a result line) —
 * with the derived-staleness edge cases baked in:
 *  - sec1 shortSummary is user-edited at the current hash  → NOT stale
 *  - sec1 longSummary has a mismatched sourceHash          → stale
 *  - sec1 illustration sourceWordCount == current wc       → NOT stale
 *  - sec2 summaries missing on a frozen leaf               → stale
 *  - sec2 illustration suppressed (tombstone)              → never stale
 */

const ulidFrom = (suffix: string): string => `01J2KF${suffix.padStart(20, '0')}`

export const FIX = {
  workId: ulidFrom('WK0001'),
  sec1: ulidFrom('A1HZQA'),
  sec2: ulidFrom('B1J2KF'),
  snip1: ulidFrom('P2M9X1'),
  snip2: ulidFrom('Q8R2V7'),
  snip3: ulidFrom('T5W0ZN'),
  mara: ulidFrom('7F3AKQ'),
  glass: ulidFrom('9B1XTE'),
  run1: ulidFrom('RN0001'),
  run2: ulidFrom('RN0002'),
  consumed: ulidFrom('C0NSM1'),
} as const

export const SEC1_DIR = `010-the-lighthouse-keeper.${shortId(FIX.sec1)}`
export const SEC2_DIR = `020-the-storm-glass.${shortId(FIX.sec2)}`
export const SNIP1_FILE = `010.${shortId(FIX.snip1)}.md`
export const SNIP2_FILE = `020.${shortId(FIX.snip2)}.md`
export const SNIP3_FILE = `030.${shortId(FIX.snip3)}.md`
export const MARA_FILE = `mara-voss.${shortId(FIX.mara)}.md`
export const GLASS_FILE = `the-storm-glass.${shortId(FIX.glass)}.md`

export const SEC1_CONTENT =
  'The lighthouse keeper counted the ships while the fog rolled in over the harbor ' +
  'and the lamps burned low against the dark.\n'
export const SEC2_CONTENT = 'The storm glass hummed on its shelf, a sealed and patient warning.\n'
export const SITUATION_TEXT = 'Mara confronts the harbormaster; storm building.\n'

export const SNIP1_BODY =
  'Mara pressed her palm against the storm glass and felt it hum beneath her skin.\n'
export const SNIP2_BODY = 'The tide gnawed the pilings.\n'
export const SNIP3_BODY = 'Salt wind carried the signal bell across the water.\n'

/** A minimal buffer readPngDimensions accepts: signature + IHDR with the given dims. */
export function makePng(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33)
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  buf.writeUInt32BE(13, 8) // IHDR length
  buf.write('IHDR', 12, 'ascii')
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  return buf
}

export function snippetFileText(
  meta: {
    id: string
    orderKey: string
    createdAt: string
    updatedAt: string
    authorship: 'user' | 'agent' | 'mixed'
    originRunId: string | null
    rev: number
  },
  body: string,
): string {
  return [
    '---',
    `id: ${meta.id}`,
    `orderKey: ${meta.orderKey}`,
    `createdAt: ${meta.createdAt}`,
    `updatedAt: ${meta.updatedAt}`,
    `authorship: ${meta.authorship}`,
    `originRunId: ${meta.originRunId ?? 'null'}`,
    `rev: ${meta.rev}`,
    '---',
    body,
  ].join('\n')
}

export function worldEntryFileText(
  meta: {
    id: string
    name: string
    keys: string[]
    image: string | null
    shortSummary: string | null
    createdBy: 'user' | 'agent'
    updatedAt: string
  },
  body: string,
): string {
  return [
    '---',
    `id: ${meta.id}`,
    `name: ${meta.name}`,
    `keys: [${meta.keys.join(', ')}]`,
    `image: ${meta.image ?? 'null'}`,
    `shortSummary: ${meta.shortSummary ?? 'null'}`,
    `createdBy: ${meta.createdBy}`,
    `updatedAt: ${meta.updatedAt}`,
    '---',
    body,
  ].join('\n')
}

export interface FixtureInfo {
  workDir: string
  sec1ContentHash: string
  sec2ContentHash: string
  sec1WordCount: number
  situationHash: string
}

export async function buildFixtureWork(root: string): Promise<FixtureInfo> {
  const workDir = path.join(root, 'salt-and-signal')
  const sec1ContentHash = await xxh64OfString(SEC1_CONTENT)
  const sec2ContentHash = await xxh64OfString(SEC2_CONTENT)
  const sec1WordCount = wordCount(SEC1_CONTENT)
  const situationHash = await xxh64OfString(SITUATION_TEXT)

  const sec1Dir = path.join(workDir, 'sections', SEC1_DIR)
  const sec2Dir = path.join(workDir, 'sections', SEC2_DIR)
  for (const dir of [
    sec1Dir,
    sec2Dir,
    path.join(workDir, 'frontier', 'snippets'),
    path.join(workDir, 'frontier', 'revisions'),
    path.join(workDir, 'world', 'entries'),
    path.join(workDir, 'world', 'images'),
    path.join(workDir, 'runs', '2026-07'),
  ]) {
    await fsp.mkdir(dir, { recursive: true })
  }

  await fsp.writeFile(
    path.join(workDir, 'work.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        id: FIX.workId,
        title: 'Salt and Signal',
        levelScheme: ['chapter'],
        createdAt: '2026-06-01T00:00:00Z',
      },
      null,
      2,
    ),
  )
  await fsp.writeFile(path.join(workDir, 'situation.md'), SITUATION_TEXT)

  // -- sections ---------------------------------------------------------------
  await fsp.writeFile(path.join(sec1Dir, 'content.md'), SEC1_CONTENT)
  await fsp.writeFile(
    path.join(sec1Dir, 'section.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        id: FIX.sec1,
        kind: 'chapter',
        orderKey: 'a0',
        title: 'The Lighthouse Keeper',
        titleSource: 'agent',
        frozenAt: '2026-07-01T00:00:00Z',
        contentHash: sec1ContentHash,
        enrichments: {
          // user-edited at the current hash: NOT stale until the prose changes (§6.5)
          shortSummary: {
            source: 'user',
            runId: null,
            generatedAt: '2026-07-02T08:00:00Z',
            sourceHash: sec1ContentHash,
          },
          // agent summary generated from older prose: stale
          longSummary: {
            source: 'agent',
            runId: FIX.run1,
            generatedAt: '2026-07-01T01:00:00Z',
            sourceHash: 'xxh64:abababababababab',
          },
          // agent illustration at the current word count: fresh
          illustration: {
            source: 'agent',
            runId: FIX.run1,
            generatedAt: '2026-07-01T02:00:00Z',
            sourceHash: sec1ContentHash,
            sourceWordCount: sec1WordCount,
            entities: [FIX.mara],
            prompt: 'lighthouse at dusk, fog over the harbor',
            workflow: 'default',
            workflowHash: 'xxh64:0000000000000000',
            seed: 7,
            attempts: 1,
            score: 8,
            guidance: null,
          },
        },
      },
      null,
      2,
    ),
  )
  await fsp.writeFile(path.join(sec1Dir, 'summary-short.md'), 'Keeper watches the harbor.\n')
  await fsp.writeFile(path.join(sec1Dir, 'summary-long.md'), 'A longer summary of chapter one.\n')
  await fsp.writeFile(path.join(sec1Dir, 'illustration.png'), makePng(640, 480))
  await fsp.writeFile(
    path.join(sec1Dir, 'history.jsonl'),
    `${JSON.stringify({
      type: 'consolidated',
      snippetId: FIX.consumed,
      orderKey: 'z0',
      authorship: 'mixed',
      originRunId: FIX.run1,
      finalRev: 3,
      finalText: 'Consumed snippet text.',
      revisionRunIds: [FIX.run1],
      consolidatedAt: '2026-07-01T00:00:00Z',
      boundaryRunId: null,
    })}\n`,
  )

  await fsp.writeFile(path.join(sec2Dir, 'content.md'), SEC2_CONTENT)
  await fsp.writeFile(
    path.join(sec2Dir, 'section.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        id: FIX.sec2,
        kind: 'chapter',
        orderKey: 'a1',
        title: 'The Storm Glass',
        titleSource: 'user',
        frozenAt: '2026-07-05T00:00:00Z',
        contentHash: sec2ContentHash,
        enrichments: {
          shortSummary: null, // missing on a frozen leaf: stale
          longSummary: null, // missing on a frozen leaf: stale
          illustration: { suppressed: true, deletedAt: '2026-07-05T12:00:00Z' }, // never stale
        },
      },
      null,
      2,
    ),
  )
  await fsp.writeFile(path.join(sec2Dir, 'history.jsonl'), '')

  // -- frontier -----------------------------------------------------------------
  const snippetsDir = path.join(workDir, 'frontier', 'snippets')
  const revisionsDir = path.join(workDir, 'frontier', 'revisions')
  await fsp.writeFile(
    path.join(snippetsDir, SNIP1_FILE),
    snippetFileText(
      {
        id: FIX.snip1,
        orderKey: 'a0',
        createdAt: '2026-07-06T13:00:00Z',
        updatedAt: '2026-07-06T13:40:00Z',
        authorship: 'mixed',
        originRunId: FIX.run1,
        rev: 3,
      },
      SNIP1_BODY,
    ),
  )
  await fsp.writeFile(
    path.join(snippetsDir, SNIP2_FILE),
    snippetFileText(
      {
        id: FIX.snip2,
        orderKey: 'a1',
        createdAt: '2026-07-06T13:50:00Z',
        updatedAt: '2026-07-06T13:50:00Z',
        authorship: 'user',
        originRunId: null,
        rev: 1,
      },
      SNIP2_BODY,
    ),
  )
  await fsp.writeFile(
    path.join(snippetsDir, SNIP3_FILE),
    snippetFileText(
      {
        id: FIX.snip3,
        orderKey: 'a2',
        createdAt: '2026-07-06T14:02:11Z',
        updatedAt: '2026-07-06T14:02:11Z',
        authorship: 'agent',
        originRunId: FIX.run1,
        rev: 1,
      },
      SNIP3_BODY,
    ),
  )
  const revLine = (rev: number, author: 'user' | 'agent', text: string, runId?: string): string =>
    `${JSON.stringify({
      type: 'revision',
      rev,
      ts: '2026-07-06T13:00:00Z',
      author,
      ...(runId === undefined ? {} : { runId }),
      text,
    })}\n`
  await fsp.writeFile(
    path.join(revisionsDir, `${FIX.snip1}.jsonl`),
    revLine(1, 'agent', 'draft one', FIX.run1) +
      revLine(2, 'user', 'draft two') +
      revLine(3, 'user', SNIP1_BODY.trim()),
  )
  await fsp.writeFile(
    path.join(revisionsDir, `${FIX.snip2}.jsonl`),
    revLine(1, 'user', SNIP2_BODY.trim()),
  )
  await fsp.writeFile(
    path.join(revisionsDir, `${FIX.snip3}.jsonl`),
    revLine(1, 'agent', SNIP3_BODY.trim(), FIX.run1),
  )

  // -- world ---------------------------------------------------------------------
  await fsp.writeFile(
    path.join(workDir, 'world', 'entries', MARA_FILE),
    worldEntryFileText(
      {
        id: FIX.mara,
        name: 'Mara Voss',
        keys: ['Mara', 'Voss', 'the keeper'],
        image: `../images/${FIX.mara}.png`,
        shortSummary: 'Lighthouse keeper of Cinder Point.',
        createdBy: 'user',
        updatedAt: '2026-07-03T09:15:00Z',
      },
      'Mara Voss has kept the Cinder Point light for eleven years.\n',
    ),
  )
  await fsp.writeFile(
    path.join(workDir, 'world', 'entries', GLASS_FILE),
    worldEntryFileText(
      {
        id: FIX.glass,
        name: 'The Storm Glass',
        keys: [], // an entry with no keys is fully legitimate (§2.6)
        image: null,
        shortSummary: null,
        createdBy: 'agent',
        updatedAt: '2026-07-04T10:00:00Z',
      },
      'A sealed vial of seawater said to predict storms.\n',
    ),
  )
  await fsp.writeFile(path.join(workDir, 'world', 'images', `${FIX.mara}.png`), makePng(512, 512))
  await fsp.writeFile(
    path.join(workDir, 'world', 'images', `${FIX.mara}.json`),
    JSON.stringify(
      {
        source: 'agent',
        runId: FIX.run1,
        generatedAt: '2026-07-03T09:15:00Z',
        sourceHash: null,
        sourceWordCount: null,
        entities: [FIX.mara],
        prompt: 'portrait of a lighthouse keeper',
        workflow: 'default',
        workflowHash: 'xxh64:0000000000000000',
        seed: 3,
        attempts: 1,
        score: 7,
        guidance: null,
      },
      null,
      2,
    ),
  )

  // -- runs ------------------------------------------------------------------------
  const runsShard = path.join(workDir, 'runs', '2026-07')
  const jl = (value: unknown): string => `${JSON.stringify(value)}\n`
  await fsp.writeFile(
    path.join(runsShard, `${FIX.run1}.jsonl`),
    jl({
      type: 'meta',
      runId: FIX.run1,
      kind: 'continue',
      lane: 'high',
      model: 'glm-5',
      spec: { kind: 'continue' },
      params: { maxTokens: 2048 },
      contextSnapshot: null,
      startedAt: '2026-07-06T14:01:58Z',
    }) +
      jl({ type: 'message', role: 'user', text: '<local-context>…</local-context>' }) +
      jl({ type: 'output', text: SNIP3_BODY.trim() }) +
      jl({
        type: 'result',
        status: 'ok',
        usageTotal: { promptTokens: 6412, completionTokens: 388 },
        partialText: null,
        artifacts: [{ kind: 'snippet', snippetId: FIX.snip3, rev: 1, state: 'committed' }],
        endedAt: '2026-07-06T14:02:11Z',
      }),
  )
  // Crashed run: meta + streamed output, result line never arrived (§10.7).
  await fsp.writeFile(
    path.join(runsShard, `${FIX.run2}.jsonl`),
    jl({
      type: 'meta',
      runId: FIX.run2,
      kind: 'propose-boundaries',
      lane: 'low',
      model: 'glm-5',
      spec: { kind: 'propose-boundaries', eligibleSnippetIds: [FIX.snip1] },
      params: {},
      contextSnapshot: null,
      startedAt: '2026-07-06T14:10:00Z',
    }) + jl({ type: 'output', text: 'partial…' }),
  )

  return { workDir, sec1ContentHash, sec2ContentHash, sec1WordCount, situationHash }
}
