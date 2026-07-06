import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  contextDir,
  cowriteDir,
  frontierRevisionsDir,
  frontierSnippetsDir,
  indexPath,
  journalPath,
  lockPath,
  parseSectionDirName,
  parseSnippetFileName,
  parseWorldEntryFileName,
  revisionLogPath,
  revisionLogRelPath,
  runFilePath,
  runsDir,
  sectionDirName,
  sectionsDir,
  shortId,
  situationPath,
  slugify,
  snippetFileName,
  trashMarkerPath,
  trashRoot,
  undoDir,
  workDir,
  workMetaPath,
  worksRoot,
  worldEntriesDir,
  worldEntryFileName,
  worldImagePath,
  worldImageRelPath,
  worldImageSidecarPath,
  worldImageSidecarRelPath,
  worldImagesDir,
} from './paths.js'

const DATA = path.join('home', '.cowrite', 'data')
const ULID = '01J2P7R9GT5W0ZNXK3M8QAB4CD'

describe('layout', () => {
  it('builds the canonical §5.2 tree', () => {
    const work = workDir(DATA, 'salt-and-signal')
    expect(worksRoot(DATA)).toBe(path.join(DATA, 'works'))
    expect(work).toBe(path.join(DATA, 'works', 'salt-and-signal'))
    expect(trashRoot(DATA)).toBe(path.join(DATA, '.trash'))
    expect(workMetaPath(work)).toBe(path.join(work, 'work.json'))
    expect(situationPath(work)).toBe(path.join(work, 'situation.md'))
    expect(sectionsDir(work)).toBe(path.join(work, 'sections'))
    expect(frontierSnippetsDir(work)).toBe(path.join(work, 'frontier', 'snippets'))
    expect(frontierRevisionsDir(work)).toBe(path.join(work, 'frontier', 'revisions'))
    expect(worldEntriesDir(work)).toBe(path.join(work, 'world', 'entries'))
    expect(worldImagesDir(work)).toBe(path.join(work, 'world', 'images'))
    expect(runsDir(work)).toBe(path.join(work, 'runs'))
    expect(cowriteDir(work)).toBe(path.join(work, '.cowrite'))
    expect(indexPath(work)).toBe(path.join(work, '.cowrite', 'index.sqlite'))
    expect(lockPath(work)).toBe(path.join(work, '.cowrite', 'lock'))
    expect(journalPath(work)).toBe(path.join(work, '.cowrite', 'pending-ops.json'))
    expect(undoDir(work, ULID)).toBe(path.join(work, '.cowrite', 'undo', ULID))
    expect(contextDir(work)).toBe(path.join(work, '.cowrite', 'context'))
    expect(trashMarkerPath(work)).toBe(path.join(work, '.cowrite', 'trash.json'))
  })

  it('spells revision-log and world-image paths once (abs + work-relative)', () => {
    const work = workDir(DATA, 'w')
    expect(revisionLogPath(work, ULID)).toBe(
      path.join(work, 'frontier', 'revisions', `${ULID}.jsonl`),
    )
    expect(revisionLogRelPath(ULID)).toBe(`frontier/revisions/${ULID}.jsonl`)
    expect(worldImagePath(work, ULID)).toBe(path.join(work, 'world', 'images', `${ULID}.png`))
    expect(worldImageRelPath(ULID)).toBe(`world/images/${ULID}.png`)
    expect(worldImageSidecarPath(work, ULID)).toBe(
      path.join(work, 'world', 'images', `${ULID}.json`),
    )
    expect(worldImageSidecarRelPath(ULID)).toBe(`world/images/${ULID}.json`)
  })

  it('shards run files by month from the started-at timestamp', () => {
    const runs = runsDir(workDir(DATA, 'w'))
    expect(runFilePath(runs, ULID, '2026-07-06T14:01:58Z')).toBe(
      path.join(runs, '2026-07', `${ULID}.jsonl`),
    )
  })

  it('rejects a non-ISO started-at', () => {
    expect(() => runFilePath('runs', ULID, 'yesterday')).toThrow(/not an ISO timestamp/)
  })
})

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('The Storm Glass')).toBe('the-storm-glass')
  })

  it('strips diacritics and non-ascii punctuation', () => {
    expect(slugify("L'Étoile: éclats & mémoire!")).toBe('l-etoile-eclats-memoire')
  })

  it('collapses runs and trims edge hyphens', () => {
    expect(slugify('  --Salt //  and ~~ Signal--  ')).toBe('salt-and-signal')
  })

  it('bounds length without leaving a trailing hyphen', () => {
    const slug = slugify(`${'a'.repeat(59)} bcdef`)
    expect(slug.length).toBeLessThanOrEqual(60)
    expect(slug.endsWith('-')).toBe(false)
  })

  it('never returns empty', () => {
    expect(slugify('')).toBe('work')
    expect(slugify('!!! 🌊 ***')).toBe('work')
    expect(slugify('風の谷')).toBe('work')
  })
})

describe('shortId', () => {
  it('takes the last 6 chars of the ULID, lowercased', () => {
    expect(shortId(ULID)).toBe('qab4cd')
  })
})

describe('snippet file names', () => {
  it('builds NNN.shortid.md', () => {
    expect(snippetFileName(10, ULID)).toBe('010.qab4cd.md')
    expect(snippetFileName(1230, ULID)).toBe('1230.qab4cd.md')
  })

  it('parses its own output', () => {
    expect(parseSnippetFileName(snippetFileName(30, ULID))).toEqual({
      prefix: 30,
      shortId: 'qab4cd',
    })
  })

  it('returns null for foreign names', () => {
    expect(parseSnippetFileName('notes.md')).toBeNull()
    expect(parseSnippetFileName('010.QAB4CD.md')).toBeNull() // uppercase short id
    expect(parseSnippetFileName('010.qab4cd.txt')).toBeNull()
    expect(parseSnippetFileName('010.qab4.md')).toBeNull() // short id too short
  })

  it('rejects invalid prefixes at build time', () => {
    expect(() => snippetFileName(-1, ULID)).toThrow(/invalid filename prefix/)
    expect(() => snippetFileName(1.5, ULID)).toThrow(/invalid filename prefix/)
  })
})

describe('section dir names', () => {
  it('builds NNN-slug.shortid', () => {
    expect(sectionDirName(20, 'the-storm-glass', ULID)).toBe('020-the-storm-glass.qab4cd')
  })

  it('parses its own output, including dotted slugs', () => {
    expect(parseSectionDirName('020-the-storm-glass.qab4cd')).toEqual({
      prefix: 20,
      slug: 'the-storm-glass',
      shortId: 'qab4cd',
    })
    expect(parseSectionDirName('010-v1.2-final.qab4cd')).toEqual({
      prefix: 10,
      slug: 'v1.2-final',
      shortId: 'qab4cd',
    })
  })

  it('returns null for foreign names', () => {
    expect(parseSectionDirName('drafts')).toBeNull()
    expect(parseSectionDirName('020-the-storm-glass')).toBeNull() // no short id
    expect(parseSectionDirName('the-storm-glass.qab4cd')).toBeNull() // no prefix
  })
})

describe('world entry file names', () => {
  it('builds slug.shortid.md and parses it back', () => {
    expect(worldEntryFileName('mara-voss', ULID)).toBe('mara-voss.qab4cd.md')
    expect(parseWorldEntryFileName('mara-voss.qab4cd.md')).toEqual({
      slug: 'mara-voss',
      shortId: 'qab4cd',
    })
  })

  it('returns null for foreign names', () => {
    expect(parseWorldEntryFileName('mara-voss.md')).toBeNull()
    expect(parseWorldEntryFileName('.qab4cd.md')).toBeNull() // empty slug
    expect(parseWorldEntryFileName('mara-voss.qab4cd.png')).toBeNull()
  })
})
