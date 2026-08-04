import type { WorkMeta } from '@cowrite/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StorageService, WorkHandle } from '../storage/service.js'
import type { TrashedWork } from '../storage/workStore.js'
import { AppError } from './errors.js'
import { WorkRegistry } from './workRegistry.js'

/**
 * Work lifecycle (docs/03-api.md §4) against an injected fake storage service: lazy open,
 * idle close, reconcile cadence, editing-signal clearing, delete teardown ordering, and
 * the readonly.changed stand-down hook.
 */

const WORK_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const SLUG = 'salt-and-signal'

interface Fake {
  service: StorageService
  calls: string[]
  openCalls: number
  trashed: boolean
  standDown: (() => void) | null
  /** Test hooks: block storage.openWork / handle.close until released. */
  openDelay: (() => Promise<void>) | null
  closeDelay: (() => Promise<void>) | null
}

function makeFake(): Fake {
  const fake: Fake = {
    calls: [],
    openCalls: 0,
    trashed: false,
    standDown: null,
    openDelay: null,
    closeDelay: null,
    service: {
      listWorks: async () =>
        fake.trashed
          ? []
          : [
              {
                slug: SLUG,
                ok: true,
                meta: { id: WORK_ID, title: 'Salt and Signal' } as WorkMeta,
                counts: null,
              },
            ],
      createWork: () => {
        throw new Error('not used')
      },
      trashWork: async (slug) => {
        fake.calls.push(`trashWork:${slug}`)
        fake.trashed = true
        return {} as TrashedWork
      },
      openWork: async (slug, opts) => {
        fake.openCalls += 1
        fake.standDown = opts?.lock?.onStandDown ?? null
        if (fake.openDelay !== null) await fake.openDelay()
        const handle = {
          slug,
          workDir: `/fake/${slug}`,
          work: { id: WORK_ID, title: 'Salt and Signal', levelScheme: ['chapter'] },
          readOnly: false,
          lastReconcileAt: null,
          onChange: () => () => {},
          setEditingSnippet: (id: string | null) => {
            fake.calls.push(`editing:${id}`)
          },
          reconcile: async () => {
            fake.calls.push('reconcile')
            return {}
          },
          close: async () => {
            if (fake.closeDelay !== null) await fake.closeDelay()
            fake.calls.push('handle.close')
          },
        }
        return handle as unknown as WorkHandle
      },
    },
  }
  return fake
}

let fake: Fake
let registry: WorkRegistry

beforeEach(() => {
  vi.useFakeTimers()
  fake = makeFake()
  registry = new WorkRegistry(fake.service, {
    onError: (context, err) => {
      throw new Error(`${context}: ${err}`)
    },
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('WorkRegistry', () => {
  it('resolves a work ULID to its slug and 404s an unknown id', async () => {
    await expect(registry.resolveSlug(WORK_ID)).resolves.toBe(SLUG)
    const err = await registry.resolveSlug('01BX5ZZKBKACTAV9WEVGEMMVS0').catch((e) => e)
    expect(err).toBeInstanceOf(AppError)
    expect((err as AppError).code).toBe('not_found')
  })

  it('opens lazily and dedupes concurrent opens', async () => {
    const [a, b] = await Promise.all([registry.open(WORK_ID), registry.open(WORK_ID)])
    expect(fake.openCalls).toBe(1)
    expect(a).toBe(b)
    expect(a.slug).toBe(SLUG)
    const again = await registry.open(WORK_ID)
    expect(again).toBe(a)
    expect(fake.openCalls).toBe(1)
    await registry.closeAll()
  })

  it('closes an untouched open work after 5 minutes at zero subscribers', async () => {
    await registry.open(WORK_ID)
    expect(registry.openCount).toBe(1)
    await vi.advanceTimersByTimeAsync(299_000)
    expect(registry.openCount).toBe(1)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(registry.openCount).toBe(0)
    expect(fake.calls).toContain('handle.close')
  })

  it('runs the 30 s reconcile timer only while subscribed', async () => {
    const open = await registry.open(WORK_ID)
    registry.retain(open.slug)
    await vi.advanceTimersByTimeAsync(90_500)
    expect(fake.calls.filter((c) => c === 'reconcile')).toHaveLength(3)

    registry.release(open.slug)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fake.calls.filter((c) => c === 'reconcile')).toHaveLength(3)
    await registry.closeAll()
  })

  it('a subscriber cancels idle close; dropping to zero clears editing and restarts it', async () => {
    const open = await registry.open(WORK_ID)
    registry.retain(open.slug)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(registry.openCount).toBe(1) // subscribed ⇒ never idle-closed

    registry.release(open.slug)
    // §3.4: the editing signal is cleared the moment the count hits zero
    expect(fake.calls).toContain('editing:null')
    await vi.advanceTimersByTimeAsync(301_000)
    expect(registry.openCount).toBe(0)
  })

  it('tears down in order on delete: SSE end → handle close → trash rename', async () => {
    const open = await registry.open(WORK_ID)
    registry.retain(open.slug)
    open.bus.attach({
      write: (chunk) => {
        if (chunk.startsWith(':closed')) fake.calls.push('sse.closed')
      },
      end: () => {},
    })

    await registry.deleteWork(WORK_ID)
    const order = fake.calls.filter((c) =>
      ['sse.closed', 'handle.close', `trashWork:${SLUG}`].includes(c),
    )
    expect(order).toEqual(['sse.closed', 'handle.close', `trashWork:${SLUG}`])
    expect(registry.openCount).toBe(0)

    // the id no longer resolves once deleted
    const err = await registry.open(WORK_ID).catch((e) => e)
    expect(err).toBeInstanceOf(AppError)
  })

  it('per-open close resources (a slow usage-append sink) settle BEFORE handle.close and the rename', async () => {
    // Windows EPERM regression (03 §4.3): DELETE during an in-flight engine usage append
    // must await the resource's teardown before the handle closes and the directory is
    // renamed into .trash — otherwise the rename hits a directory with open handles.
    const open = await registry.open(WORK_ID)
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    open.addCloseResource(async () => {
      fake.calls.push('resource:begin') // the "engine.close(): await usageTail" moment
      await gate
      fake.calls.push('resource:end')
    })

    const deletion = registry.deleteWork(WORK_ID)
    for (let i = 0; i < 10; i++) await Promise.resolve() // let close reach the resource
    expect(fake.calls).toContain('resource:begin')
    expect(fake.calls).not.toContain('handle.close') // blocked behind the slow sink

    release()
    await deletion
    const order = fake.calls.filter((c) =>
      ['resource:end', 'handle.close', `trashWork:${SLUG}`].includes(c),
    )
    expect(order).toEqual(['resource:end', 'handle.close', `trashWork:${SLUG}`])
  })

  it('onOpen hooks run as each work opens (attach-state provider wiring)', async () => {
    const seen: string[] = []
    registry.onOpen((openWork) => {
      seen.push(openWork.id)
    })
    await registry.open(WORK_ID)
    await registry.open(WORK_ID) // cached open: the hook does not re-fire
    expect(seen).toEqual([WORK_ID])
  })

  it('trashes a never-opened work without opening it first', async () => {
    await registry.deleteWork(WORK_ID)
    expect(fake.openCalls).toBe(0)
    expect(fake.calls).toEqual([`trashWork:${SLUG}`])
  })

  it('DELETE racing a first-touch open awaits the open, then tears down (no ghost state)', async () => {
    // Regression: deleteWork used to consult only `states`, so a DELETE arriving while
    // openFresh was still in flight trashed the dir under a live handle (EBUSY on
    // Windows) and left a ghost state behind once the open resolved.
    let releaseOpen: (() => void) | undefined
    fake.openDelay = () =>
      new Promise<void>((r) => {
        releaseOpen = r
      })
    const opening = registry.open(WORK_ID) // first touch — do not await
    while (releaseOpen === undefined) await Promise.resolve()
    const deleting = registry.deleteWork(WORK_ID)
    // give the delete a chance to run ahead: it must be parked on the in-flight open
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(fake.calls).not.toContain(`trashWork:${SLUG}`)
    releaseOpen?.()
    await Promise.all([opening, deleting])
    const order = fake.calls.filter((c) => ['handle.close', `trashWork:${SLUG}`].includes(c))
    expect(order).toEqual(['handle.close', `trashWork:${SLUG}`])
    expect(registry.openCount).toBe(0) // no ghost state survives
  })

  it('DELETE during an in-progress close awaits that close before trashing', async () => {
    await registry.open(WORK_ID)
    let releaseClose: (() => void) | undefined
    fake.closeDelay = () =>
      new Promise<void>((r) => {
        releaseClose = r
      })
    const closing = registry.closeWork(SLUG) // teardown starts; handle.close is blocked
    while (releaseClose === undefined) await Promise.resolve()
    const deleting = registry.deleteWork(WORK_ID)
    for (let i = 0; i < 10; i++) await Promise.resolve()
    // Regression: deleteWork used to SKIP teardown when closing was already true and
    // trashed immediately — under a still-open handle.
    expect(fake.calls).not.toContain(`trashWork:${SLUG}`)
    releaseClose?.()
    await Promise.all([closing, deleting])
    const order = fake.calls.filter((c) => ['handle.close', `trashWork:${SLUG}`].includes(c))
    expect(order).toEqual(['handle.close', `trashWork:${SLUG}`])
    expect(registry.openCount).toBe(0)
  })

  it('a REST-only touch at 4m59s defers the idle close (§4.2)', async () => {
    await registry.open(WORK_ID)
    await vi.advanceTimersByTimeAsync(299_000)
    await registry.open(WORK_ID) // REST touch, no SSE subscriber — resets the clock
    await vi.advanceTimersByTimeAsync(2_000) // 5m01s after the first open
    expect(registry.openCount).toBe(1) // regression: used to close mid-conversation here
    await vi.advanceTimersByTimeAsync(299_000) // 5m00s after the touch
    expect(registry.openCount).toBe(0)
  })

  it('publishes readonly.changed when the lock stands down', async () => {
    const open = await registry.open(WORK_ID)
    const chunks: string[] = []
    open.bus.attach({
      write: (chunk) => chunks.push(chunk),
      end: () => {},
    })
    fake.standDown?.()
    const joined = chunks.join('')
    expect(joined).toContain('event: readonly.changed')
    expect(joined).toContain('"readonly":true')
    await registry.closeAll()
  })

  it('mints a fresh streamId per open (§8.3: per open per process)', async () => {
    const first = await registry.open(WORK_ID)
    const firstStream = first.bus.streamId
    await registry.closeAll()
    const second = await registry.open(WORK_ID)
    expect(second.bus.streamId).not.toBe(firstStream)
    await registry.closeAll()
  })
})
