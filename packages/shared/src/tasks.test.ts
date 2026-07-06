import { describe, expect, it } from 'vitest'
import { Lane, TaskKind } from './tasks.js'

describe('TaskKind', () => {
  it('is exactly the 8 kebab-case kinds of 02 §2.7', () => {
    expect(TaskKind.options).toEqual([
      'continue',
      'instructed-continue',
      'quick-edit',
      'edit-task',
      'enrich-section',
      'propose-boundaries',
      'illustrate-section',
      'world-image',
    ])
    expect(TaskKind.safeParse('quickEdit').success).toBe(false)
  })
})

describe('Lane', () => {
  it('is the high | low model-lane split', () => {
    expect(Lane.options).toEqual(['high', 'low'])
    expect(Lane.safeParse('interactive').success).toBe(false)
  })
})
