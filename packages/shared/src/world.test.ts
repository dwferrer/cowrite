import { describe, expect, it } from 'vitest'
import { WorldEntryMeta } from './world.js'

// 02 §5.4 — world/entries/mara-voss.7f3akq.md frontmatter
const maraSample = {
  id: '01J2N8W2KQ7F3AKQY9C4MHT6VP',
  name: 'Mara Voss',
  keys: ['Mara', 'Voss', 'the keeper'],
  image: '../images/01J2N8W2KQ7F3AKQY9C4MHT6VP.png',
  shortSummary: "Lighthouse keeper of Cinder Point; hears the sea's dead.",
  createdBy: 'user',
  updatedAt: '2026-07-03T09:15:00Z',
} as const

describe('WorldEntryMeta', () => {
  it('round-trips the §5.4 frontmatter sample', () => {
    expect(WorldEntryMeta.parse(maraSample)).toEqual(maraSample)
  })

  it('defaults keys to [] — an entry with no keys is fully legitimate (§2.6)', () => {
    const parsed = WorldEntryMeta.parse({
      id: '01J2N8W2KQ7F3AKQY9C4MHT6VP',
      name: 'The Storm Glass',
      image: null,
      shortSummary: null,
      createdBy: 'agent',
      updatedAt: '2026-07-03T09:15:00Z',
    })
    expect(parsed.keys).toEqual([])
  })

  it('rejects an empty name and empty-string keys', () => {
    expect(WorldEntryMeta.safeParse({ ...maraSample, name: '' }).success).toBe(false)
    expect(WorldEntryMeta.safeParse({ ...maraSample, keys: [''] }).success).toBe(false)
  })
})
