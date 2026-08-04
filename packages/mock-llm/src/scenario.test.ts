import { describe, expect, it } from 'vitest'
import { ScenarioError, ScenarioQueue } from './scenario.js'

interface Step {
  label: string
}

describe('ScenarioQueue', () => {
  it('consumes steps strictly in order', () => {
    const queue = new ScenarioQueue<Step>()
    queue.push({ label: 'a' }, { label: 'b' })
    expect(queue.take('req-1')).toEqual({ label: 'a' })
    expect(queue.take('req-2')).toEqual({ label: 'b' })
    expect(queue.pending).toBe(0)
    expect(queue.consumed).toBe(2)
    queue.assertDrained()
  })

  it('fails loudly on an unscripted request and remembers the failure', () => {
    const queue = new ScenarioQueue<Step>()
    expect(() => queue.take('POST /v1/chat/completions')).toThrow(ScenarioError)
    expect(queue.errors[0]).toContain('unscripted request POST /v1/chat/completions')
    expect(() => queue.assertDrained()).toThrow(/unscripted request/)
  })

  it('fails loudly on a match mismatch without consuming the step', () => {
    const queue = new ScenarioQueue<Step>()
    queue.push({ label: 'expects-high' })
    expect(() => queue.take('req', () => 'wrong model')).toThrow(/wrong model/)
    expect(queue.pending).toBe(1)
    expect(() => queue.assertDrained()).toThrow(ScenarioError)
  })

  it('assertDrained throws when scripted steps never fired', () => {
    const queue = new ScenarioQueue<Step>()
    queue.push({ label: 'never-fires' })
    expect(() => queue.assertDrained()).toThrow(/never fired/)
  })

  it('reset clears steps, history, and failures', () => {
    const queue = new ScenarioQueue<Step>()
    queue.push({ label: 'a' })
    try {
      queue.take('req', () => 'nope')
    } catch {
      // expected
    }
    queue.reset()
    expect(queue.state()).toEqual({ pending: 0, consumed: 0, errors: [] })
    queue.assertDrained()
  })
})
