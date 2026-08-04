import { describe, expect, it } from 'vitest'
import { enrichmentBadge, parseArgs, stripBom, titleFromPositionals } from './cli.js'
import type { SectionRow } from './storage/index/db.js'

describe('parseArgs', () => {
  it('splits positionals from --flag forms', () => {
    expect(parseArgs(['snippet', 'append', 'my-work', '--author', 'agent', '--run=abc'])).toEqual({
      positionals: ['snippet', 'append', 'my-work'],
      flags: { author: 'agent', run: 'abc' },
    })
  })

  it('treats a bare trailing --flag as boolean true', () => {
    expect(parseArgs(['works', 'list', '--verbose'])).toEqual({
      positionals: ['works', 'list'],
      flags: { verbose: true },
    })
  })
})

describe('titleFromPositionals (works create)', () => {
  it('joins every word after the subcommand — multi-word titles need no quoting', () => {
    expect(titleFromPositionals(['works', 'create', 'Salt', 'and', 'Signal'])).toBe(
      'Salt and Signal',
    )
    expect(titleFromPositionals(['works', 'create', 'One'])).toBe('One')
  })

  it('is null for a missing title', () => {
    expect(titleFromPositionals(['works', 'create'])).toBeNull()
  })
})

describe('enrichmentBadge (work info fold-relevant fields)', () => {
  const row = (overrides: Partial<SectionRow>): SectionRow => ({
    id: '01JGSECTION0000000000000AA',
    parentId: null,
    kind: 'chapter',
    orderKey: 'a0',
    title: 'One',
    titleSource: 'agent',
    dirPath: 'sections/10-one.aaaaaa',
    wordCount: 1200,
    contentHash: 'abc',
    frozenAt: '2026-08-01T00:00:00Z',
    shortSummaryStale: false,
    longSummaryStale: false,
    illustrationStale: false,
    illustrationHash: null,
    illustrationWidth: null,
    illustrationHeight: null,
    shortSummary: 'A short summary.',
    longSummary: 'A long summary.',
    ...overrides,
  })

  it('reads ok / stale / missing per summary slot', () => {
    expect(enrichmentBadge(row({}))).toBe('  [short ok / long ok / illus none]')
    expect(enrichmentBadge(row({ shortSummary: null, longSummaryStale: true }))).toBe(
      '  [short missing / long stale / illus none]',
    )
    expect(enrichmentBadge(row({ illustrationHash: 'ff', illustrationStale: true }))).toBe(
      '  [short ok / long ok / illus stale]',
    )
  })

  it('is empty for interior sections (no enrichments to report)', () => {
    expect(enrichmentBadge(row({ contentHash: null }))).toBe('')
  })
})

describe('stripBom', () => {
  it('removes a leading UTF-8 BOM (PowerShell 5.1 stdin)', () => {
    expect(stripBom('﻿Mara pressed her palm.')).toBe('Mara pressed her palm.')
  })

  it('leaves BOM-free text and interior U+FEFF untouched', () => {
    expect(stripBom('plain text')).toBe('plain text')
    expect(stripBom('a﻿b')).toBe('a﻿b')
  })
})
