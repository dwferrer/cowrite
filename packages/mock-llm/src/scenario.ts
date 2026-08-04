/**
 * The scenario engine (docs/09-testing.md §2.2): an ordered queue of scripted steps.
 *
 * Each incoming request consumes exactly the *next* step; a mismatch, or a request arriving
 * after the queue is exhausted, fails loudly — the error is recorded (so `assertDrained()`
 * surfaces it at test end even when the server swallowed the throw into a 500) and thrown.
 * Permissive fallthrough is how mock tests rot; a mock that answers a request the test did
 * not script is a bug.
 *
 * Steps are plain JSON-serializable objects so the same shapes travel over the
 * `POST /__mock/scenario` control route for cross-process (e2e) scripting.
 */

export class ScenarioError extends Error {
  override name = 'ScenarioError'
}

export interface ScenarioState {
  pending: number
  consumed: number
  errors: string[]
}

export class ScenarioQueue<Step> {
  private steps: Step[] = []
  private consumedSteps: Step[] = []
  private failures: string[] = []

  /** Append steps to the end of the queue. */
  push(...steps: Step[]): void {
    this.steps.push(...steps)
  }

  /**
   * Consume the next step for an incoming request. `mismatch` returns a human-readable
   * reason when the head step's match predicate rejects the request, or null to accept.
   */
  take(requestDescription: string, mismatch?: (step: Step) => string | null): Step {
    const step = this.steps[0]
    if (step === undefined) {
      return this.fail(`scenario exhausted: unscripted request ${requestDescription}`)
    }
    if (mismatch) {
      const why = mismatch(step)
      if (why !== null) {
        return this.fail(
          `scenario step mismatch for request ${requestDescription}: ${why} (step: ${JSON.stringify(step)})`,
        )
      }
    }
    this.steps.shift()
    this.consumedSteps.push(step)
    return step
  }

  private fail(message: string): never {
    this.failures.push(message)
    throw new ScenarioError(message)
  }

  get pending(): number {
    return this.steps.length
  }

  get consumed(): number {
    return this.consumedSteps.length
  }

  get errors(): readonly string[] {
    return this.failures
  }

  /** Clear queued steps, consumption history, and recorded failures. */
  reset(): void {
    this.steps = []
    this.consumedSteps = []
    this.failures = []
  }

  /**
   * Throw if any scripted step never fired or any request failed to match.
   * Call at the end of every test that enqueued steps.
   */
  assertDrained(): void {
    if (this.failures.length > 0) {
      throw new ScenarioError(`scenario recorded failures:\n- ${this.failures.join('\n- ')}`)
    }
    if (this.steps.length > 0) {
      throw new ScenarioError(
        `scenario not drained: ${this.steps.length} step(s) never fired: ${JSON.stringify(this.steps)}`,
      )
    }
  }

  state(): ScenarioState {
    return { pending: this.pending, consumed: this.consumed, errors: [...this.failures] }
  }
}
