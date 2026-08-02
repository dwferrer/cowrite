import { describe, expect, it } from 'vitest'
import { parseArgs, stripBom, titleFromPositionals } from './cli.js'

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

describe('stripBom', () => {
  it('removes a leading UTF-8 BOM (PowerShell 5.1 stdin)', () => {
    expect(stripBom('﻿Mara pressed her palm.')).toBe('Mara pressed her palm.')
  })

  it('leaves BOM-free text and interior U+FEFF untouched', () => {
    expect(stripBom('plain text')).toBe('plain text')
    expect(stripBom('a﻿b')).toBe('a﻿b')
  })
})
