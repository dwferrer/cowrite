import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readIfExists } from './lib/fsx.js'
import { lockPath } from './lib/paths.js'
import { type LockData, parseLockData, WorkLock } from './lock.js'

/**
 * Single-writer lock hardening (spec 02 §9.3): exclusive-create acquire (no
 * read-then-write TOCTOU), stale takeover, and refresh failures demoting to read-only
 * instead of crashing the process with an unhandled rejection.
 */

let workDir: string

beforeEach(async () => {
  workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cowrite-lock-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  // Windows under load: a just-released handle can hold the dir briefly — same retry
  // tolerance production cleanup paths use.
  await fsp.rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

/**
 * Acquire with the SAME churn tolerance production gets from its second `tryAcquire`
 * pass: on Windows under load, BOTH racers of a stale takeover can lose their unlink to
 * a transient EPERM twice in a row (acquire throws "lock churn") — a lost race, not a
 * failure, so retry briefly instead of flaking.
 */
async function acquireTolerant(
  dir: string,
  opts: Parameters<typeof WorkLock.acquire>[1] = {},
): Promise<Awaited<ReturnType<typeof WorkLock.acquire>>> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await WorkLock.acquire(dir, opts)
    } catch (err) {
      if (attempt >= 5 || !/lock churn/.test(String(err))) throw err
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
}

function staleLockData(): LockData {
  return {
    pid: process.pid,
    hostname: os.hostname(),
    nonce: 'STALENONCE0000000000000000',
    acquiredAt: new Date(Date.now() - 10 * 60_000).toISOString(), // way past staleAfterMs
  }
}

describe('WorkLock.acquire (§9.3)', () => {
  it('acquires a free lock and loses to a live one', async () => {
    const first = await WorkLock.acquire(workDir)
    expect(first.acquired).toBe(true)
    if (!first.acquired) throw new Error('unreachable')

    const second = await WorkLock.acquire(workDir)
    expect(second.acquired).toBe(false)
    if (second.acquired) throw new Error('unreachable')
    expect(second.holder.nonce).toBe(first.lock.nonce)
    await first.lock.release()
    expect(await readIfExists(lockPath(workDir))).toBeNull()
  })

  it('takes over a stale lock', async () => {
    await fsp.mkdir(path.dirname(lockPath(workDir)), { recursive: true })
    await fsp.writeFile(lockPath(workDir), JSON.stringify(staleLockData()))
    const result = await WorkLock.acquire(workDir)
    expect(result.acquired).toBe(true)
    if (result.acquired) await result.lock.release()
  })

  it('two concurrent acquires on the same path: exactly one wins (TOCTOU regression)', async () => {
    // Both racers read "no lock" before either writes; the exclusive wx create decides.
    const results = await Promise.all([WorkLock.acquire(workDir), WorkLock.acquire(workDir)])
    const winners = results.filter((r) => r.acquired)
    expect(winners).toHaveLength(1)

    const winner = winners[0]
    if (winner === undefined || !winner.acquired) throw new Error('unreachable')
    // the on-disk lock carries the winner's nonce, and the loser reported that holder
    const onDisk = parseLockData(await readIfExists(lockPath(workDir)))
    expect(onDisk?.nonce).toBe(winner.lock.nonce)
    const loser = results.find((r) => !r.acquired)
    if (loser === undefined || loser.acquired) throw new Error('unreachable')
    expect(loser.holder.nonce).toBe(winner.lock.nonce)
    await winner.lock.release()
  })

  it('two concurrent stale takeovers: exactly one wins', async () => {
    await fsp.mkdir(path.dirname(lockPath(workDir)), { recursive: true })
    await fsp.writeFile(lockPath(workDir), JSON.stringify(staleLockData()))
    const results = await Promise.all([acquireTolerant(workDir), acquireTolerant(workDir)])
    expect(results.filter((r) => r.acquired)).toHaveLength(1)
    for (const r of results) {
      if (r.acquired) await r.lock.release()
    }
  })

  it('a SLOW second stale takeover cannot delete the winner’s fresh lock (unlink race)', async () => {
    // The load-induced interleaving, made deterministic: both racers read the stale
    // lock, racer 1 takes over (unlink + create) at full speed, racer 2's unlink is
    // delayed until AFTER the winner's lock exists. Without the in-process acquire
    // queue, that late unlink deletes the WINNER's fresh lock and both racers return
    // acquired:true — a single-writer violation.
    await fsp.mkdir(path.dirname(lockPath(workDir)), { recursive: true })
    await fsp.writeFile(lockPath(workDir), JSON.stringify(staleLockData()))

    const realUnlink = fsp.unlink.bind(fsp)
    let lockUnlinks = 0
    vi.spyOn(fsp, 'unlink').mockImplementation(async (target) => {
      if (String(target) === lockPath(workDir)) {
        lockUnlinks += 1
        if (lockUnlinks > 1) {
          // the slow racer: its takeover lands well after the winner acquired
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
      }
      return realUnlink(target)
    })

    const results = await Promise.all([acquireTolerant(workDir), acquireTolerant(workDir)])
    expect(results.filter((r) => r.acquired)).toHaveLength(1)
    // the winner's lock is still on disk and still carries the winner's nonce
    const winner = results.find((r) => r.acquired)
    if (winner === undefined || !winner.acquired) throw new Error('unreachable')
    const onDisk = parseLockData(await readIfExists(lockPath(workDir)))
    expect(onDisk?.nonce).toBe(winner.lock.nonce)
    await winner.lock.release()
  })
})

describe('refresh failures demote instead of crashing (§9.3)', () => {
  it('a rejecting refresh stands the lock down: no unhandledRejection, revalidate fails closed', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    let stoodDown = false
    const result = await WorkLock.acquire(workDir, {
      refreshMs: 20,
      onStandDown: () => {
        stoodDown = true
      },
    })
    expect(result.acquired).toBe(true)
    if (!result.acquired) throw new Error('unreachable')
    const lock = result.lock

    try {
      // Make every refresh read/write fail: the lock path becomes a directory.
      // (retry: a racing refresh may recreate the file between unlink and mkdir)
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          await fsp.rm(lockPath(workDir), { force: true })
          await fsp.mkdir(lockPath(workDir))
          break
        } catch {
          // recreated under us — try again
        }
      }

      const deadline = Date.now() + 2_000
      while (!stoodDown && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(stoodDown).toBe(true)
      expect(lock.isValid).toBe(false)
      // fail closed: every write-batch guard now reports "not ours"
      expect(await lock.revalidateNonce()).toBe(false)
      expect(consoleError).toHaveBeenCalled()

      // let any in-flight rejection settle before asserting none escaped
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
      await lock.release().catch(() => {})
    }
  })
})
