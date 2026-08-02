import { describe, expect, it } from 'vitest'
import { WorldEntryCreate, WorldEntryDto, WorldEntryMeta, WorldEntryPatch } from './world.js'

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

describe('WorldEntryDto (03 §3.5)', () => {
  const dto = {
    id: maraSample.id,
    name: 'Mara Voss',
    keys: ['Mara', 'Voss'],
    body: 'Keeper of Cinder Point light. Hears the sea speak in the dead of night.',
    bodyHash: 'xxh64:0123456789abcdef',
    shortSummary: "Lighthouse keeper of Cinder Point; hears the sea's dead.",
    hasImage: true,
    imageVersion: 'xxh64:fedcba9876543210',
    updatedAt: '2026-07-03T09:15:00Z',
  }

  it('round-trips the list/detail payload (full body — one fetch powers everything)', () => {
    expect(WorldEntryDto.parse(dto)).toEqual(dto)
  })

  it('an imageless entry carries hasImage false + null imageVersion; keys default to []', () => {
    const { keys: _dropped, ...noKeys } = dto
    const parsed = WorldEntryDto.parse({ ...noKeys, hasImage: false, imageVersion: null })
    expect(parsed.keys).toEqual([])
    expect(parsed.imageVersion).toBeNull()
  })
})

describe('WorldEntryCreate / WorldEntryPatch', () => {
  it('create needs only a name', () => {
    expect(WorldEntryCreate.parse({ name: 'The Storm Glass' })).toEqual({
      name: 'The Storm Glass',
    })
    expect(WorldEntryCreate.safeParse({ name: '' }).success).toBe(false)
  })

  it('patch is sparse and carries baseHash only when the body is being replaced', () => {
    expect(WorldEntryPatch.parse({})).toEqual({})
    const parsed = WorldEntryPatch.parse({
      body: 'Rewritten lore.',
      baseHash: 'xxh64:0123456789abcdef',
    })
    expect(parsed.baseHash).toBe('xxh64:0123456789abcdef')
    expect(WorldEntryPatch.safeParse({ baseHash: 'not-a-hash' }).success).toBe(false)
  })
})
