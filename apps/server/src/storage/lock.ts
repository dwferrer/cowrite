import fsp from 'node:fs/promises'
import os from 'node:os'
import { ulid } from 'ulid'
import { ensureDir, readIfExists, writeFileAtomic } from './lib/fsx.js'
import { cowriteDir, lockPath } from './lib/paths.js'

/**
 * The single-writer advisory lock (spec 02 §9.3): `.cowrite/lock` holds
 * `{pid, hostname, nonce, acquiredAt}`, refreshed every 30 s by rewriting the file with a
 * fresh `acquiredAt` (so "age" is always now − acquiredAt, no mtime dependence). A second
 * instance seeing a live lock opens read-only. Hardening rules implemented here:
 *
 * - **Stale detection**: a lock is stale when it is > 2 min old OR its pid is not alive
 *   on the same host (crash-restart reclaims its own work immediately).
 * - **Nonce re-validation**: `revalidateNonce()` re-reads the lock before every write
 *   batch; a foreign nonce means another instance legitimately took over while we slept —
 *   the caller drops to read-only.
 * - **Clock-jump detection**: when now − lastRefresh > 2× the refresh interval (the
 *   process was suspended), both the refresh timer and `revalidateNonce()` treat the
 *   on-disk lock as potentially foreign: the nonce is verified against the file before
 *   anything is rewritten, so a resumed process stands down instead of clobbering.
 */

export const LOCK_REFRESH_MS = 30_000
export const LOCK_STALE_AFTER_MS = 120_000

export interface LockData {
  pid: number
  hostname: string
  nonce: string
  acquiredAt: string
}

export interface LockOptions {
  /** Refresh-timer interval; default 30 s (§9.3). Tests inject smaller values. */
  refreshMs?: number
  /** Age beyond which a lock is stale; default 2 min (§9.3). */
  staleAfterMs?: number
  /** Invoked once if the lock discovers a foreign nonce (another writer took over). */
  onStandDown?: () => void
}

/** Parse lock-file contents; null for missing or malformed data (malformed ⇒ stale). */
export function parseLockData(raw: string | null): LockData | null {
  if (raw === null) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const data = value as Record<string, unknown>
  if (
    typeof data.pid !== 'number' ||
    typeof data.hostname !== 'string' ||
    typeof data.nonce !== 'string' ||
    typeof data.acquiredAt !== 'string'
  ) {
    return null
  }
  return {
    pid: data.pid,
    hostname: data.hostname,
    nonce: data.nonce,
    acquiredAt: data.acquiredAt,
  }
}

/** signal-0 liveness probe; EPERM means "alive but not ours", which still counts alive. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * §9.3 staleness: age > `staleAfterMs`, OR the pid is dead on the same host. An
 * unparseable `acquiredAt` counts stale (a live writer refreshes with valid timestamps).
 */
export function isLockStale(
  data: LockData,
  opts: { nowMs?: number; staleAfterMs?: number; hostname?: string } = {},
): boolean {
  const nowMs = opts.nowMs ?? Date.now()
  const staleAfterMs = opts.staleAfterMs ?? LOCK_STALE_AFTER_MS
  const ageMs = nowMs - Date.parse(data.acquiredAt)
  if (!Number.isFinite(ageMs) || ageMs > staleAfterMs) return true
  const hostname = opts.hostname ?? os.hostname()
  return data.hostname === hostname && !pidAlive(data.pid)
}

export type AcquireLockResult =
  | { acquired: true; lock: WorkLock }
  | { acquired: false; holder: LockData }

export class WorkLock {
  readonly nonce: string
  private readonly filePath: string
  private readonly refreshMs: number
  private readonly onStandDown: (() => void) | undefined
  private timer: NodeJS.Timeout | null = null
  private lastRefreshMs: number
  private valid = true

  private constructor(filePath: string, opts: LockOptions) {
    this.filePath = filePath
    this.refreshMs = opts.refreshMs ?? LOCK_REFRESH_MS
    this.onStandDown = opts.onStandDown
    this.nonce = ulid()
    this.lastRefreshMs = Date.now()
  }

  /**
   * Try to take the lock for this process. An existing live lock loses the race
   * (`acquired: false` with the holder — the caller opens read-only, §9.3); a stale,
   * missing, or malformed lock is taken over.
   *
   * Race-hardened (no read-then-blind-write TOCTOU): the lock file is created with an
   * exclusive `wx` open, so of two simultaneous acquirers exactly one wins the create;
   * the loser re-reads the holder. A stale takeover unlinks the dead holder's file
   * first, then `wx`-creates — losing that create retries the whole acquire once. A
   * post-create read-back verifies our nonce before returning `acquired: true`, which
   * also covers rename-based writers (a live holder's atomic refresh) racing the create.
   *
   * Same-PROCESS acquires on one path additionally serialize on an in-process queue: a
   * process must never race itself for a work lock — a stale-takeover `unlink` has no
   * "only if still stale" guard, so a slow sibling acquirer could delete the winner's
   * freshly created lock and both would return `acquired: true` (the concurrent-stale-
   * takeover regression in lock.test.ts). Cross-process, that window is closed by the
   * §9.3 nonce re-validation before every write batch.
   */
  static async acquire(workDirPath: string, opts: LockOptions = {}): Promise<AcquireLockResult> {
    return WorkLock.serializeByPath(lockPath(workDirPath), async () => {
      const first = await WorkLock.tryAcquire(workDirPath, opts)
      if (first !== null) return first
      const second = await WorkLock.tryAcquire(workDirPath, opts)
      if (second !== null) return second
      throw new Error(
        `could not acquire or identify the holder of ${lockPath(workDirPath)} (lock churn)`,
      )
    })
  }

  /** In-process acquire queue per lock path (see `acquire`); entries clean up at idle. */
  private static readonly acquireQueues = new Map<string, Promise<void>>()

  private static serializeByPath<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = WorkLock.acquireQueues.get(key) ?? Promise.resolve()
    const run = previous.then(fn)
    const tail = run.then(
      () => undefined,
      () => undefined,
    )
    WorkLock.acquireQueues.set(key, tail)
    void tail.then(() => {
      if (WorkLock.acquireQueues.get(key) === tail) WorkLock.acquireQueues.delete(key)
    })
    return run
  }

  /** One acquire attempt; null = lost a create race in a way worth retrying once. */
  private static async tryAcquire(
    workDirPath: string,
    opts: LockOptions,
  ): Promise<AcquireLockResult | null> {
    await ensureDir(cowriteDir(workDirPath))
    const filePath = lockPath(workDirPath)
    const existing = parseLockData(await readIfExists(filePath))
    if (existing !== null && !isLockStale(existing, { staleAfterMs: opts.staleAfterMs })) {
      return { acquired: false, holder: existing }
    }
    if (existing !== null) {
      // Stale takeover: clear the dead holder's file so the exclusive create can win.
      try {
        await fsp.unlink(filePath)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY') {
          // Windows: a concurrent acquirer momentarily holds the file open (its own
          // read or wx-create in flight) — a lost takeover race, not a failure.
          // acquire() retries once and re-runs the staleness check.
          return null
        }
        if (code !== 'ENOENT') throw err
      }
    }
    const lock = new WorkLock(filePath, opts)
    if (!(await lock.createExclusive(Date.now()))) {
      // EEXIST: somebody else created the file between our read and our create.
      if (existing !== null) return null // takeover race: re-run the staleness check
      const holder = parseLockData(await readIfExists(filePath))
      return holder === null ? null : { acquired: false, holder }
    }
    // Read-back: only the nonce on disk decides ownership (§9.3).
    const onDisk = parseLockData(await readIfExists(filePath))
    if (onDisk === null || onDisk.nonce !== lock.nonce) {
      return onDisk === null ? null : { acquired: false, holder: onDisk }
    }
    lock.startRefreshTimer()
    return { acquired: true, lock }
  }

  /** false once a foreign takeover was detected or the lock was released. */
  get isValid(): boolean {
    return this.valid
  }

  private data(nowMs: number): LockData {
    return {
      pid: process.pid,
      hostname: os.hostname(),
      nonce: this.nonce,
      acquiredAt: new Date(nowMs).toISOString(),
    }
  }

  private async write(nowMs: number): Promise<void> {
    await writeFileAtomic(this.filePath, `${JSON.stringify(this.data(nowMs), null, 2)}\n`)
    this.lastRefreshMs = nowMs
  }

  /** Exclusive `wx` create for acquire (§9.3 race hardening); false on EEXIST. */
  private async createExclusive(nowMs: number): Promise<boolean> {
    try {
      await fsp.writeFile(this.filePath, `${JSON.stringify(this.data(nowMs), null, 2)}\n`, {
        flag: 'wx',
      })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw err
    }
    this.lastRefreshMs = nowMs
    return true
  }

  /**
   * Start the §9.3 refresh interval. A rejected refresh (lock path unreadable, disk
   * error) must never surface as an unhandled rejection and crash the process: it is
   * caught here, logged once, and the lock stands down — revalidateNonce() then fails
   * closed, so every subsequent mutation throws ReadOnlyError. Recovery is simply
   * reopening the work.
   */
  private startRefreshTimer(): void {
    this.timer = setInterval(() => {
      this.refresh().catch((err) => {
        if (!this.valid) return
        console.error(
          `work lock refresh failed; demoting to read-only (reopen the work to recover): ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
        this.standDown()
      })
    }, this.refreshMs)
    this.timer.unref()
  }

  private standDown(): void {
    if (!this.valid) return
    this.valid = false
    this.stopTimer()
    this.onStandDown?.()
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /**
   * §9.3 nonce re-validation, called before every write batch: re-read the lock and
   * verify our own nonce. Returns false (⇒ caller drops to read-only) on a foreign
   * nonce. A *missing* lock file is not a takeover — deleting `.cowrite/` only loses
   * caches and an idle-time lock (§5.2) — so it is rewritten and the lock stays valid.
   * After a detected clock jump (> 2× refresh interval since the last refresh — the
   * process was suspended) a successful validation immediately rewrites the file to
   * restore the age window.
   */
  async revalidateNonce(): Promise<boolean> {
    if (!this.valid) return false
    const nowMs = Date.now()
    const clockJumped = nowMs - this.lastRefreshMs > 2 * this.refreshMs
    let onDisk: LockData | null
    try {
      onDisk = parseLockData(await readIfExists(this.filePath))
    } catch (err) {
      // The lock state cannot be verified (path unreadable, fs error): fail CLOSED —
      // stand down to read-only instead of writing blind (§9.3). Reopen to recover.
      console.error(
        `work lock is unreadable; demoting to read-only: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
      this.standDown()
      return false
    }
    if (onDisk !== null && onDisk.nonce !== this.nonce) {
      this.standDown()
      return false
    }
    if (onDisk === null || clockJumped) await this.write(nowMs)
    return true
  }

  /**
   * 30 s refresh: verify the nonce (never blind-clobber — a takeover during suspend must
   * win, §9.3), then rewrite with a fresh acquiredAt. Also runs the clock-jump check via
   * the shared re-validation path.
   */
  async refresh(): Promise<boolean> {
    return this.revalidateNonce().then(async (ok) => {
      if (!ok) return false
      await this.write(Date.now())
      return true
    })
  }

  /** Stop refreshing and delete the lock file iff it still carries our nonce. */
  async release(): Promise<void> {
    this.stopTimer()
    if (!this.valid) return
    this.valid = false
    let onDisk: LockData | null = null
    try {
      onDisk = parseLockData(await readIfExists(this.filePath))
    } catch {
      return // unreadable lock path: leave it; staleness reclaims it later (§9.3)
    }
    if (onDisk?.nonce === this.nonce) {
      await fsp.unlink(this.filePath).catch(() => {})
    }
  }
}
