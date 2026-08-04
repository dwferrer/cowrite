import fsp from 'node:fs/promises'
import path from 'node:path'
import { WorkSettings } from '@cowrite/shared'

/**
 * The ONE Stage-4 test fixture kit: canned mock-llm blocks, scene prose, consolidation
 * settings builders, and the byte-level frontier snapshot — shared by the harness
 * pipeline suites, the Stage-4 CLI suite, and the storage consolidation service suite.
 * Deliberately light on imports (node builtins + @cowrite/shared only) so storage tests
 * can use it without dragging in the Fastify/mock-llm harness stack.
 */

/** A complete, valid enrich-section response: title + both summaries. */
export const ENRICH_OK =
  '<title>\nThe Storm Cellar\n</title>\n' +
  '<summary-short>\nThe cellar floods; the pair shelter.\n</summary-short>\n' +
  '<summary-long>\nThe storm drives them below; the water rises past the third step.\n</summary-long>'

/** ~40 words of scene prose (no ---/*** lines — the heuristic pre-pass must stay cold). */
export const PAGE =
  'The storm pressed the town flat while the two of them worked the pump in turns, ' +
  'counting strokes out loud, trading the handle at fifty, listening to the cellar fill ' +
  'anyway, patient and dark and certain as the tide coming home.'

/**
 * The canonical Stage-4 test consolidation block (fast debounce, tiny active window,
 * long undo grace). PATCH /works/:w replaces the whole settings object (schema defaults
 * refill omitted fields), so tests spell out the full block via `consolidation()`.
 */
export interface Stage4Consolidation {
  maxFrontierSnippets: number
  maxFrontierWords: number
  activeWindowSnippets: number
  activeWindowWords: number
  debounceMs: number
  undoGraceMs: number
}

export const STAGE4_CONSOLIDATION: Stage4Consolidation = {
  maxFrontierSnippets: 20,
  maxFrontierWords: 50_000,
  activeWindowSnippets: 2,
  activeWindowWords: 10,
  debounceMs: 150,
  undoGraceMs: 60_000,
}

/** The canonical block with overrides — the one spelling of a test settings block. */
export function consolidation(overrides: Partial<Stage4Consolidation> = {}): Stage4Consolidation {
  return { ...STAGE4_CONSOLIDATION, ...overrides }
}

/** Full parsed WorkSettings with a partial consolidation block (schema defaults fill). */
export function settingsWith(overrides: object): WorkSettings {
  return WorkSettings.parse({ consolidation: overrides })
}

/** `<boundaries>` block for a list of `[afterSnippetId, title]` chapter cuts. */
export function boundariesJson(cuts: Array<[string, string]>): string {
  const boundaries = cuts.map(([afterSnippetId, title]) => ({
    afterSnippetId,
    kind: 'chapter',
    title,
  }))
  return `<boundaries>\n${JSON.stringify({ boundaries })}\n</boundaries>`
}

/** One-cut convenience spelling of `boundariesJson`. */
export function boundaryJson(afterSnippetId: string, title: string): string {
  return boundariesJson([[afterSnippetId, title]])
}

/** Non-undefined indexing for noUncheckedIndexedAccess test code. */
export function at<T>(items: readonly T[], i: number): T {
  const item = items[i]
  if (item === undefined) throw new Error(`no item at index ${i}`)
  return item
}

/** Every file under frontier/ as rel path → bytes (the §6.4 byte-identical undo check).
 *  Missing subdirectories read as empty. */
export async function frontierSnapshot(workDir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const sub of ['snippets', 'revisions']) {
    const dir = path.join(workDir, 'frontier', sub)
    let names: string[] = []
    try {
      names = await fsp.readdir(dir)
    } catch {
      continue
    }
    for (const name of names.sort()) {
      out.set(`${sub}/${name}`, await fsp.readFile(path.join(dir, name), 'utf8'))
    }
  }
  return out
}
