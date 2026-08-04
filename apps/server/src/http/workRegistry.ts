import { attachStorageAdapter, type StorageAdapter } from '../events/adapter.js'
import { WorkEventBus, type WorkEventBusOptions } from '../events/bus.js'
import type { StorageService, WorkHandle } from '../storage/service.js'
import type { CreatedWork } from '../storage/workStore.js'
import { AppError } from './errors.js'

/**
 * The work lifecycle manager (docs/03-api.md §4): "a work is open while it has ≥ 1 SSE
 * subscriber", with SSE presence as the only observable.
 *
 * - id ⇄ slug resolution: URLs carry the work's ULID; directories are slugs. The map is
 *   built by scanning `listWorks`, cached, and invalidated on create/delete (plus one
 *   rescan on a miss, so externally-added works resolve without a restart).
 * - Lazy open on first `/api/works/:w/*` touch: acquire the lock (read-only when held by
 *   a live process elsewhere), open the index, run the reconciler (storage does all of
 *   this in `openWork`), mint the per-open `EventBus`, and wire the storage→SSE adapter.
 * - A 30 s reconcile timer runs while the work has ≥ 1 SSE subscriber (§4.1).
 * - Close after 5 minutes at zero subscribers, or on shutdown (§4.2). The editing signal
 *   is cleared the moment the subscriber count drops to zero, so a vanished tab can
 *   never pin consolidation.
 * - DELETE teardown ordering (§4.3, load-bearing on Windows): stop timers → end the SSE
 *   stream (final comment frame) → close the handle (index + lock released) → only then
 *   `storage.trashWork` renames the directory into `.trash/`.
 * - `readonly.changed` rides the lock's `onStandDown` hook (02 §9.3 nonce takeover).
 */

export interface WorkRegistryOptions {
  /** §4.1 reconcile cadence while subscribed (default 30 s). */
  reconcileIntervalMs?: number
  /** §4.2 idle-close delay at zero subscribers (default 5 min). */
  idleCloseMs?: number
  /** Bus tuning passthrough (tests). */
  bus?: WorkEventBusOptions
  onError?: (context: string, err: unknown) => void
}

export interface OpenWork {
  id: string
  slug: string
  handle: WorkHandle
  bus: WorkEventBus
  /**
   * Register a per-open resource teardown (engine close, in-flight append settlement).
   * Runs — and is awaited — during the §4.2 close path AFTER the close hooks but BEFORE
   * `handle.close()` and any directory rename, so a DELETE cannot EPERM on Windows while
   * a resource still has appends in flight (03 §4.3 ordering).
   */
  addCloseResource(teardown: () => void | Promise<void>): void
}

interface WorkState extends OpenWork {
  adapter: StorageAdapter
  subscribers: number
  reconcileTimer: NodeJS.Timeout | null
  idleCloseTimer: NodeJS.Timeout | null
  closing: boolean
  closeResources: Array<() => void | Promise<void>>
  /** Set the moment `closing` flips true — awaited by delete/close racing the teardown. */
  closePromise: Promise<void> | null
}

const RECONCILE_MS = 30_000
const IDLE_CLOSE_MS = 300_000

export class WorkRegistry {
  private readonly storage: StorageService
  private readonly reconcileIntervalMs: number
  private readonly idleCloseMs: number
  private readonly busOptions: WorkEventBusOptions
  private readonly onError: (context: string, err: unknown) => void

  private readonly states = new Map<string, WorkState>() // keyed by slug
  private readonly opening = new Map<string, Promise<OpenWork>>()
  private readonly closeHooks = new Set<(open: OpenWork) => void | Promise<void>>()
  private readonly openHooks = new Set<(open: OpenWork) => void>()
  private idToSlug: Map<string, string> | null = null

  constructor(storage: StorageService, options: WorkRegistryOptions = {}) {
    this.storage = storage
    this.reconcileIntervalMs = options.reconcileIntervalMs ?? RECONCILE_MS
    this.idleCloseMs = options.idleCloseMs ?? IDLE_CLOSE_MS
    this.busOptions = options.bus ?? {}
    this.onError =
      options.onError ??
      ((context, err) => {
        console.error(`[cowrite] ${context}:`, err)
      })
  }

  get openCount(): number {
    return this.states.size
  }

  /**
   * Register a work-close hook, run at the START of the §4.2 close path — before the
   * SSE stream ends and the handle closes, so the hook can still publish final events
   * and write through storage. The harness uses this to cancel a closing work's lanes
   * (05 §6.2 work close; skip-boundary-on-close is Stage 4's note). Hook errors are
   * reported via `onError`, never abort the close.
   */
  onClose(hook: (open: OpenWork) => void | Promise<void>): () => void {
    this.closeHooks.add(hook)
    return () => {
      this.closeHooks.delete(hook)
    }
  }

  /**
   * Register a work-open hook, run synchronously as each work finishes opening — the
   * harness uses it to install the bus's attach-time task-state provider (03 §8.3), so
   * a fresh SSE connection hydrates without a pre-fetch. Hook errors are reported via
   * `onError`, never abort the open.
   */
  onOpen(hook: (open: OpenWork) => void): () => void {
    this.openHooks.add(hook)
    return () => {
      this.openHooks.delete(hook)
    }
  }

  /** Drop the id⇄slug cache; next resolve rescans. Called on create/delete. */
  invalidateResolution(): void {
    this.idToSlug = null
  }

  /** Resolve a work ULID from a URL to its directory slug; 404 when unknown. */
  async resolveSlug(workId: string): Promise<string> {
    const cached = this.idToSlug?.get(workId)
    if (cached !== undefined) return cached
    const map = new Map<string, string>()
    for (const listing of await this.storage.listWorks()) {
      if (listing.ok) map.set(listing.meta.id, listing.slug)
    }
    this.idToSlug = map
    const slug = map.get(workId)
    if (slug === undefined) throw new AppError('not_found', `no work '${workId}'`)
    return slug
  }

  /** Lazy open on first touch (§4.1); concurrent opens of one work are deduped. */
  async open(workId: string): Promise<OpenWork> {
    const slug = await this.resolveSlug(workId)
    const state = this.states.get(slug)
    if (state !== undefined) {
      if (state.closing) throw new AppError('conflict', `work '${slug}' is closing`)
      // Every REST touch counts as activity: without this, a REST-only client (no SSE
      // subscriber) would be closed mid-conversation at exactly the 5-minute mark.
      if (state.subscribers === 0) this.scheduleIdleClose(state)
      return state
    }
    const pending = this.opening.get(slug)
    if (pending !== undefined) return pending
    const openPromise = this.openFresh(slug).finally(() => {
      this.opening.delete(slug)
    })
    this.opening.set(slug, openPromise)
    return openPromise
  }

  private async openFresh(slug: string): Promise<OpenWork> {
    const bus = new WorkEventBus(this.busOptions)
    const handle = await this.storage.openWork(slug, {
      lock: {
        onStandDown: () => {
          // §9.3 nonce takeover: the handle just went read-only under us.
          bus.publish({
            type: 'readonly.changed',
            readonly: true,
            reason: 'the work lock was taken over by another instance',
          })
        },
      },
    })
    const adapter = attachStorageAdapter(handle, bus, {
      onError: (err) => this.onError(`event adapter for '${slug}'`, err),
    })
    const closeResources: Array<() => void | Promise<void>> = []
    const state: WorkState = {
      id: handle.work.id,
      slug,
      handle,
      bus,
      adapter,
      subscribers: 0,
      reconcileTimer: null,
      idleCloseTimer: null,
      closing: false,
      closeResources,
      closePromise: null,
      addCloseResource: (teardown) => {
        closeResources.push(teardown)
      },
    }
    this.states.set(slug, state)
    for (const hook of [...this.openHooks]) {
      try {
        hook(state)
      } catch (err) {
        this.onError(`open hook for '${slug}'`, err)
      }
    }
    this.scheduleIdleClose(state)
    return state
  }

  /** An SSE subscriber connected (§4.1): cancel idle close, run the reconcile timer. */
  retain(slug: string): void {
    const state = this.states.get(slug)
    if (state === undefined || state.closing) return
    state.subscribers += 1
    if (state.idleCloseTimer !== null) {
      clearTimeout(state.idleCloseTimer)
      state.idleCloseTimer = null
    }
    if (state.subscribers === 1 && state.reconcileTimer === null) {
      state.reconcileTimer = setInterval(() => {
        if (state.handle.readOnly) return
        state.handle.reconcile().catch((err) => this.onError(`reconcile timer for '${slug}'`, err))
      }, this.reconcileIntervalMs)
      state.reconcileTimer.unref?.()
    }
  }

  /** An SSE subscriber disconnected (§4.2). At zero: stop reconciling, clear the editing
   *  signal (a vanished tab must not pin consolidation), start the idle-close clock. */
  release(slug: string): void {
    const state = this.states.get(slug)
    if (state === undefined) return
    state.subscribers = Math.max(0, state.subscribers - 1)
    if (state.subscribers > 0) return
    if (state.reconcileTimer !== null) {
      clearInterval(state.reconcileTimer)
      state.reconcileTimer = null
    }
    state.handle.setEditingSnippet(null)
    if (!state.closing) this.scheduleIdleClose(state)
  }

  private scheduleIdleClose(state: WorkState): void {
    if (state.idleCloseTimer !== null) clearTimeout(state.idleCloseTimer)
    state.idleCloseTimer = setTimeout(() => {
      state.idleCloseTimer = null
      this.closeWork(state.slug).catch((err) => this.onError(`idle close of '${state.slug}'`, err))
    }, this.idleCloseMs)
    state.idleCloseTimer.unref?.()
  }

  /**
   * §4.2 close: stop timers, detach the adapter, end the stream (final comment frame),
   * close the handle (index + lock released). Awaits any in-flight first-touch open of
   * the same slug first, so a close racing an open can never leave a ghost state behind;
   * a close already in progress is awaited, never skipped.
   */
  async closeWork(slug: string): Promise<void> {
    const pending = this.opening.get(slug)
    if (pending !== undefined) await pending.catch(() => {})
    const state = this.states.get(slug)
    if (state === undefined) return
    if (state.closing) {
      await state.closePromise
      return
    }
    state.closing = true
    state.closePromise = (async () => {
      if (state.reconcileTimer !== null) {
        clearInterval(state.reconcileTimer)
        state.reconcileTimer = null
      }
      if (state.idleCloseTimer !== null) {
        clearTimeout(state.idleCloseTimer)
        state.idleCloseTimer = null
      }
      // Close hooks first (harness lane cancellation): the bus is still live, so final
      // task events publish, and the handle is still open for run-file finalization.
      for (const hook of [...this.closeHooks]) {
        try {
          await hook(state)
        } catch (err) {
          this.onError(`close hook for '${slug}'`, err)
        }
      }
      // Per-open resources next (context engine, other appenders): their teardown must
      // settle in-flight file appends BEFORE handle.close()/any rename — Windows EPERMs
      // on directories with open handles (03 §4.3).
      for (const teardown of state.closeResources) {
        try {
          await teardown()
        } catch (err) {
          this.onError(`close resource for '${slug}'`, err)
        }
      }
      state.adapter.detach()
      await state.adapter.settled().catch(() => {})
      // End the SSE stream — no further events publish after this.
      state.bus.end()
      // Close the SQLite handle (WAL/SHM released) and release the lockfile.
      try {
        await state.handle.close()
      } finally {
        this.states.delete(slug)
      }
    })()
    await state.closePromise
  }

  /** §4.3 delete: full teardown BEFORE the `.trash` rename — ordering is load-bearing on
   *  Windows (renaming a directory with open handles fails). `closeWork` is the one
   *  implementation of that teardown; it also awaits in-flight opens and closes. */
  async deleteWork(workId: string): Promise<void> {
    const slug = await this.resolveSlug(workId)
    await this.closeWork(slug)
    // Only now: rename the work dir into <dataDir>/.trash/.
    await this.storage.trashWork(slug)
    this.idToSlug?.delete(workId)
  }

  async createWork(title: string): Promise<CreatedWork> {
    const created = await this.storage.createWork(title)
    this.idToSlug?.set(created.meta.id, created.slug)
    return created
  }

  /** Server shutdown (§4.2): run the close path for every open work. */
  async closeAll(): Promise<void> {
    const slugs = [...this.states.keys()]
    await Promise.all(
      slugs.map((slug) =>
        this.closeWork(slug).catch((err) => this.onError(`shutdown close of '${slug}'`, err)),
      ),
    )
  }
}
