import fsp from 'node:fs/promises'
import path from 'node:path'
import {
  ConsolidatedSnippet,
  type ConsolidationSettings,
  RevisionEvent,
  SectionMeta,
  SnippetMeta,
} from '@cowrite/shared'
import { ulid } from 'ulid'
import { StorageError } from './errors.js'
import {
  clearPendingOp,
  type PendingOp,
  type PlannedSection,
  type PlannedSnippet,
  readPendingOp,
  writePendingOp,
} from './journal.js'
import { parseFrontmatter } from './lib/frontmatter.js'
import { ensureDir, readIfExists, readJsonl, writeFileAtomic } from './lib/fsx.js'
import { xxh64OfString } from './lib/hash.js'
import { nKeysBetween } from './lib/orderKeys.js'
import {
  frontierRevisionsDir,
  frontierSnippetsDir,
  parseSectionDirName,
  revisionLogPath,
  sectionDirName,
  sectionsDir,
  slugify,
  undoDir,
} from './lib/paths.js'
import { walkSectionTree, writeSectionMeta } from './sectionStore.js'
import type { SnippetFile } from './storageTypes.js'

/**
 * The consolidation engine (spec 02 §6): trigger evaluation with the eligible-prefix
 * guards (§6.2), the scene-break heuristic pre-pass (§6.3 rule 1), deferral back-off
 * (§6.3 rule 3), and the journaled two-phase apply / undo / recovery machinery (§6.4,
 * §9.2). Pure file-level mechanics — the StorageService phase owns the mutex, the
 * index updates, the events, and the grace timer; the harness owns the boundary agent
 * and cancels enrich/illustrate tasks by target BEFORE calling undo (§6.4).
 *
 * Every step of apply and undo is idempotent and keyed by `opId`, and calls the
 * injectable `kill` hook first — the crash-recovery property tests throw from it at
 * every step (including inside the move loop) and assert deterministic replay.
 */

// ---------------------------------------------------------------------------
// Trigger + eligible prefix (§6.2)
// ---------------------------------------------------------------------------

export interface EligiblePrefixGuards {
  /** Snippets targeted by queued/running tasks (supplied by the harness scheduler). */
  taskTargetIds: readonly string[]
  /** The editor-open snippet flagged via POST /works/:w/editing (03 §3.4). */
  editingSnippetId: string | null
}

/** ceil(configured × multiplier) — the deferral back-off's effective trigger values. */
export function effectiveThresholds(
  settings: ConsolidationSettings,
  multiplier: number,
): { maxFrontierSnippets: number; maxFrontierWords: number } {
  return {
    maxFrontierSnippets: Math.ceil(settings.maxFrontierSnippets * multiplier),
    maxFrontierWords: Math.ceil(settings.maxFrontierWords * multiplier),
  }
}

/**
 * The §6.2 active window: the trailing `activeWindowSnippets` snippets or the trailing
 * snippets summing to `activeWindowWords` words — whichever keeps MORE snippets (the
 * frontier the user is actually working in is never frozen out from under them).
 * Returns the number of trailing snippets excluded from consolidation.
 */
export function activeWindowSize(files: readonly SnippetFile[], s: ConsolidationSettings): number {
  let words = 0
  let byWords = 0
  for (let i = files.length - 1; i >= 0; i--) {
    if (words >= s.activeWindowWords) break
    words += files[i]?.wordCount ?? 0
    byWords++
  }
  return Math.min(files.length, Math.max(s.activeWindowSnippets, byWords))
}

/**
 * The eligible prefix (§6.2): the longest frontier prefix that excludes, from the tail
 * forward, the active window, every task-target snippet, and the editor-open snippet.
 * A guard hit inside the candidate prefix truncates it there — a prefix is contiguous
 * from the start, and consuming across a guarded snippet is never allowed.
 */
export function computeEligiblePrefix(
  files: readonly SnippetFile[],
  settings: ConsolidationSettings,
  guards: EligiblePrefixGuards,
): SnippetFile[] {
  let end = files.length - activeWindowSize(files, settings)
  if (end <= 0) return []
  const blocked = new Set<string>(guards.taskTargetIds)
  if (guards.editingSnippetId !== null) blocked.add(guards.editingSnippetId)
  for (let i = 0; i < end; i++) {
    if (blocked.has(files[i]?.meta.id ?? '')) {
      end = i
      break
    }
  }
  return files.slice(0, end)
}

// ---------------------------------------------------------------------------
// Heuristic pre-pass (§6.3 rule 1): scene-break lines split unconditionally
// ---------------------------------------------------------------------------

/** A `***` / `---` scene-break line (whitespace-tolerant: `* * *` counts too). */
export function isSceneBreakLine(line: string): boolean {
  const compact = line.replace(/\s+/g, '')
  return /^\*{3,}$/.test(compact) || /^-{3,}$/.test(compact)
}

function nonEmptyLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
}

/**
 * Boundaries implied by explicit break markers inside the eligible prefix, as
 * afterSnippetIds in frontier order. A snippet ENDING with a scene-break line breaks
 * after itself; a snippet STARTING with one breaks after its predecessor (markers are
 * preserved verbatim in the collapsed prose either way, §6.4). Mid-snippet markers are
 * ignored — a boundary can only sit between snippets (`afterSnippetId`), never inside
 * one.
 *
 * A snippet whose text is ONLY marker line(s) is glue, never a section of its own: it
 * attaches to the PRECEDING section (the boundary sits after the marker snippet, so the
 * marker rides that section's content tail) — or to the following section when nothing
 * with prose precedes it. Consecutive marker-only snippets collapse into ONE boundary
 * (after the last of the run). Emitting boundaries on both sides would mint a junk
 * section containing nothing but the marker — and a junk enrich task with it.
 */
export function heuristicBoundaryIds(prefix: readonly SnippetFile[]): string[] {
  const out: string[] = []
  const push = (id: string | undefined): void => {
    if (id !== undefined && !out.includes(id)) out.push(id)
  }
  const linesAt = (i: number): string[] => nonEmptyLines(prefix[i]?.text ?? '')
  const isMarkerOnly = (i: number): boolean => {
    const lines = linesAt(i)
    return lines.length > 0 && lines.every(isSceneBreakLine)
  }
  const hasProseBefore = (i: number): boolean => {
    for (let j = 0; j < i; j++) {
      if (linesAt(j).length > 0 && !isMarkerOnly(j)) return true
    }
    return false
  }
  for (let i = 0; i < prefix.length; i++) {
    const lines = linesAt(i)
    if (lines.length === 0) continue
    if (isMarkerOnly(i)) {
      // Glue: boundary AFTER the marker snippet — unless nothing with prose precedes
      // it (it then opens the following section), or the next snippet is marker-only
      // too (the run collapses onto its last member).
      if (hasProseBefore(i) && !(i + 1 < prefix.length && isMarkerOnly(i + 1))) {
        push(prefix[i]?.meta.id)
      }
      continue
    }
    const first = lines[0] ?? ''
    const last = lines[lines.length - 1] ?? ''
    if (i > 0 && isSceneBreakLine(first) && !isMarkerOnly(i - 1)) {
      push(prefix[i - 1]?.meta.id)
    }
    // A trailing marker breaks after this snippet — unless the NEXT snippet is
    // marker-only glue, which extends this section and carries the boundary itself.
    if (isSceneBreakLine(last) && !(i + 1 < prefix.length && isMarkerOnly(i + 1))) {
      push(prefix[i]?.meta.id)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Deferral back-off (§6.3 rule 3)
// ---------------------------------------------------------------------------

export const DEFERRAL_GROWTH = 1.5
export const DEFERRAL_CAP = 2
export const DEFERRAL_NOTICE_AFTER = 3
/** Default base for the temporal back-off when no debounce is supplied (schema default). */
export const DEFERRAL_BASE_MS = 30_000
/** Ceiling on the deferral not-before window (~30 min) — the spend-loop guard's cap. */
export const DEFERRAL_NOT_BEFORE_CAP_MS = 30 * 60_000

/**
 * In-memory only, never persisted into settings (§6.3): each deferral grows the
 * effective trigger thresholds ×1.5, capped at 2× the configured values; growth stops
 * after 3 consecutive deferrals and a log-only notice is due from then on (a WorkEvent
 * is deliberately NOT emitted — the client renders nothing in MVP). Reset on the next
 * successful consolidation.
 *
 * Deferrals also arm a TEMPORAL back-off against boundary-agent spend loops: after n
 * consecutive deferrals no new boundary run may start before `2^n × debounceMs`
 * (capped at ~30 min) has elapsed, AND not until the eligible prefix has GROWN past
 * its size at the last deferral — re-running the agent over the identical prefix that
 * just deferred only burns tokens to defer again.
 */
export class DeferralBackoff {
  private multiplier = 1
  private consecutive = 0
  /** Epoch ms before which no boundary run may start; 0 when idle. */
  private notBeforeMs = 0
  /** Eligible-prefix size (snippets) at the last deferral; null when idle. */
  private prefixSizeAtDeferral: number | null = null
  /** Prefix size at the last needs-boundaries evaluation (captured by recordDeferral). */
  private lastEvaluatedPrefixSize = 0

  constructor(private readonly now: () => number = Date.now) {}

  get thresholdMultiplier(): number {
    return this.multiplier
  }

  get consecutiveDeferrals(): number {
    return this.consecutive
  }

  /** Remember the prefix a boundary run would cover (called on needs-boundaries). */
  noteEligiblePrefix(size: number): void {
    this.lastEvaluatedPrefixSize = size
  }

  /** Record one deferral; `noticeDue` is true from the 3rd consecutive deferral on. */
  recordDeferral(debounceMs: number = DEFERRAL_BASE_MS): { noticeDue: boolean } {
    this.consecutive++
    if (this.consecutive <= DEFERRAL_NOTICE_AFTER) {
      this.multiplier = Math.min(this.multiplier * DEFERRAL_GROWTH, DEFERRAL_CAP)
    }
    this.notBeforeMs =
      this.now() + Math.min(2 ** this.consecutive * debounceMs, DEFERRAL_NOT_BEFORE_CAP_MS)
    this.prefixSizeAtDeferral = this.lastEvaluatedPrefixSize
    return { noticeDue: this.consecutive >= DEFERRAL_NOTICE_AFTER }
  }

  /**
   * true when a NEW boundary run must not start yet (§6.3 spend guard): inside the
   * not-before window, or the eligible prefix has not grown since the last deferral.
   * Never blocks when no deferral is on record; `force` paths bypass this entirely.
   */
  blocksBoundaryRun(prefixSize: number): boolean {
    if (this.consecutive === 0) return false
    if (this.now() < this.notBeforeMs) return true
    return this.prefixSizeAtDeferral !== null && prefixSize <= this.prefixSizeAtDeferral
  }

  reset(): void {
    this.multiplier = 1
    this.consecutive = 0
    this.notBeforeMs = 0
    this.prefixSizeAtDeferral = null
    this.lastEvaluatedPrefixSize = 0
  }
}

// ---------------------------------------------------------------------------
// Planning (§6.4 step 1)
// ---------------------------------------------------------------------------

/** A validated boundary: after this snippet, cut a section of the given kind/title.
 *  `title: null` on the heuristic path — the enrichment agent names the section later. */
export interface PlannedBoundary {
  afterSnippetId: string
  kind: string
  title: string | null
}

export interface OpHooks {
  /** Crash-injection hook: called before each step; tests throw from it (§12). */
  kill?: (point: string) => void | Promise<void>
  /** Clock injection for deterministic replay tests; defaults to wall time. */
  now?: () => string
}

const noKill = (): void => {}

/**
 * Build the journal record for one consolidation (§6.4 step 1): section ids, dir names
 * (numeric prefix continues the existing root sections), root-level orderKeys after the
 * last existing root section, consumed snippets in frontier order with their plan-time
 * content hashes. Pure computation plus reads — nothing is written yet.
 */
export async function planConsolidation(
  workDirPath: string,
  files: readonly SnippetFile[],
  boundaries: readonly PlannedBoundary[],
  opts: { boundaryRunId: string | null; now?: () => string },
): Promise<PendingOp> {
  const at = new Map(files.map((f, i) => [f.meta.id, i]))
  const ordered = boundaries
    .map((b) => ({ ...b, at: at.get(b.afterSnippetId) }))
    .filter((b): b is PlannedBoundary & { at: number } => b.at !== undefined)
    .sort((a, b) => a.at - b.at)
    // duplicate afterSnippetIds collapse to one boundary (first spelling wins)
    .filter((b, i, all) => i === 0 || b.at !== all[i - 1]?.at)
  if (ordered.length === 0) {
    throw new StorageError('planConsolidation: no boundary maps to a frontier snippet', 'invalid', {
      kind: 'work',
    })
  }

  // New sections are appended at the ROOT level after the last existing root section
  // (M1 splits are single-level; multi-level proposals are deferred, §13).
  const roots = (await walkSectionTree(workDirPath)).filter((n) => n.depth === 0)
  const lastKey = roots[roots.length - 1]?.meta.orderKey ?? null
  const orderKeys = nKeysBetween(lastKey, null, ordered.length)

  let maxPrefix = 0
  try {
    for (const name of await fsp.readdir(sectionsDir(workDirPath))) {
      const parsed = parseSectionDirName(name)
      if (parsed && parsed.prefix > maxPrefix) maxPrefix = parsed.prefix
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  let prefix = (Math.floor(maxPrefix / 10) + 1) * 10

  const sections: PlannedSection[] = []
  let start = 0
  for (let i = 0; i < ordered.length; i++) {
    const boundary = ordered[i]
    if (boundary === undefined) continue
    const group = files.slice(start, boundary.at + 1)
    start = boundary.at + 1
    const sectionId = ulid()
    const snippets: PlannedSnippet[] = []
    for (const f of group) {
      snippets.push({
        snippetId: f.meta.id,
        fileName: f.fileName,
        orderKey: f.meta.orderKey,
        planContentHash: await xxh64OfString(f.text),
      })
    }
    sections.push({
      sectionId,
      dirName: sectionDirName(prefix, slugify(boundary.title ?? boundary.kind), sectionId),
      kind: boundary.kind,
      title: boundary.title,
      orderKey: orderKeys[i] ?? '',
      snippets,
    })
    prefix += 10
  }

  return {
    schemaVersion: 1,
    type: 'consolidation',
    opId: ulid(),
    phase: 'planned',
    boundaryRunId: opts.boundaryRunId,
    createdAt: (opts.now ?? (() => new Date().toISOString()))(),
    expiresAt: null,
    sections,
  }
}

// ---------------------------------------------------------------------------
// Apply (§6.4 steps 2–3) — idempotent, resumable from a 'planned' journal
// ---------------------------------------------------------------------------

interface ResolvedSnippet {
  planned: PlannedSnippet
  meta: {
    id: string
    rev: number
    authorship: 'user' | 'agent' | 'mixed'
    originRunId: string | null
  }
  text: string
}

function stagedSnippetPath(workDirPath: string, opId: string, fileName: string): string {
  return path.join(undoDir(workDirPath, opId), 'snippets', fileName)
}

function stagedRevisionPath(workDirPath: string, opId: string, snippetId: string): string {
  return path.join(undoDir(workDirPath, opId), 'revisions', `${snippetId}.jsonl`)
}

/** Parse a snippet file iff it is valid and carries `snippetId`; null otherwise. */
async function tryParseSnippet(
  fileAbs: string,
  snippetId: string,
): Promise<{ meta: ResolvedSnippet['meta']; text: string } | null> {
  const raw = await readIfExists(fileAbs)
  if (raw === null) return null
  const parsed = parseFrontmatter(raw)
  if (!parsed.hadFrontmatter) return null
  const meta = SnippetMeta.safeParse(parsed.data)
  if (!meta.success || meta.data.id !== snippetId) return null
  return {
    meta: {
      id: meta.data.id,
      rev: meta.data.rev,
      authorship: meta.data.authorship,
      originRunId: meta.data.originRunId,
    },
    text: parsed.body,
  }
}

/**
 * Re-read one consumed snippet at apply time (§6.4 step 2): the frontier copy wins —
 * a mid-flight edit is folded in, never lost — falling back to the staged copy on
 * replay after a crash inside the move loop. Null when the file exists nowhere
 * (externally deleted while the server was down): the snippet is skipped rather than
 * invented.
 */
async function resolveSnippet(
  workDirPath: string,
  opId: string,
  planned: PlannedSnippet,
): Promise<ResolvedSnippet | null> {
  const frontier = path.join(frontierSnippetsDir(workDirPath), planned.fileName)
  const fromFrontier = await tryParseSnippet(frontier, planned.snippetId)
  if (fromFrontier !== null) return { planned, ...fromFrontier }
  // renamed externally? scan the frontier for the id before falling back to staging
  let names: string[] = []
  try {
    names = await fsp.readdir(frontierSnippetsDir(workDirPath))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  for (const name of names) {
    if (name === planned.fileName) continue
    const hit = await tryParseSnippet(
      path.join(frontierSnippetsDir(workDirPath), name),
      planned.snippetId,
    )
    if (hit !== null) return { planned: { ...planned, fileName: name }, ...hit }
  }
  const staged = await tryParseSnippet(
    stagedSnippetPath(workDirPath, opId, planned.fileName),
    planned.snippetId,
  )
  if (staged !== null) return { planned, ...staged }
  return null
}

/** Distinct agent runIds that ever touched the snippet, oldest first (§6.4 provenance). */
async function collectRevisionRunIds(
  workDirPath: string,
  opId: string,
  snippetId: string,
): Promise<string[]> {
  const frontierLog = revisionLogPath(workDirPath, snippetId)
  let { lines } = await readJsonl(frontierLog)
  if (lines.length === 0) {
    ;({ lines } = await readJsonl(stagedRevisionPath(workDirPath, opId, snippetId)))
  }
  const runIds: string[] = []
  for (const line of lines) {
    const parsed = RevisionEvent.safeParse(line)
    if (parsed.success && parsed.data.runId !== undefined && !runIds.includes(parsed.data.runId)) {
      runIds.push(parsed.data.runId)
    }
  }
  return runIds
}

/** Rename that tolerates a pre-existing target (retried replay): target is replaced. */
async function moveFile(src: string, dest: string): Promise<void> {
  try {
    await fsp.rename(src, dest)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EEXIST' || code === 'EPERM' || code === 'ENOTEMPTY' || code === 'EACCES') {
      // Windows rename cannot replace an existing file
      await fsp.rm(dest, { force: true })
      await fsp.rename(src, dest)
      return
    }
    throw err
  }
}

/** The §6.4 join rule: final snippet texts in order, blank-line separated, one final \n. */
export function joinSnippetTexts(texts: readonly string[]): string {
  return `${texts.map((t) => t.replace(/[\r\n]+$/, '')).join('\n\n')}\n`
}

/**
 * Execute a planned op (§6.4 steps 2–3): create section dirs + section.json +
 * history.jsonl + content.md (content.md LAST — its presence is the "this section is
 * complete" marker recovery keys on), then MOVE the consumed snippet + revision files
 * into `.cowrite/undo/<opId>/`, then flip the journal to 'applied' with the grace
 * deadline. Idempotent throughout: a section whose content.md already exists is
 * skipped wholesale (the section wins, §9.2), already-moved files are skipped, and the
 * journal write is an atomic replace. The caller holds the work mutex and has already
 * written the 'planned' journal.
 */
export async function applyPlannedOp(
  workDirPath: string,
  op: PendingOp,
  undoGraceMs: number,
  hooks: OpHooks = {},
): Promise<PendingOp> {
  const kill = hooks.kill ?? noKill
  const now = hooks.now ?? (() => new Date().toISOString())

  // -- step 2: create sections (content.md written last per section) ----------
  for (let i = 0; i < op.sections.length; i++) {
    const section = op.sections[i]
    if (section === undefined) continue
    const dirAbs = path.join(sectionsDir(workDirPath), section.dirName)
    const contentAbs = path.join(dirAbs, 'content.md')
    if ((await readIfExists(contentAbs)) !== null) continue // replay: section complete
    await kill(`create-dir:${i}`)
    await ensureDir(dirAbs)

    const resolved: ResolvedSnippet[] = []
    for (const planned of section.snippets) {
      const hit = await resolveSnippet(workDirPath, op.opId, planned)
      if (hit !== null) resolved.push(hit)
    }
    const contentText = joinSnippetTexts(resolved.map((r) => r.text))
    const contentHash = await xxh64OfString(contentText)
    const consolidatedAt = now()

    await kill(`write-meta:${i}`)
    await writeSectionMeta(
      dirAbs,
      SectionMeta.parse({
        schemaVersion: 1,
        id: section.sectionId,
        kind: section.kind,
        orderKey: section.orderKey,
        title: section.title,
        titleSource: 'agent',
        frozenAt: consolidatedAt,
        contentHash,
        enrichments: {
          shortSummary: null,
          longSummary: null,
          // Stage 5 (docs/10): the illustration pipeline fills this slot; written null
          // here so the section is born with the three-state union's absent state.
          illustration: null,
        },
      }),
    )

    await kill(`write-history:${i}`)
    const lines: string[] = []
    for (const r of resolved) {
      lines.push(
        JSON.stringify(
          ConsolidatedSnippet.parse({
            type: 'consolidated',
            snippetId: r.meta.id,
            orderKey: r.planned.orderKey,
            authorship: r.meta.authorship,
            originRunId: r.meta.originRunId,
            finalRev: r.meta.rev,
            finalText: r.text,
            revisionRunIds: await collectRevisionRunIds(workDirPath, op.opId, r.meta.id),
            consolidatedAt,
            boundaryRunId: op.boundaryRunId,
          }),
        ),
      )
    }
    await writeFileAtomic(path.join(dirAbs, 'history.jsonl'), `${lines.join('\n')}\n`)

    await kill(`write-content:${i}`)
    await writeFileAtomic(contentAbs, contentText)
  }

  // -- step 3: stage — move consumed files to .cowrite/undo/<opId>/ ----------
  await kill('stage-dirs')
  await ensureDir(path.join(undoDir(workDirPath, op.opId), 'snippets'))
  await ensureDir(path.join(undoDir(workDirPath, op.opId), 'revisions'))
  for (const section of op.sections) {
    for (const planned of section.snippets) {
      const src = path.join(frontierSnippetsDir(workDirPath), planned.fileName)
      await kill(`move-snippet:${planned.snippetId}`)
      if ((await tryParseSnippet(src, planned.snippetId)) !== null) {
        await moveFile(src, stagedSnippetPath(workDirPath, op.opId, planned.fileName))
      }
      const revSrc = revisionLogPath(workDirPath, planned.snippetId)
      await kill(`move-revlog:${planned.snippetId}`)
      if ((await readIfExists(revSrc)) !== null) {
        await moveFile(revSrc, stagedRevisionPath(workDirPath, op.opId, planned.snippetId))
      }
    }
  }

  // -- journal → applied, grace deadline set ---------------------------------
  await kill('journal-applied')
  const applied: PendingOp = {
    ...op,
    phase: 'applied',
    expiresAt: new Date(Date.parse(now()) + undoGraceMs).toISOString(),
  }
  await writePendingOp(workDirPath, applied)
  return applied
}

/**
 * `applyPlannedOp` with the live-process failure story (§6.4): a THROWN apply attempts
 * an immediate rollback (reverse replay of whatever partial state exists) so no
 * 'planned' journal lingers to confuse a later apply; if the rollback itself fails
 * too, the journal is deliberately left in place for openWork's §9.2 replay. The
 * original apply error is rethrown either way.
 */
export async function applyPlannedOpWithRollback(
  workDirPath: string,
  op: PendingOp,
  undoGraceMs: number,
  hooks: OpHooks = {},
): Promise<PendingOp> {
  try {
    return await applyPlannedOp(workDirPath, op, undoGraceMs, hooks)
  } catch (err) {
    try {
      await undoAppliedOp(workDirPath, op)
    } catch {
      // rollback failed as well: keep the journal — the next open rolls forward (§9.2)
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// Undo (§6.4) — reverse replay while the journal is at 'applied'
// ---------------------------------------------------------------------------

/**
 * Reverse-replay an applied op: move the staged files back into frontier/, then delete
 * the created section dirs, then delete the staging dir and the journal. Restore runs
 * FIRST and deletion second, so a crash anywhere leaves a deterministic recovery: all
 * content.md present ⇒ recovery re-stages the restored copies and resumes the grace
 * (the section wins, §9.2); any content.md missing ⇒ deletion had begun, so every
 * snippet is already back in frontier/ and recovery completes the undo.
 *
 * The HARNESS must cancel queued/running enrich-section / illustrate-section tasks
 * targeting these sections BEFORE this call (05 §6.2 cancelByTarget) — storage never
 * calls the harness.
 */
export async function undoAppliedOp(
  workDirPath: string,
  op: PendingOp,
  hooks: OpHooks = {},
): Promise<void> {
  const kill = hooks.kill ?? noKill
  await ensureDir(frontierSnippetsDir(workDirPath))
  await ensureDir(frontierRevisionsDir(workDirPath))
  for (const section of op.sections) {
    for (const planned of section.snippets) {
      const stagedSnippet = stagedSnippetPath(workDirPath, op.opId, planned.fileName)
      await kill(`restore-snippet:${planned.snippetId}`)
      if ((await readIfExists(stagedSnippet)) !== null) {
        await moveFile(stagedSnippet, path.join(frontierSnippetsDir(workDirPath), planned.fileName))
      }
      const stagedRev = stagedRevisionPath(workDirPath, op.opId, planned.snippetId)
      await kill(`restore-revlog:${planned.snippetId}`)
      if ((await readIfExists(stagedRev)) !== null) {
        await moveFile(stagedRev, revisionLogPath(workDirPath, planned.snippetId))
      }
    }
  }
  for (let i = 0; i < op.sections.length; i++) {
    const section = op.sections[i]
    if (section === undefined) continue
    await kill(`remove-section:${i}`)
    await fsp.rm(path.join(sectionsDir(workDirPath), section.dirName), {
      recursive: true,
      force: true,
    })
  }
  await kill('purge-staging')
  await fsp.rm(undoDir(workDirPath, op.opId), { recursive: true, force: true })
  await kill('journal-cleared')
  await clearPendingOp(workDirPath)
}

/** Grace expiry (§6.4 step 4): delete `.cowrite/undo/<opId>/`, delete the journal. */
export async function purgeAppliedOp(
  workDirPath: string,
  op: PendingOp,
  hooks: OpHooks = {},
): Promise<void> {
  const kill = hooks.kill ?? noKill
  await kill('purge-rm-staging')
  await fsp.rm(undoDir(workDirPath, op.opId), { recursive: true, force: true })
  // A crash HERE (staging gone, journal present) is recoverable: replay finds every
  // content.md present, re-stages nothing, and purges again once the deadline reads
  // expired — the §12 crash suite injects at both points.
  await kill('purge-clear-journal')
  await clearPendingOp(workDirPath)
}

// ---------------------------------------------------------------------------
// Recovery at work open (§9.2)
// ---------------------------------------------------------------------------

export type ReplayOutcome =
  /** journal at 'planned': rolled forward from step 2; grace window (re)starts now */
  | 'rolled-forward'
  /** journal at 'applied', sections intact: strays re-staged, grace timer resumes */
  | 'grace-resumed'
  /** journal at 'applied' but already past its deadline: staging + journal purged */
  | 'purged'
  /** a crashed undo (some section dirs already deleted): the undo was completed */
  | 'undo-completed'

export interface ReplayResult {
  op: PendingOp
  outcome: ReplayOutcome
}

/**
 * §9.2 recovery, run by openWork (writer only) BEFORE the index opens or rebuilds:
 *
 * - `planned` → roll forward from step 2 (idempotent, keyed by opId);
 * - `applied` with every section's content.md present → re-stage any snippet found in
 *   BOTH a section and frontier/ (crash inside a move loop: the section wins), then
 *   resume — or, past the deadline, purge — the grace window;
 * - `applied` with any content.md missing → a crashed undo's deletion phase; every
 *   snippet is already restored, so the undo is completed deterministically.
 *
 * Returns null when there is no journal (the idle state).
 */
export async function replayPendingOp(
  workDirPath: string,
  undoGraceMs: number,
  hooks: OpHooks = {},
): Promise<ReplayResult | null> {
  const op = await readPendingOp(workDirPath)
  if (op === null) return null
  const now = hooks.now ?? (() => new Date().toISOString())

  if (op.phase === 'planned') {
    const applied = await applyPlannedOp(workDirPath, op, undoGraceMs, hooks)
    return { op: applied, outcome: 'rolled-forward' }
  }

  let allSectionsComplete = true
  for (const section of op.sections) {
    const contentAbs = path.join(sectionsDir(workDirPath), section.dirName, 'content.md')
    if ((await readIfExists(contentAbs)) === null) {
      allSectionsComplete = false
      break
    }
  }
  if (!allSectionsComplete) {
    await undoAppliedOp(workDirPath, op, hooks)
    return { op, outcome: 'undo-completed' }
  }

  // §9.2: a snippet found in both a new section (content.md) and frontier/ — the
  // section wins; the frontier copy matching the journal's snippetIds is re-staged.
  // kill() hooks cover every step: a SECOND crash during this recovery must itself
  // replay to convergence (the §12 crash suite injects here too).
  const kill = hooks.kill ?? noKill
  await ensureDir(path.join(undoDir(workDirPath, op.opId), 'snippets'))
  await ensureDir(path.join(undoDir(workDirPath, op.opId), 'revisions'))
  for (const section of op.sections) {
    for (const planned of section.snippets) {
      const src = path.join(frontierSnippetsDir(workDirPath), planned.fileName)
      await kill(`restage-snippet:${planned.snippetId}`)
      if ((await tryParseSnippet(src, planned.snippetId)) !== null) {
        await moveFile(src, stagedSnippetPath(workDirPath, op.opId, planned.fileName))
      }
      const revSrc = revisionLogPath(workDirPath, planned.snippetId)
      const stagedSnippet = stagedSnippetPath(workDirPath, op.opId, planned.fileName)
      await kill(`restage-revlog:${planned.snippetId}`)
      if ((await readIfExists(revSrc)) !== null && (await readIfExists(stagedSnippet)) !== null) {
        await moveFile(revSrc, stagedRevisionPath(workDirPath, op.opId, planned.snippetId))
      }
    }
  }

  if (op.expiresAt !== null && Date.parse(op.expiresAt) <= Date.parse(now())) {
    await purgeAppliedOp(workDirPath, op, hooks)
    return { op, outcome: 'purged' }
  }
  return { op, outcome: 'grace-resumed' }
}

// re-export for the service phase's typed results
export type { PendingOp } from './journal.js'
