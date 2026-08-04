import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import {
  type CliRuntime,
  type CliTaskRequest,
  contextPreviewCommand,
  contextStateCommand,
  createCliRuntime,
  promptRenderCommand,
  runsListCommand,
  runsShowCommand,
  runTaskCommand,
} from './cliAgents.js'
import type { SectionRow, SnippetRow } from './storage/index/db.js'
import { wordCount } from './storage/lib/hash.js'
import { shortId } from './storage/lib/paths.js'
import { createStorage, type WorkHandle } from './storage/service.js'

/**
 * The dev CLI (docs/10 §Stage 1 dev-CLI note): Stage-1 storage commands (spec 02 §11)
 * plus the Stage-3 agent commands (cliAgents.ts — same harness/engine code paths as the
 * HTTP layer). Plain console output, no argument-parsing dependency — a ~40-line
 * positional/flag splitter below is all a demo tool needs. Data dir comes from
 * COWRITE_DATA_DIR (default ~/.cowrite/data, §5.2); model lanes come from
 * ~/.cowrite/config.jsonc, or run modelless with COWRITE_MOCK_LLM=1 (docs/09 §2.3).
 */

const USAGE = `cowrite dev CLI (data dir: COWRITE_DATA_DIR, default ~/.cowrite/data)

storage:
  works list                              list all works
  works create <title>                    create a work
  work info <slug>                        sections tree + frontier + staleness badges
  snippet append <slug> [--author user]   append a snippet; text read from stdin
  snippet list <slug>                     list frontier snippets
  snippet revisions <slug> <snippetId>    print a snippet's revision log
  situation get <slug>                    print situation.md
  situation set <slug>                    replace the situation; text read from stdin
  world list <slug>                       list world entries
  search <slug> <query>                   full-text search (FTS5)
  reconcile <slug>                        adopt/refresh external edits
  rebuild <slug>                          full index rebuild from files

agents (model lanes from ~/.cowrite/config.jsonc; COWRITE_MOCK_LLM=1 runs modelless):
  continue <slug> [--cancel-after <ms>]   run a continue task; deltas stream to stdout
  instruct <slug> <instruction...>        instructed continue (same flags as continue)
  quick-edit <slug> <snippetId> <instruction...>
                                          rewrite one snippet; prints before/after words
  prompt render <slug> [--kind continue|instructed-continue|quick-edit]
                [--target <snippetId>] [--instruction <text>] [--json]
                                          print the exact assembled prompt — NO model call
                                          (--json prints the ContextSnapshot instead)
  context preview <slug>                  region/item table: fidelity, tokens, budgets
  context state <slug>                    the elevation ledger + anchors
  runs list <slug>                        run summaries from the run files
  runs show <slug> <runId> [--full]       one run's transcript (--full prints messages)`

interface Args {
  positionals: string[]
  flags: Record<string, string | true>
}

/** Split argv into positionals and `--flag[=| ]value` flags (bare `--flag` → true).
 *  Exported for tests. */
export function parseArgs(argv: string[]): Args {
  const positionals: string[] = []
  const flags: Record<string, string | true> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === undefined) continue
    if (!arg.startsWith('--')) {
      positionals.push(arg)
      continue
    }
    const eq = arg.indexOf('=')
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1)
    } else {
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        flags[arg.slice(2)] = next
        i++
      } else {
        flags[arg.slice(2)] = true
      }
    }
  }
  return { positionals, flags }
}

/**
 * Print and exit(1). NEVER call this inside a withWork callback: process.exit skips the
 * finally that closes the handle (lock release, db close) — throw instead and let
 * main().catch print and exit after the handle is closed.
 */
function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

/** `works create <word…>`: the title is everything after the subcommand, joined —
 *  multi-word titles need no shell quoting (same as `search`). Exported for tests. */
export function titleFromPositionals(positionals: string[]): string | null {
  const title = positionals.slice(2).join(' ').trim()
  return title === '' ? null : title
}

// PowerShell 5.1 pipes stdin with a UTF-8 BOM; it must not become story text.
export function stripBom(text: string): string {
  return text.replace(/^﻿/, '')
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return stripBom(Buffer.concat(chunks).toString('utf8'))
}

function staleBadges(row: SectionRow): string {
  const badges: string[] = []
  if (row.shortSummaryStale) badges.push('short-summary stale')
  if (row.longSummaryStale) badges.push('long-summary stale')
  if (row.illustrationStale) badges.push('illustration stale')
  return badges.length > 0 ? `  [${badges.join(', ')}]` : ''
}

function printSectionTree(rows: SectionRow[]): void {
  const byParent = new Map<string | null, SectionRow[]>()
  for (const row of rows) {
    const siblings = byParent.get(row.parentId) ?? []
    siblings.push(row)
    byParent.set(row.parentId, siblings)
  }
  const printLevel = (parentId: string | null, depth: number): void => {
    for (const row of byParent.get(parentId) ?? []) {
      const indent = '  '.repeat(depth + 1)
      const title = row.title ?? '(untitled)'
      console.log(
        `${indent}${row.kind} "${title}"  #${shortId(row.id)}  ${row.wordCount}w${staleBadges(row)}`,
      )
      printLevel(row.id, depth + 1)
    }
  }
  printLevel(null, 0)
}

function snippetLine(row: SnippetRow): string {
  const origin = row.originRunId === null ? '' : `  run ${shortId(row.originRunId)}`
  return `  ${row.orderKey.padEnd(6)} ${row.id}  ${row.authorship.padEnd(5)} rev ${row.rev} (${row.revisionCount} ev)  ${row.wordCount}w${origin}`
}

async function withWork<T>(
  dataDir: string,
  slug: string,
  fn: (handle: WorkHandle) => Promise<T>,
): Promise<T> {
  const handle = await createStorage(dataDir).openWork(slug)
  try {
    return await fn(handle)
  } finally {
    await handle.close()
  }
}

async function cmdWorks(dataDir: string, args: Args): Promise<void> {
  const [, sub] = args.positionals
  if (sub === 'list') {
    const works = await createStorage(dataDir).listWorks()
    if (works.length === 0) {
      console.log(`no works in ${dataDir}`)
      return
    }
    for (const w of works) {
      if (w.ok) console.log(`${w.slug.padEnd(28)} "${w.meta.title}"  ${w.meta.id}`)
      else console.log(`${w.slug.padEnd(28)} [broken: ${w.warning}]`)
    }
    return
  }
  if (sub === 'create') {
    const title = titleFromPositionals(args.positionals)
    if (title === null) fail('usage: works create <title>')
    const created = await createStorage(dataDir).createWork(title)
    console.log(`created "${created.meta.title}" → ${created.slug} (${created.meta.id})`)
    return
  }
  fail(USAGE)
}

async function cmdWorkInfo(dataDir: string, slug: string): Promise<void> {
  await withWork(dataDir, slug, async (handle) => {
    const { work } = handle
    console.log(`${work.title}  (${slug}, id ${work.id})`)
    console.log(`level scheme: ${work.levelScheme.join(' > ')}`)

    const situation = await handle.getSituation()
    console.log(`situation: ${wordCount(situation.text)}w, updated ${situation.updatedAt}`)

    const sectionRows = handle.listSections()
    console.log(`\nsections (${sectionRows.length}):`)
    if (sectionRows.length === 0) console.log('  (none frozen yet)')
    else printSectionTree(sectionRows)

    const snippetRows = handle.listSnippets()
    const frontierWords = snippetRows.reduce((sum, row) => sum + row.wordCount, 0)
    console.log(`\nfrontier (${snippetRows.length} snippets, ${frontierWords}w):`)
    for (const row of snippetRows) console.log(snippetLine(row))
  })
}

async function cmdSnippet(dataDir: string, args: Args): Promise<void> {
  const [, sub, slug, snippetId] = args.positionals
  if (slug === undefined) fail(USAGE)
  if (sub === 'append') {
    const author = args.flags.author ?? 'user'
    if (author !== 'user' && author !== 'agent') fail('--author must be user or agent')
    const text = await readStdin()
    if (text.trim() === '') fail('snippet append: no text on stdin')
    await withWork(dataDir, slug, async (handle) => {
      const runId = args.flags.run
      const meta = await handle.appendSnippet(text, {
        author,
        ...(typeof runId === 'string' ? { runId } : {}),
      })
      console.log(`appended snippet ${meta.id} (orderKey ${meta.orderKey}, rev ${meta.rev})`)
    })
    return
  }
  if (sub === 'list') {
    await withWork(dataDir, slug, async (handle) => {
      const rows = handle.listSnippets()
      console.log(`${rows.length} snippet(s):`)
      for (const row of rows) console.log(snippetLine(row))
    })
    return
  }
  if (sub === 'revisions') {
    if (snippetId === undefined) fail('usage: snippet revisions <slug> <snippetId>')
    await withWork(dataDir, slug, async (handle) => {
      for (const ev of await handle.getRevisions(snippetId)) {
        const run = ev.runId === undefined ? '' : `  run ${ev.runId}`
        const preview = ev.text.replaceAll('\n', ' ').slice(0, 60)
        console.log(`rev ${ev.rev}  ${ev.ts}  ${ev.author}${run}  "${preview}"`)
      }
    })
    return
  }
  fail(USAGE)
}

async function cmdSituation(dataDir: string, args: Args): Promise<void> {
  const [, sub, slug] = args.positionals
  if (slug === undefined) fail(USAGE)
  if (sub === 'get') {
    await withWork(dataDir, slug, async (handle) => {
      const dto = await handle.getSituation()
      process.stdout.write(dto.text === '' ? '(empty situation)\n' : dto.text)
    })
    return
  }
  if (sub === 'set') {
    const text = await readStdin()
    await withWork(dataDir, slug, async (handle) => {
      const current = await handle.getSituation()
      const res = await handle.putSituation(text, { baseHash: current.hash })
      if (res.ok) console.log(`situation updated (${wordCount(text)}w) at ${res.updatedAt}`)
      // throw, don't fail(): the handle must close (finally) before main() exits
      else throw new Error(`conflict: situation changed at ${res.conflict.updatedAt}; retry`)
    })
    return
  }
  fail(USAGE)
}

async function cmdWorldList(dataDir: string, slug: string): Promise<void> {
  await withWork(dataDir, slug, async (handle) => {
    const entries = await handle.listWorldEntries()
    console.log(`${entries.length} world entr${entries.length === 1 ? 'y' : 'ies'}:`)
    for (const entry of entries) {
      const keys = entry.meta.keys.length > 0 ? `  keys: [${entry.meta.keys.join(', ')}]` : ''
      const summary = entry.meta.shortSummary === null ? '' : `  — ${entry.meta.shortSummary}`
      console.log(`  ${entry.meta.name}  #${shortId(entry.meta.id)}${keys}${summary}`)
    }
  })
}

async function cmdSearch(dataDir: string, slug: string, query: string): Promise<void> {
  await withWork(dataDir, slug, async (handle) => {
    const hits = handle.search(query)
    console.log(`${hits.length} hit(s) for "${query}":`)
    for (const hit of hits) {
      const title = hit.title === null ? '' : ` "${hit.title}"`
      console.log(`  [${hit.kind}] ${hit.entityId}${title}: ${hit.snippet}`)
    }
  })
}

async function cmdReconcile(dataDir: string, slug: string): Promise<void> {
  await withWork(dataDir, slug, async (handle) => {
    const report = await handle.reconcile()
    console.log(
      `reconciled: ${report.changed.length} changed, ${report.adopted.length} adopted, ` +
        `${report.removed.length} removed, ${report.unrecognized.length} unrecognized, ` +
        `${report.renumbered} renumbered`,
    )
    for (const e of report.changed) console.log(`  changed  ${e.kind} ${e.id}  ${e.path}`)
    for (const e of report.adopted) console.log(`  adopted  ${e.kind} ${e.id}  ${e.path}`)
    for (const e of report.removed) console.log(`  removed  ${e.kind} ${e.id}  ${e.path}`)
    for (const p of report.unrecognized) console.log(`  unrecognized  ${p}`)
  })
}

async function cmdRebuild(dataDir: string, slug: string): Promise<void> {
  await withWork(dataDir, slug, async (handle) => {
    await handle.rebuildIndex()
    console.log(
      `index rebuilt: ${handle.listSections().length} sections, ` +
        `${handle.listSnippets().length} snippets`,
    )
  })
}

// ---------------------------------------------------------------------------
// Stage-3 agent commands (cliAgents.ts does the work; these adapt argv + stdout).
// ---------------------------------------------------------------------------

const stdoutWrite = (text: string): void => {
  process.stdout.write(text)
}

async function withRuntime<T>(dataDir: string, fn: (rt: CliRuntime) => Promise<T>): Promise<T> {
  const rt = await createCliRuntime({ dataDir })
  try {
    return await fn(rt)
  } finally {
    await rt.close()
  }
}

/** `continue <slug>` / `instruct <slug> <instruction…>` / `quick-edit <slug> <id> <instruction…>`. */
async function cmdAgentTask(dataDir: string, args: Args): Promise<void> {
  const [cmd, slug] = args.positionals
  if (slug === undefined) fail(USAGE)
  let request: CliTaskRequest
  if (cmd === 'continue') {
    request = { kind: 'continue' }
  } else if (cmd === 'instruct') {
    const instruction = args.positionals.slice(2).join(' ').trim()
    if (instruction === '') fail('usage: instruct <slug> <instruction...>')
    request = { kind: 'instructed-continue', instruction }
  } else {
    const snippetId = args.positionals[2]
    const instruction = args.positionals.slice(3).join(' ').trim()
    if (snippetId === undefined || instruction === '') {
      fail('usage: quick-edit <slug> <snippetId> <instruction...>')
    }
    request = { kind: 'quick-edit', snippetId, instruction }
  }

  const cancelRaw = args.flags['cancel-after']
  const cancelAfterMs = typeof cancelRaw === 'string' ? Number(cancelRaw) : undefined
  if (cancelAfterMs !== undefined && !(Number.isFinite(cancelAfterMs) && cancelAfterMs >= 0)) {
    fail('--cancel-after takes a millisecond count')
  }

  const result = await withRuntime(dataDir, (rt) =>
    runTaskCommand(rt, slug, request, {
      out: stdoutWrite,
      ...(cancelAfterMs === undefined ? {} : { cancelAfterMs }),
    }),
  )
  // The failure is already printed with its code/message; just exit non-zero.
  if (result.status === 'error') process.exitCode = 1
}

async function cmdPrompt(dataDir: string, args: Args): Promise<void> {
  const [, sub, slug] = args.positionals
  if (sub !== 'render' || slug === undefined) fail(USAGE)
  const RENDER_KINDS = ['continue', 'instructed-continue', 'quick-edit'] as const
  const kindRaw = args.flags.kind ?? 'continue'
  const kind = RENDER_KINDS.find((k) => k === kindRaw)
  if (kind === undefined) fail('--kind must be continue, instructed-continue, or quick-edit')
  const targetId = args.flags.target
  const instruction = args.flags.instruction
  await withRuntime(dataDir, (rt) =>
    promptRenderCommand(rt, slug, {
      kind,
      json: args.flags.json === true,
      out: stdoutWrite,
      ...(typeof targetId === 'string' ? { targetId } : {}),
      ...(typeof instruction === 'string' ? { instruction } : {}),
    }),
  )
}

async function cmdContext(dataDir: string, args: Args): Promise<void> {
  const [, sub, slug] = args.positionals
  if ((sub !== 'preview' && sub !== 'state') || slug === undefined) fail(USAGE)
  await withRuntime(dataDir, (rt) =>
    sub === 'preview'
      ? contextPreviewCommand(rt, slug, stdoutWrite)
      : contextStateCommand(rt, slug, stdoutWrite),
  )
}

async function cmdRuns(dataDir: string, args: Args): Promise<void> {
  const [, sub, slug, runId] = args.positionals
  if (sub === 'list' && slug !== undefined) {
    await withRuntime(dataDir, (rt) => runsListCommand(rt, slug, stdoutWrite))
    return
  }
  if (sub === 'show' && slug !== undefined && runId !== undefined) {
    await withRuntime(dataDir, (rt) =>
      runsShowCommand(rt, slug, runId, { full: args.flags.full === true, out: stdoutWrite }),
    )
    return
  }
  fail('usage: runs list <slug> | runs show <slug> <runId> [--full]')
}

async function main(): Promise<void> {
  const dataDir = process.env.COWRITE_DATA_DIR ?? path.join(os.homedir(), '.cowrite', 'data')
  const args = parseArgs(process.argv.slice(2))
  const [cmd, a, b] = args.positionals

  switch (cmd) {
    case 'works':
      return cmdWorks(dataDir, args)
    case 'work':
      if (a !== 'info' || b === undefined) fail(USAGE)
      return cmdWorkInfo(dataDir, b)
    case 'snippet':
      return cmdSnippet(dataDir, args)
    case 'situation':
      return cmdSituation(dataDir, args)
    case 'world':
      if (a !== 'list' || b === undefined) fail(USAGE)
      return cmdWorldList(dataDir, b)
    case 'search':
      if (a === undefined || b === undefined) fail('usage: search <slug> <query>')
      return cmdSearch(dataDir, a, args.positionals.slice(2).join(' '))
    case 'reconcile':
      if (a === undefined) fail('usage: reconcile <slug>')
      return cmdReconcile(dataDir, a)
    case 'rebuild':
      if (a === undefined) fail('usage: rebuild <slug>')
      return cmdRebuild(dataDir, a)
    case 'continue':
    case 'instruct':
    case 'quick-edit':
      return cmdAgentTask(dataDir, args)
    case 'prompt':
      return cmdPrompt(dataDir, args)
    case 'context':
      return cmdContext(dataDir, args)
    case 'runs':
      return cmdRuns(dataDir, args)
    default:
      fail(USAGE)
  }
}

// Run only when invoked as a script (tsx src/cli.ts) — importing this module for its
// exported helpers (tests) must not execute the CLI.
const entry = process.argv[1]
if (entry !== undefined && path.resolve(entry) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
