import { describe, expect, it } from 'vitest'
import { Mutex } from './mutex.js'

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('Mutex', () => {
  it('returns the task result', async () => {
    const mutex = new Mutex()
    expect(await mutex.runExclusive(() => 42)).toBe(42)
    expect(await mutex.runExclusive(async () => 'ok')).toBe('ok')
  })

  it('never overlaps two tasks', async () => {
    const mutex = new Mutex()
    let active = 0
    let maxActive = 0
    const task = async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await tick()
      await tick()
      active--
    }
    await Promise.all(Array.from({ length: 10 }, () => mutex.runExclusive(task)))
    expect(maxActive).toBe(1)
  })

  it('runs tasks in FIFO submission order', async () => {
    const mutex = new Mutex()
    const order: number[] = []
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        mutex.runExclusive(async () => {
          await tick()
          order.push(i)
        }),
      ),
    )
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  it('propagates rejections without poisoning the queue', async () => {
    const mutex = new Mutex()
    const failing = mutex.runExclusive(() => {
      throw new Error('boom')
    })
    const following = mutex.runExclusive(() => 'still works')
    await expect(failing).rejects.toThrow('boom')
    expect(await following).toBe('still works')
  })

  it('propagates async rejections too', async () => {
    const mutex = new Mutex()
    const failing = mutex.runExclusive(async () => {
      await tick()
      throw new Error('async boom')
    })
    const following = mutex.runExclusive(async () => 7)
    await expect(failing).rejects.toThrow('async boom')
    expect(await following).toBe(7)
  })
})
