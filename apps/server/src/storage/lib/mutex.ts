/**
 * Minimal promise FIFO mutex — the per-work single-writer mutex of spec 02 §6.4. Tasks
 * run strictly in submission order; a rejected task does not poison the queue.
 */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve()

  runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.tail.then(() => fn())
    // The next task waits on this one settling, success or failure.
    this.tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}
