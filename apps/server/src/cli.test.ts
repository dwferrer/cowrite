import { describe, expect, it } from 'vitest'
import { parseArgs, titleFromPositionals } from './cli.js'

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
