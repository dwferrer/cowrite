import fsp from 'node:fs/promises'
import path from 'node:path'
import {
  RevisionEvent,
  SectionContent,
  SectionRow,
  SectionSummaries,
  SituationDto,
  SituationPutRes,
  SnippetDto,
  WorkDetail,
  WorkSummary,
  WorldEntryDto,
} from '@cowrite/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  buildFixtureWork,
  FIX,
  makePng,
  SEC1_CONTENT,
  SITUATION_TEXT,
  SNIP1_BODY,
  worldEntryFileText,
} from '../../storage/index/fixture.js'
import { xxh64OfString } from '../../storage/lib/hash.js'
import { compareOrderKeys } from '../../storage/lib/orderKeys.js'
import { createStorage } from '../../storage/service.js'
import {
  createWorkViaApi,
  destroyTestCtx,
  expectEnvelope,
  makeTestCtx,
  NO_SUCH_ID,
  type TestCtx,
} from './testUtil.js'

/**
 * The §12 route matrix (docs/03-api.md): every resource endpoint gets at least one
 * happy-path and one failure-path test asserting the §7 envelope, over real storage on a
 * temp dir. The storage fixture (index/fixture.ts) supplies frozen sections, frontier
 * snippets, world entries, and images.
 */

let ctx: TestCtx
/** id of the seeded fixture work, present in every test below. */
let workId: string
let sec1Hash: string
let situationHash: string

beforeEach(async () => {
  ctx = await makeTestCtx()
  const info = await buildFixtureWork(path.join(ctx.dataDir, 'works'))
  workId = FIX.workId
  sec1Hash = info.sec1ContentHash
  situationHash = info.situationHash
})

afterEach(async () => {
  await destroyTestCtx(ctx)
})

const url = (suffix = ''): string => `/api/works/${workId}${suffix}`

// ---------------------------------------------------------------------------
// §3.1 works
// ---------------------------------------------------------------------------

describe('works', () => {
  it('GET /api/works lists works with WorkSummary rows', async () => {
    await createWorkViaApi(ctx, 'Second Work')
    const res = await ctx.app.inject({ method: 'GET', url: '/api/works' })
    expect(res.statusCode).toBe(200)
    const list = z.array(WorkSummary).parse(res.json())
    expect(list.map((w) => w.title).sort()).toEqual(['Salt and Signal', 'Second Work'])
  })

  it('GET /api/works answers with cache-control: no-store (live state, never cached)', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/works' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
  })

  it('GET /api/works refuses a foreign Host header with the envelope (403)', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/works',
      headers: { host: 'evil.example.com' },
    })
    expectEnvelope(res, 403, 'forbidden_host')
  })

  it('POST /api/works creates a work (201 WorkDetail) and rejects a bad body (400)', async () => {
    const detail = await createWorkViaApi(ctx, 'Fresh Start')
    expect(detail.title).toBe('Fresh Start')
    expect(detail.readonly).toBe(false)
    expect(detail.snippetCount).toBe(0)

    const bad = await ctx.app.inject({ method: 'POST', url: '/api/works', payload: {} })
    expectEnvelope(bad, 400, 'validation')
  })

  it('GET /api/works/:w returns WorkDetail with live counts', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: url() })
    expect(res.statusCode).toBe(200)
    const detail = WorkDetail.parse(res.json())
    expect(detail.id).toBe(workId)
    expect(detail.slug).toBe('salt-and-signal')
    expect(detail.snippetCount).toBe(3)
    expect(detail.sectionCount).toBe(2)
    expect(detail.readonly).toBe(false)
  })

  it('GET /api/works/:w 404s for an unknown id', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: `/api/works/${NO_SUCH_ID}` })
    expectEnvelope(res, 404, 'not_found')
  })

  it('PATCH /api/works/:w merges a partial settings update without clobbering', async () => {
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: url(),
      payload: { title: 'Salt & Signal', settings: { consolidation: { debounceMs: 5000 } } },
    })
    expect(res.statusCode).toBe(200)
    const detail = WorkDetail.parse(res.json())
    expect(detail.title).toBe('Salt & Signal')
    expect(detail.settings.consolidation.debounceMs).toBe(5000)
    // untouched siblings keep their defaults — true-partial merge
    expect(detail.settings.consolidation.maxFrontierSnippets).toBe(18)
    expect(detail.settings.illustrationStaleWordDeltaPct).toBe(15)
  })

  it('PATCH /api/works/:w rejects a malformed body (400)', async () => {
    const res = await ctx.app.inject({ method: 'PATCH', url: url(), payload: { title: '' } })
    expectEnvelope(res, 400, 'validation')
  })

  it('DELETE /api/works/:w moves the work to .trash and unlists it', async () => {
    const res = await ctx.app.inject({ method: 'DELETE', url: url() })
    expect(res.statusCode).toBe(204)
    const list = z
      .array(WorkSummary)
      .parse((await ctx.app.inject({ method: 'GET', url: '/api/works' })).json())
    expect(list).toHaveLength(0)
    const trash = await fsp.readdir(path.join(ctx.dataDir, '.trash'))
    expect(trash.some((name) => name.startsWith('salt-and-signal'))).toBe(true)
  })

  it('DELETE /api/works/:w 404s for an unknown id', async () => {
    const res = await ctx.app.inject({ method: 'DELETE', url: `/api/works/${NO_SUCH_ID}` })
    expectEnvelope(res, 404, 'not_found')
  })
})

// ---------------------------------------------------------------------------
// §3.2 sections
// ---------------------------------------------------------------------------

describe('sections', () => {
  it('GET /sections returns the flat SectionRow list with inlined summaries', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: url('/sections') })
    expect(res.statusCode).toBe(200)
    const rows = z.array(SectionRow).parse(res.json())
    expect(rows.map((r) => r.id)).toEqual([FIX.sec1, FIX.sec2])
    const sec1 = rows[0]
    expect(sec1?.shortSummary).toContain('Keeper watches the harbor')
    expect(sec1?.illustration).not.toBeNull()
    expect(sec1?.stale.long).toBe(true) // fixture: mismatched sourceHash
    const sec2 = rows[1]
    expect(sec2?.illustration).toBeNull() // suppressed tombstone reads as none
  })

  it('GET /sections 404s for an unknown work', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: `/api/works/${NO_SUCH_ID}/sections` })
    expectEnvelope(res, 404, 'not_found')
  })

  it('GET /sections/:s/content returns leaf prose and 404s for unknown sections', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: url(`/sections/${FIX.sec1}/content`) })
    expect(res.statusCode).toBe(200)
    const content = SectionContent.parse(res.json())
    expect(content.markdown).toBe(SEC1_CONTENT)
    expect(content.contentHash).toBe(sec1Hash)

    const missing = await ctx.app.inject({
      method: 'GET',
      url: url(`/sections/${NO_SUCH_ID}/content`),
    })
    expectEnvelope(missing, 404, 'not_found')
  })

  it('PATCH /sections/:s/content replaces at the right baseHash and 409s when stale', async () => {
    const ok = await ctx.app.inject({
      method: 'PATCH',
      url: url(`/sections/${FIX.sec1}/content`),
      payload: { markdown: 'Rewritten chapter one.\n', baseHash: sec1Hash },
    })
    expect(ok.statusCode).toBe(200)
    const { contentHash } = z.object({ contentHash: z.string() }).parse(ok.json())
    expect(contentHash).not.toBe(sec1Hash)

    // the old hash is now stale — theirs/mine payload comes back in details
    const stale = await ctx.app.inject({
      method: 'PATCH',
      url: url(`/sections/${FIX.sec1}/content`),
      payload: { markdown: 'Lost update.\n', baseHash: sec1Hash },
    })
    const details = expectEnvelope(stale, 409, 'conflict') as {
      currentHash: string
      currentText: string
    }
    expect(details.currentHash).toBe(contentHash)
    expect(details.currentText).toBe('Rewritten chapter one.\n')
  })

  it('PATCH /sections/:s sets a user title (titleSource pinned) and 400s on empty', async () => {
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: url(`/sections/${FIX.sec1}`),
      payload: { title: 'The Keeper of Cinder Point' },
    })
    expect(res.statusCode).toBe(200)
    const row = SectionRow.parse(res.json())
    expect(row.title).toBe('The Keeper of Cinder Point')
    expect(row.titleSource).toBe('user')

    const bad = await ctx.app.inject({
      method: 'PATCH',
      url: url(`/sections/${FIX.sec1}`),
      payload: { title: '' },
    })
    expectEnvelope(bad, 400, 'validation')
  })

  it('GET /sections/:s/summaries reads both files; 404 for unknown sections', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: url(`/sections/${FIX.sec1}/summaries`) })
    expect(res.statusCode).toBe(200)
    const summaries = SectionSummaries.parse(res.json())
    expect(summaries.short).toContain('Keeper watches')
    expect(summaries.long).toContain('longer summary')

    const missing = await ctx.app.inject({
      method: 'GET',
      url: url(`/sections/${NO_SUCH_ID}/summaries`),
    })
    expectEnvelope(missing, 404, 'not_found')
  })

  it('PUT /sections/:s/summaries records a user edit and clears staleness', async () => {
    const res = await ctx.app.inject({
      method: 'PUT',
      url: url(`/sections/${FIX.sec2}/summaries`),
      payload: { short: 'A warning hums on a shelf.' },
    })
    expect(res.statusCode).toBe(200)
    const row = SectionRow.parse(res.json())
    expect(row.shortSummary).toBe('A warning hums on a shelf.')
    expect(row.stale.short).toBe(false) // user-edited at the current sourceHash

    const empty = await ctx.app.inject({
      method: 'PUT',
      url: url(`/sections/${FIX.sec2}/summaries`),
      payload: {},
    })
    expectEnvelope(empty, 400, 'validation')
  })
})

// ---------------------------------------------------------------------------
// §3.3 snippets + §3.4 editing signal
// ---------------------------------------------------------------------------

describe('snippets', () => {
  it('GET /snippets lists full-text SnippetDtos in orderKey order', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: url('/snippets') })
    expect(res.statusCode).toBe(200)
    const list = z.array(SnippetDto).parse(res.json())
    expect(list.map((s) => s.id)).toEqual([FIX.snip1, FIX.snip2, FIX.snip3])
    expect(list[0]?.text).toBe(SNIP1_BODY)
    expect(list[0]?.revisionCount).toBe(3)
  })

  it('GET /snippets 404s for an unknown work', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: `/api/works/${NO_SUCH_ID}/snippets` })
    expectEnvelope(res, 404, 'not_found')
  })

  it('POST /snippets appends at the frontier end by default', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: url('/snippets'),
      payload: { text: 'A new closing line.' },
    })
    expect(res.statusCode).toBe(201)
    const dto = SnippetDto.parse(res.json())
    expect(dto.authorship).toBe('user')
    const list = z
      .array(SnippetDto)
      .parse((await ctx.app.inject({ method: 'GET', url: url('/snippets') })).json())
    expect(list.at(-1)?.id).toBe(dto.id)
  })

  it('POST /snippets inserts between neighbors via afterSnippetId', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: url('/snippets'),
      payload: { text: 'Slotted between one and two.', afterSnippetId: FIX.snip1 },
    })
    expect(res.statusCode).toBe(201)
    const dto = SnippetDto.parse(res.json())
    const list = z
      .array(SnippetDto)
      .parse((await ctx.app.inject({ method: 'GET', url: url('/snippets') })).json())
    expect(list.map((s) => s.id)).toEqual([FIX.snip1, dto.id, FIX.snip2, FIX.snip3])
    const [a, b, c] = [list[0], list[1], list[2]]
    if (a === undefined || b === undefined || c === undefined) throw new Error('short list')
    expect(compareOrderKeys(a.orderKey, b.orderKey)).toBeLessThan(0)
    expect(compareOrderKeys(b.orderKey, c.orderKey)).toBeLessThan(0)
  })

  it('POST /snippets 404s for an unknown afterSnippetId', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: url('/snippets'),
      payload: { text: 'Nowhere to go.', afterSnippetId: NO_SUCH_ID },
    })
    expectEnvelope(res, 404, 'not_found')
  })

  it('PATCH /snippets/:s revises at the right baseRev and 409s when stale', async () => {
    const ok = await ctx.app.inject({
      method: 'PATCH',
      url: url(`/snippets/${FIX.snip1}`),
      payload: { text: 'Mara pressed both palms against the glass.', baseRev: 3 },
    })
    expect(ok.statusCode).toBe(200)
    const dto = SnippetDto.parse(ok.json())
    expect(dto.rev).toBe(4)
    expect(dto.revisionCount).toBe(4)
    expect(dto.authorship).toBe('mixed')

    const stale = await ctx.app.inject({
      method: 'PATCH',
      url: url(`/snippets/${FIX.snip1}`),
      payload: { text: 'Too late.', baseRev: 3 },
    })
    const details = expectEnvelope(stale, 409, 'conflict') as {
      currentRev: number
      currentText: string
    }
    expect(details.currentRev).toBe(4)
    expect(details.currentText).toBe('Mara pressed both palms against the glass.')
  })

  it('DELETE /snippets/:s removes the snippet; 404 for unknown ids', async () => {
    const res = await ctx.app.inject({ method: 'DELETE', url: url(`/snippets/${FIX.snip2}`) })
    expect(res.statusCode).toBe(204)
    const list = z
      .array(SnippetDto)
      .parse((await ctx.app.inject({ method: 'GET', url: url('/snippets') })).json())
    expect(list.map((s) => s.id)).toEqual([FIX.snip1, FIX.snip3])

    const missing = await ctx.app.inject({ method: 'DELETE', url: url(`/snippets/${NO_SUCH_ID}`) })
    expectEnvelope(missing, 404, 'not_found')
  })

  it('GET /snippets/:s/revisions returns the full log, oldest first', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: url(`/snippets/${FIX.snip1}/revisions`),
    })
    expect(res.statusCode).toBe(200)
    const events = z.array(RevisionEvent).parse(res.json())
    expect(events.map((e) => e.rev)).toEqual([1, 2, 3])
    expect(events[0]?.text).toBe('draft one')

    const missing = await ctx.app.inject({
      method: 'GET',
      url: url(`/snippets/${NO_SUCH_ID}/revisions`),
    })
    expectEnvelope(missing, 404, 'not_found')
  })

  it('POST /snippets/:s/restore appends a NEW revision with the old text', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: url(`/snippets/${FIX.snip1}/restore`),
      payload: { rev: 1 },
    })
    expect(res.statusCode).toBe(200)
    const dto = SnippetDto.parse(res.json())
    expect(dto.text).toBe('draft one')
    expect(dto.rev).toBe(4) // history extended, never rewritten
    expect(dto.revisionCount).toBe(4)
  })

  it('POST /snippets/:s/restore 404s for a revision that never existed', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: url(`/snippets/${FIX.snip1}/restore`),
      payload: { rev: 99 },
    })
    expectEnvelope(res, 404, 'not_found')
  })
})

describe('editing signal', () => {
  it('POST /editing sets and clears the in-memory signal (204)', async () => {
    const set = await ctx.app.inject({
      method: 'POST',
      url: url('/editing'),
      payload: { snippetId: FIX.snip1 },
    })
    expect(set.statusCode).toBe(204)
    const open = await ctx.works.open(workId)
    expect(open.handle.getEditingSnippet()).toBe(FIX.snip1)

    const clear = await ctx.app.inject({
      method: 'POST',
      url: url('/editing'),
      payload: { snippetId: null },
    })
    expect(clear.statusCode).toBe(204)
    expect(open.handle.getEditingSnippet()).toBeNull()
  })

  it('POST /editing rejects a malformed body (400)', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: url('/editing'),
      payload: { snippetId: 'not-a-ulid' },
    })
    expectEnvelope(res, 400, 'validation')
  })
})

// ---------------------------------------------------------------------------
// §3.5 world
// ---------------------------------------------------------------------------

describe('world', () => {
  it('GET /world lists entries with body, keys, and image versions', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: url('/world') })
    expect(res.statusCode).toBe(200)
    const list = z.array(WorldEntryDto).parse(res.json())
    const mara = list.find((e) => e.id === FIX.mara)
    const glass = list.find((e) => e.id === FIX.glass)
    expect(mara?.hasImage).toBe(true)
    expect(mara?.imageVersion).toMatch(/^xxh64:[0-9a-f]{16}$/)
    expect(mara?.keys).toContain('the keeper')
    expect(glass?.hasImage).toBe(false)
    expect(glass?.body).toContain('sealed vial')
  })

  it('GET /world/:e fetches one entry; 404 for unknown ids', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: url(`/world/${FIX.mara}`) })
    expect(res.statusCode).toBe(200)
    expect(WorldEntryDto.parse(res.json()).name).toBe('Mara Voss')

    const missing = await ctx.app.inject({ method: 'GET', url: url(`/world/${NO_SUCH_ID}`) })
    expectEnvelope(missing, 404, 'not_found')
  })

  it('POST /world creates an entry (201); bad body 400s', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: url('/world'),
      payload: { name: 'Cinder Point', keys: ['the point'], body: 'A basalt headland.' },
    })
    expect(res.statusCode).toBe(201)
    const dto = WorldEntryDto.parse(res.json())
    expect(dto.name).toBe('Cinder Point')
    expect(dto.body).toBe('A basalt headland.')
    expect(dto.hasImage).toBe(false)

    const bad = await ctx.app.inject({ method: 'POST', url: url('/world'), payload: { name: '' } })
    expectEnvelope(bad, 400, 'validation')
  })

  it('PATCH /world/:e updates fields; stale baseHash on body replace 409s', async () => {
    const entry = WorldEntryDto.parse(
      (await ctx.app.inject({ method: 'GET', url: url(`/world/${FIX.mara}`) })).json(),
    )
    const ok = await ctx.app.inject({
      method: 'PATCH',
      url: url(`/world/${FIX.mara}`),
      payload: {
        body: 'Mara Voss, keeper for twelve years now.',
        baseHash: await xxh64OfString(entry.body),
      },
    })
    expect(ok.statusCode).toBe(200)
    expect(WorldEntryDto.parse(ok.json()).body).toBe('Mara Voss, keeper for twelve years now.')

    const stale = await ctx.app.inject({
      method: 'PATCH',
      url: url(`/world/${FIX.mara}`),
      payload: { body: 'Lost update.', baseHash: await xxh64OfString(entry.body) },
    })
    const details = expectEnvelope(stale, 409, 'conflict') as { currentText: string }
    expect(details.currentText).toBe('Mara Voss, keeper for twelve years now.')
  })

  it('DELETE /world/:e removes the entry and its image; 404 for unknown ids', async () => {
    const res = await ctx.app.inject({ method: 'DELETE', url: url(`/world/${FIX.mara}`) })
    expect(res.statusCode).toBe(204)
    const list = z
      .array(WorldEntryDto)
      .parse((await ctx.app.inject({ method: 'GET', url: url('/world') })).json())
    expect(list.map((e) => e.id)).toEqual([FIX.glass])

    const missing = await ctx.app.inject({ method: 'DELETE', url: url(`/world/${NO_SUCH_ID}`) })
    expectEnvelope(missing, 404, 'not_found')
  })

  it('POST /world/:e/image uploads a raw PNG; garbage bytes 400', async () => {
    const png = makePng(32, 16)
    const res = await ctx.app.inject({
      method: 'POST',
      url: url(`/world/${FIX.glass}/image`),
      headers: { 'content-type': 'image/png' },
      payload: png,
    })
    expect(res.statusCode).toBe(200)
    const { imageVersion } = z.object({ imageVersion: z.string() }).parse(res.json())
    expect(imageVersion).toMatch(/^xxh64:[0-9a-f]{16}$/)
    const entry = WorldEntryDto.parse(
      (await ctx.app.inject({ method: 'GET', url: url(`/world/${FIX.glass}`) })).json(),
    )
    expect(entry.hasImage).toBe(true)
    expect(entry.imageVersion).toBe(imageVersion)

    const bad = await ctx.app.inject({
      method: 'POST',
      url: url(`/world/${FIX.glass}/image`),
      headers: { 'content-type': 'image/png' },
      payload: Buffer.from('not a png'),
    })
    expectEnvelope(bad, 400, 'validation')
  })

  it('DELETE /world/:e/image clears the image (idempotent); 404 for unknown entries', async () => {
    const res = await ctx.app.inject({ method: 'DELETE', url: url(`/world/${FIX.mara}/image`) })
    expect(res.statusCode).toBe(204)
    const entry = WorldEntryDto.parse(
      (await ctx.app.inject({ method: 'GET', url: url(`/world/${FIX.mara}`) })).json(),
    )
    expect(entry.hasImage).toBe(false)
    expect(entry.imageVersion).toBeNull()
    const image = await ctx.app.inject({ method: 'GET', url: url(`/world/${FIX.mara}/image`) })
    expectEnvelope(image, 404, 'not_found')

    // idempotent: a second delete of the (now imageless) entry is still 204
    const again = await ctx.app.inject({ method: 'DELETE', url: url(`/world/${FIX.mara}/image`) })
    expect(again.statusCode).toBe(204)

    const missing = await ctx.app.inject({
      method: 'DELETE',
      url: url(`/world/${NO_SUCH_ID}/image`),
    })
    expectEnvelope(missing, 404, 'not_found')
  })
})

// ---------------------------------------------------------------------------
// §3.6 situation
// ---------------------------------------------------------------------------

describe('situation', () => {
  it('GET /situation returns the scratchpad ({text, updatedAt, hash})', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: url('/situation') })
    expect(res.statusCode).toBe(200)
    const dto = SituationDto.parse(res.json())
    expect(dto.text).toBe(SITUATION_TEXT)
    expect(dto.hash).toBe(situationHash)
  })

  it('GET /situation 404s for an unknown work', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: `/api/works/${NO_SUCH_ID}/situation` })
    expectEnvelope(res, 404, 'not_found')
  })

  it('PUT /situation replaces at the right baseHash; null works on a fresh work', async () => {
    const fresh = await createWorkViaApi(ctx, 'Blank Slate')
    const first = await ctx.app.inject({
      method: 'PUT',
      url: `/api/works/${fresh.id}/situation`,
      payload: { text: 'Opening notes.', baseHash: null },
    })
    expect(first.statusCode).toBe(200)
    SituationPutRes.parse(first.json())
  })

  it('PUT /situation with a stale baseHash 409s with the theirs/mine payload', async () => {
    const ok = await ctx.app.inject({
      method: 'PUT',
      url: url('/situation'),
      payload: { text: 'Mine: storm has landed.', baseHash: situationHash },
    })
    expect(ok.statusCode).toBe(200)
    const put = SituationPutRes.parse(ok.json())

    // second writer still holds the original hash — its PUT must NOT clobber silently
    const stale = await ctx.app.inject({
      method: 'PUT',
      url: url('/situation'),
      payload: { text: 'Theirs: storm passed by.', baseHash: situationHash },
    })
    const details = expectEnvelope(stale, 409, 'conflict') as {
      currentText: string
      currentHash: string
    }
    expect(details.currentText).toBe('Mine: storm has landed.')
    expect(details.currentHash).toBe(put.hash)
    // the winning text survived
    const dto = SituationDto.parse(
      (await ctx.app.inject({ method: 'GET', url: url('/situation') })).json(),
    )
    expect(dto.text).toBe('Mine: storm has landed.')
  })
})

// ---------------------------------------------------------------------------
// §3.10 images
// ---------------------------------------------------------------------------

describe('images', () => {
  it('GET /sections/:s/illustration streams the PNG with immutable caching + ETag', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: url(`/sections/${FIX.sec1}/illustration`),
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('image/png')
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable')
    expect(res.headers.etag).toMatch(/^"xxh64:[0-9a-f]{16}"$/)
    expect(res.rawPayload.subarray(1, 4).toString('ascii')).toBe('PNG')

    const conditional = await ctx.app.inject({
      method: 'GET',
      url: url(`/sections/${FIX.sec1}/illustration`),
      headers: { 'if-none-match': String(res.headers.etag) },
    })
    expect(conditional.statusCode).toBe(304)
  })

  it('GET /sections/:s/illustration 404s when suppressed and for unknown sections', async () => {
    const suppressed = await ctx.app.inject({
      method: 'GET',
      url: url(`/sections/${FIX.sec2}/illustration`),
    })
    expectEnvelope(suppressed, 404, 'not_found')
    const missing = await ctx.app.inject({
      method: 'GET',
      url: url(`/sections/${NO_SUCH_ID}/illustration`),
    })
    expectEnvelope(missing, 404, 'not_found')
  })

  it('POST /sections/:s/illustration uploads over a tombstone; garbage 400s', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: url(`/sections/${FIX.sec2}/illustration`),
      headers: { 'content-type': 'image/png' },
      payload: makePng(800, 600),
    })
    expect(res.statusCode).toBe(200)
    const { illustrationVersion } = z.object({ illustrationVersion: z.string() }).parse(res.json())
    expect(illustrationVersion).toMatch(/^xxh64:[0-9a-f]{16}$/)
    const streamed = await ctx.app.inject({
      method: 'GET',
      url: url(`/sections/${FIX.sec2}/illustration?v=${illustrationVersion}`),
    })
    expect(streamed.statusCode).toBe(200)
    // the fresh SectionRow carries the version + dims
    const rows = z
      .array(SectionRow)
      .parse((await ctx.app.inject({ method: 'GET', url: url('/sections') })).json())
    const sec2 = rows.find((r) => r.id === FIX.sec2)
    expect(sec2?.illustration).toEqual({ version: illustrationVersion, width: 800, height: 600 })

    const bad = await ctx.app.inject({
      method: 'POST',
      url: url(`/sections/${FIX.sec2}/illustration`),
      headers: { 'content-type': 'image/png' },
      payload: Buffer.from('nope'),
    })
    expectEnvelope(bad, 400, 'validation')
  })

  it('DELETE /sections/:s/illustration suppresses (idempotent); then GET 404s', async () => {
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: url(`/sections/${FIX.sec1}/illustration`),
    })
    expect(res.statusCode).toBe(204)
    const again = await ctx.app.inject({
      method: 'DELETE',
      url: url(`/sections/${FIX.sec1}/illustration`),
    })
    expect(again.statusCode).toBe(204)
    const streamed = await ctx.app.inject({
      method: 'GET',
      url: url(`/sections/${FIX.sec1}/illustration`),
    })
    expectEnvelope(streamed, 404, 'not_found')

    const missing = await ctx.app.inject({
      method: 'DELETE',
      url: url(`/sections/${NO_SUCH_ID}/illustration`),
    })
    expectEnvelope(missing, 404, 'not_found')
  })

  it('GET /world/:e/image streams; 404 when the entry has no image', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: url(`/world/${FIX.mara}/image`) })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('image/png')
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable')

    const none = await ctx.app.inject({ method: 'GET', url: url(`/world/${FIX.glass}/image`) })
    expectEnvelope(none, 404, 'not_found')
  })

  it('404s a world image whose path escapes the work dir (containment)', async () => {
    const evilId = '01J2KFEV000000000000000000'
    const open = await ctx.works.open(workId)
    await fsp.writeFile(
      path.join(
        open.handle.workDir,
        'world',
        'entries',
        `evil.${evilId.slice(-6).toLowerCase()}.md`,
      ),
      worldEntryFileText(
        {
          id: evilId,
          name: 'Evil Entry',
          keys: [],
          image: '../../../../outside-the-work.png',
          shortSummary: null,
          createdBy: 'user',
          updatedAt: '2026-07-07T00:00:00Z',
        },
        'An entry pointing outside the work directory.\n',
      ),
    )
    await open.handle.reconcile() // adopt the external edit into the index
    const res = await ctx.app.inject({ method: 'GET', url: url(`/world/${evilId}/image`) })
    expectEnvelope(res, 404, 'not_found')
  })
})

// ---------------------------------------------------------------------------
// §4.1 readonly (second-instance lock)
// ---------------------------------------------------------------------------

describe('readonly work', () => {
  it('serves reads with readonly: true and 409s mutations', async () => {
    const created = await ctx.works.createWork('Locked Work')
    // A second in-process "instance" grabs the single-writer lock first.
    const other = createStorage(ctx.dataDir)
    const holder = await other.openWork(created.slug)
    try {
      const detail = WorkDetail.parse(
        (await ctx.app.inject({ method: 'GET', url: `/api/works/${created.meta.id}` })).json(),
      )
      expect(detail.readonly).toBe(true)

      const patch = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/works/${created.meta.id}`,
        payload: { title: 'Renamed Anyway' },
      })
      expectEnvelope(patch, 409, 'readonly')

      const post = await ctx.app.inject({
        method: 'POST',
        url: `/api/works/${created.meta.id}/snippets`,
        payload: { text: 'Should not land.' },
      })
      expectEnvelope(post, 409, 'readonly')
    } finally {
      await holder.close()
    }
  })
})
