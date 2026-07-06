import path from 'node:path'
import { WorkMeta } from '@cowrite/shared'
import { isTmpFile, readdirSorted, readIfExists } from '../lib/fsx.js'
import { xxh64OfString } from '../lib/hash.js'
import {
  frontierRevisionsDir,
  frontierSnippetsDir,
  runsDir,
  sectionsDir,
  situationPath,
  workMetaPath,
  worldEntriesDir,
  worldImagesDir,
} from '../lib/paths.js'
import type { FileRow, IndexDb } from './db.js'
import {
  fileRowFor,
  type LoadedRun,
  type LoadedSection,
  type LoadedSnippet,
  type LoadedWorldEntry,
  loadRunFromDisk,
  loadSectionFromDisk,
  loadSnippetFromDisk,
  loadWorldEntryFromDisk,
} from './ingest.js'

/**
 * Full index rebuild (spec 02 §7.3): delete-all + one scan of the work directory into
 * every table. Reads happen up front (hashing included, each file touched once); all
 * inserts land in a single transaction over prepared statements, which is what keeps a
 * 200k-word work's core tables under the < 2 s target. For runs/** only each file's
 * first (`meta`) and last (`result`) lines are parsed — never the full transcript.
 */

export interface RebuildStats {
  files: number
  sections: number
  snippets: number
  worldEntries: number
  runs: number
}

// Orphaned atomic-write temp files (§9.1, isTmpFile) are never indexed.
const REVISION_LOG = /^[0-9A-HJKMNP-TV-Z]{26}\.jsonl$/

/**
 * Rebuild the whole index from the files alone. The caller owns DB lifecycle: on
 * corruption or a user_version mismatch it deletes the DB file and reopens before
 * calling this (needsRebuild → openIndex → fullRebuild).
 */
export async function fullRebuild(db: IndexDb, workDir: string): Promise<RebuildStats> {
  const workRaw = await readIfExists(workMetaPath(workDir))
  if (workRaw === null) {
    throw new Error(`fullRebuild: no work.json under ${workDir}`)
  }
  const work = WorkMeta.parse(JSON.parse(workRaw))
  const staleDeltaPct = work.settings.illustrationStaleWordDeltaPct

  const files: FileRow[] = []
  const pushFileRow = async (absPath: string): Promise<void> => {
    const row = await fileRowFor(workDir, absPath)
    if (row) files.push(row)
  }

  // work.json + situation.md (§8 walk set). An absent situation.md = empty situation.
  await pushFileRow(workMetaPath(workDir))
  const situationText = (await readIfExists(situationPath(workDir))) ?? ''
  const situationHash = await xxh64OfString(situationText)
  await pushFileRow(situationPath(workDir))

  // sections/** — recursive walk; dir nesting = tree, parent_id from containment (§5.2).
  // A dir is a section dir iff its section.json is valid (loadSectionFromDisk returns
  // null otherwise) — the same predicate the reconciler and sectionStore use; the dir
  // NAME is a human mirror only, so hand-renamed dirs must survive a rebuild.
  const sections: LoadedSection[] = []
  const walkSections = async (dirAbs: string, parentId: string | null): Promise<void> => {
    for (const entry of await readdirSorted(dirAbs)) {
      if (!entry.isDirectory()) continue
      const full = path.join(dirAbs, entry.name)
      const loaded = await loadSectionFromDisk(workDir, full, parentId, staleDeltaPct)
      if (loaded === null) continue // no/invalid section.json: the reconciler reports it (§8)
      sections.push(loaded)
      files.push(...loaded.files)
      await walkSections(full, loaded.row.id)
    }
  }
  await walkSections(sectionsDir(workDir), null)

  // frontier/snippets/*.md (each loader also rows the snippet's revision log).
  const snippets: LoadedSnippet[] = []
  const snippetsDir = frontierSnippetsDir(workDir)
  for (const entry of await readdirSorted(snippetsDir)) {
    if (!entry.isFile() || !entry.name.endsWith('.md') || isTmpFile(entry.name)) continue
    const loaded = await loadSnippetFromDisk(workDir, path.join(snippetsDir, entry.name))
    if (loaded === null) continue // frontmatter-less files are adopted by the reconciler, not scan
    snippets.push(loaded)
    files.push(...loaded.files)
  }

  // frontier/revisions/*.jsonl — owned logs were already rowed through their snippet's
  // loader, but ORPHAN logs (their .md deleted externally) get files rows too: the
  // reconciler tracks them forever ('tracked but never deleted', §8), so the rebuild
  // must agree or index == fullRebuild breaks the moment a snippet file is deleted.
  const revisionsRoot = frontierRevisionsDir(workDir)
  for (const entry of await readdirSorted(revisionsRoot)) {
    if (!entry.isFile() || !REVISION_LOG.test(entry.name)) continue
    await pushFileRow(path.join(revisionsRoot, entry.name))
  }

  // world/entries/*.md + world/images/* (images walked wholesale so orphans stay tracked).
  const worldEntries: LoadedWorldEntry[] = []
  const entriesDir = worldEntriesDir(workDir)
  for (const entry of await readdirSorted(entriesDir)) {
    if (!entry.isFile() || !entry.name.endsWith('.md') || isTmpFile(entry.name)) continue
    const loaded = await loadWorldEntryFromDisk(workDir, path.join(entriesDir, entry.name))
    if (loaded === null) continue
    worldEntries.push(loaded)
    files.push(...loaded.files)
  }
  const imagesDir = worldImagesDir(workDir)
  for (const entry of await readdirSorted(imagesDir)) {
    if (!entry.isFile() || isTmpFile(entry.name)) continue
    await pushFileRow(path.join(imagesDir, entry.name))
  }

  // runs/<YYYY-MM>/*.jsonl — meta + result lines only (§7.3); runs are not part of the
  // §8 files-table walk set (write-once, reconciler never diffs them).
  const runs: LoadedRun[] = []
  const runsRoot = runsDir(workDir)
  for (const shard of await readdirSorted(runsRoot)) {
    if (!shard.isDirectory()) continue
    const shardDir = path.join(runsRoot, shard.name)
    for (const entry of await readdirSorted(shardDir)) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl') || isTmpFile(entry.name)) continue
      const loaded = await loadRunFromDisk(workDir, path.join(shardDir, entry.name))
      if (loaded) runs.push(loaded)
    }
  }

  const lastScanAt = new Date().toISOString()
  db.transaction(() => {
    db.deleteAll()
    // files.path is the PK, so the occasional overlap between loaders and wholesale
    // directory walks (e.g. world images) collapses to one row.
    for (const f of files) db.upsertFile(f)
    for (const s of sections) {
      db.upsertSection(s.row)
      db.setFts('section', s.row.id, s.fts.title, s.fts.body)
    }
    for (const s of snippets) {
      db.upsertSnippet(s.row)
      db.setFts('snippet', s.row.id, null, s.body)
    }
    for (const w of worldEntries) {
      db.upsertWorldEntry(w.row, w.keys)
      db.setFts('world', w.row.id, w.row.name, w.body)
    }
    for (const r of runs) db.upsertRun(r.run, r.artifacts)
    db.setMeta('workId', work.id)
    db.setMeta('levelScheme', JSON.stringify(work.levelScheme))
    db.setMeta('situationHash', situationHash)
    db.setMeta('lastScanAt', lastScanAt)
  })

  return {
    files: new Set(files.map((f) => f.path)).size,
    sections: sections.length,
    snippets: snippets.length,
    worldEntries: worldEntries.length,
    runs: runs.length,
  }
}
