import { describe, expect, it } from 'vitest'
import { illustrationCaption, illustrationFailureText } from './illustrationCaption.js'

/**
 * Caption + failure-text formatting (docs/08-illustration.md §8, §10) — pure functions,
 * unit-tested in isolation from the shimmer/badge components that call them.
 */

describe('illustrationCaption', () => {
  it('composing has no attempt/pct suffix', () => {
    expect(illustrationCaption('composing', 1, 3, null)).toBe('Composing prompt')
  })

  it('generating includes the attempt fraction and rounds pct', () => {
    expect(illustrationCaption('generating', 2, 3, 63.6)).toBe('Generating (attempt 2/3, 64%)')
  })

  it('generating omits the percent when null (outside a sampler tick)', () => {
    expect(illustrationCaption('generating', 1, 3, null)).toBe('Generating (attempt 1/3)')
  })

  it('queued names the attempt it is queued for', () => {
    expect(illustrationCaption('queued', 2, 3, null)).toBe('Queued (attempt 2/3)')
  })

  it('critiquing, revising, committing are attempt-agnostic one-liners', () => {
    expect(illustrationCaption('critiquing', 1, 3, null)).toBe('Critiquing…')
    expect(illustrationCaption('revising', 1, 3, null)).toBe('Revising prompt…')
    expect(illustrationCaption('committing', 3, 3, null)).toBe('Committing…')
  })
})

describe('illustrationFailureText', () => {
  it('maps every §8/§10 pipeline detail to friendly text', () => {
    expect(illustrationFailureText('pipeline', 'comfy_unreachable')).toBe('ComfyUI unreachable')
    expect(illustrationFailureText('pipeline', 'workflow_invalid')).toContain('%marker%')
    expect(illustrationFailureText('pipeline', 'comfy_exec_error')).toBe('Image generation failed')
    expect(illustrationFailureText('pipeline', 'comfy_timeout')).toBe('Generation timed out')
    expect(illustrationFailureText('pipeline', 'commit_target_missing')).toBe(
      'Section changed before the image finished',
    )
  })

  it('an unknown pipeline detail falls back to a generic message', () => {
    expect(illustrationFailureText('pipeline', 'something_new')).toBe('Illustration failed')
  })

  it('config_missing gets its own friendly text regardless of the raw message', () => {
    expect(illustrationFailureText('config_missing', 'dangling route "hq"')).toBe(
      'ComfyUI not configured',
    )
  })

  it('any other code falls back to the raw message, else the generic line', () => {
    expect(illustrationFailureText('internal', 'boom')).toBe('boom')
    expect(illustrationFailureText('internal', '')).toBe('Illustration failed')
  })
})
