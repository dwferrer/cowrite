import path from 'node:path'

/**
 * The canonical on-disk layout of spec 02 §5.2, as pure path functions. Nothing here
 * touches the filesystem. Numeric filename prefixes ('010-', '020.') are the HUMAN
 * MIRROR of ordering only (spec §4) — the metadata `orderKey` is authoritative, so the
 * parsers below surface prefixes as untrusted hints, never as ordering inputs.
 */

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export function worksRoot(dataDir: string): string {
  return path.join(dataDir, 'works')
}

export function workDir(dataDir: string, slug: string): string {
  return path.join(worksRoot(dataDir), slug)
}

export function trashRoot(dataDir: string): string {
  return path.join(dataDir, '.trash')
}

export function workMetaPath(workDirPath: string): string {
  return path.join(workDirPath, 'work.json')
}

export function situationPath(workDirPath: string): string {
  return path.join(workDirPath, 'situation.md')
}

export function sectionsDir(workDirPath: string): string {
  return path.join(workDirPath, 'sections')
}

export function frontierSnippetsDir(workDirPath: string): string {
  return path.join(workDirPath, 'frontier', 'snippets')
}

export function frontierRevisionsDir(workDirPath: string): string {
  return path.join(workDirPath, 'frontier', 'revisions')
}

/** Work-relative ('/'-separated, portable) path of a snippet's revision log (§5.2). */
export function revisionLogRelPath(snippetId: string): string {
  return `frontier/revisions/${snippetId}.jsonl`
}

export function revisionLogPath(workDirPath: string, snippetId: string): string {
  return path.join(frontierRevisionsDir(workDirPath), `${snippetId}.jsonl`)
}

export function worldEntriesDir(workDirPath: string): string {
  return path.join(workDirPath, 'world', 'entries')
}

export function worldImagesDir(workDirPath: string): string {
  return path.join(workDirPath, 'world', 'images')
}

/** Work-relative path of a world entry's image PNG — also the `image` field value (§10.6). */
export function worldImageRelPath(entryId: string): string {
  return `world/images/${entryId}.png`
}

export function worldImagePath(workDirPath: string, entryId: string): string {
  return path.join(worldImagesDir(workDirPath), `${entryId}.png`)
}

/** Work-relative path of the IllustrationMeta sidecar next to a world image (§5.2). */
export function worldImageSidecarRelPath(entryId: string): string {
  return `world/images/${entryId}.json`
}

export function worldImageSidecarPath(workDirPath: string, entryId: string): string {
  return path.join(worldImagesDir(workDirPath), `${entryId}.json`)
}

export function runsDir(workDirPath: string): string {
  return path.join(workDirPath, 'runs')
}

/** `runs/<YYYY-MM>/<runId>.jsonl` — month shard keeps directories small (spec §5.2). */
export function runFilePath(runsDirPath: string, runId: string, startedAtIso: string): string {
  const shard = startedAtIso.slice(0, 7)
  if (!/^\d{4}-\d{2}$/.test(shard)) {
    throw new Error(`runFilePath: not an ISO timestamp: ${JSON.stringify(startedAtIso)}`)
  }
  return path.join(runsDirPath, shard, `${runId}.jsonl`)
}

export function cowriteDir(workDirPath: string): string {
  return path.join(workDirPath, '.cowrite')
}

export function indexPath(workDirPath: string): string {
  return path.join(cowriteDir(workDirPath), 'index.sqlite')
}

export function lockPath(workDirPath: string): string {
  return path.join(cowriteDir(workDirPath), 'lock')
}

export function journalPath(workDirPath: string): string {
  return path.join(cowriteDir(workDirPath), 'pending-ops.json')
}

export function undoDir(workDirPath: string, opId: string): string {
  return path.join(cowriteDir(workDirPath), 'undo', opId)
}

// Kept for M1 Stage 3: the context engine (06) persists its budget scratch here.
export function contextDir(workDirPath: string): string {
  return path.join(cowriteDir(workDirPath), 'context')
}

export function trashMarkerPath(workDirPath: string): string {
  return path.join(cowriteDir(workDirPath), 'trash.json')
}

// ---------------------------------------------------------------------------
// Slugs & short ids
// ---------------------------------------------------------------------------

const MAX_SLUG_LENGTH = 60

/**
 * Lowercase ascii-ish slug: diacritics stripped, non-alphanumerics collapsed to single
 * hyphens, bounded length, never empty (falls back to 'work').
 */
export function slugify(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining diacritics exposed by NFKD
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, '')
  return slug === '' ? 'work' : slug
}

/** The last 6 chars of a ULID, lowercased — the filename short id of spec §3. */
export function shortId(ulid: string): string {
  return ulid.slice(-6).toLowerCase()
}

// Lowercase Crockford base32 (ULID alphabet: no i, l, o, u).
const SHORT_ID = '[0-9a-hjkmnp-tv-z]{6}'

// ---------------------------------------------------------------------------
// Filename builders & parsers
// ---------------------------------------------------------------------------

function formatPrefix(prefixNumber: number): string {
  if (!Number.isInteger(prefixNumber) || prefixNumber < 0) {
    throw new Error(`invalid filename prefix: ${prefixNumber}`)
  }
  return String(prefixNumber).padStart(3, '0')
}

const SNIPPET_FILE = new RegExp(`^(\\d+)\\.(${SHORT_ID})\\.md$`)
const SECTION_DIR = new RegExp(`^(\\d+)-(.+)\\.(${SHORT_ID})$`)
const WORLD_ENTRY_FILE = new RegExp(`^(.+)\\.(${SHORT_ID})\\.md$`)

/** `NNN.shortid.md`, e.g. '010.p2m9x1.md'. */
export function snippetFileName(prefixNumber: number, ulid: string): string {
  return `${formatPrefix(prefixNumber)}.${shortId(ulid)}.md`
}

export interface ParsedSnippetFileName {
  /** Human-mirror ordering hint only — untrusted; the frontmatter orderKey is authoritative. */
  prefix: number
  shortId: string
}

export function parseSnippetFileName(fileName: string): ParsedSnippetFileName | null {
  const match = SNIPPET_FILE.exec(fileName)
  if (!match || match[1] === undefined || match[2] === undefined) return null
  return { prefix: Number.parseInt(match[1], 10), shortId: match[2] }
}

/** `NNN-slug.shortid`, e.g. '020-the-storm.k9v3qa'. */
export function sectionDirName(prefixNumber: number, slug: string, ulid: string): string {
  return `${formatPrefix(prefixNumber)}-${slug}.${shortId(ulid)}`
}

export interface ParsedSectionDirName {
  /** Human-mirror ordering hint only — untrusted; section.json orderKey is authoritative. */
  prefix: number
  slug: string
  shortId: string
}

export function parseSectionDirName(dirName: string): ParsedSectionDirName | null {
  const match = SECTION_DIR.exec(dirName)
  if (!match || match[1] === undefined || match[2] === undefined || match[3] === undefined) {
    return null
  }
  return { prefix: Number.parseInt(match[1], 10), slug: match[2], shortId: match[3] }
}

/** `slug.shortid.md`, e.g. 'mara-voss.7f3akq.md'. */
export function worldEntryFileName(slug: string, ulid: string): string {
  return `${slug}.${shortId(ulid)}.md`
}

export interface ParsedWorldEntryFileName {
  slug: string
  shortId: string
}

export function parseWorldEntryFileName(fileName: string): ParsedWorldEntryFileName | null {
  const match = WORLD_ENTRY_FILE.exec(fileName)
  if (!match || match[1] === undefined || match[2] === undefined) return null
  return { slug: match[1], shortId: match[2] }
}
