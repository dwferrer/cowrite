import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { illustrationFailureKey, useTaskStore } from '../../state/taskStore.js'
import { testids } from '../../testids.js'
import { IllustrationOverlay } from './IllustrationOverlay.js'

/**
 * Shimmer + failure-badge states (docs/08-illustration.md §8, docs/04-frontend.md §10): a
 * live `illustrate-section`/`world-image` background task drives the caption; a recorded
 * `task.failed` drives the badge + retry; neither renders nothing.
 */

const S1 = '01ARZ3NDEKTSV4RRFFQ69G5FA1'
const T1 = '01ARZ3NDEKTSV4RRFFQ69G5FA2'

beforeEach(() => {
  useTaskStore.getState().reset()
})

afterEach(() => cleanup())

describe('IllustrationOverlay', () => {
  it('renders nothing when idle', () => {
    render(<IllustrationOverlay targetKind="section" targetId={S1} onRetry={vi.fn()} />)
    expect(screen.queryByTestId(testids.illustrationShimmer)).toBeNull()
    expect(screen.queryByTestId(testids.illustrationBadge)).toBeNull()
  })

  it('shows "Starting…" before the first task.progress arrives', () => {
    useTaskStore.getState().started(
      {
        id: T1,
        workId: 'w',
        spec: { kind: 'illustrate-section', sectionId: S1 },
        lane: 'illustration',
        status: 'running',
        queuedAt: 'now',
        startedAt: 'now',
        endedAt: null,
        error: null,
        partialText: null,
        unresolvedProposal: null,
      },
      'illustration',
      { kind: 'section', id: S1 },
    )
    render(<IllustrationOverlay targetKind="section" targetId={S1} onRetry={vi.fn()} />)
    expect(screen.getByTestId(testids.illustrationCaption).textContent).toBe('Starting…')
  })

  it('cycles the caption from task.progress', () => {
    useTaskStore.getState().started(
      {
        id: T1,
        workId: 'w',
        spec: { kind: 'illustrate-section', sectionId: S1 },
        lane: 'illustration',
        status: 'running',
        queuedAt: 'now',
        startedAt: 'now',
        endedAt: null,
        error: null,
        partialText: null,
        unresolvedProposal: null,
      },
      'illustration',
      { kind: 'section', id: S1 },
    )
    useTaskStore
      .getState()
      .progress(T1, { phase: 'generating', attempt: 2, maxAttempts: 3, pct: 64 })
    render(<IllustrationOverlay targetKind="section" targetId={S1} onRetry={vi.fn()} />)
    expect(screen.getByTestId(testids.illustrationCaption).textContent).toBe(
      'Generating (attempt 2/3, 64%)',
    )
  })

  it('shows the failure badge with friendly text and a retry button', () => {
    useTaskStore.setState({
      illustrationFailures: new Map([
        [
          illustrationFailureKey('section', S1),
          { code: 'pipeline', message: 'comfy_unreachable', retryable: true },
        ],
      ]),
    })

    const onRetry = vi.fn()
    render(<IllustrationOverlay targetKind="section" targetId={S1} onRetry={onRetry} />)
    const badge = screen.getByTestId(testids.illustrationBadge)
    expect(badge.textContent).toContain('ComfyUI unreachable')

    fireEvent.click(screen.getByTestId(testids.illustrationRetry))
    expect(onRetry).toHaveBeenCalledTimes(1)
    // retrying clears the recorded failure optimistically
    expect(
      useTaskStore.getState().illustrationFailures.get(illustrationFailureKey('section', S1)),
    ).toBeUndefined()
  })

  it('disables Retry and offers a Settings link for a non-retryable failure (§20)', () => {
    useTaskStore.setState({
      illustrationFailures: new Map([
        [
          illustrationFailureKey('section', S1),
          { code: 'config_missing', message: 'ComfyUI is not configured', retryable: false },
        ],
      ]),
    })
    const onRetry = vi.fn()
    render(<IllustrationOverlay targetKind="section" targetId={S1} onRetry={onRetry} />)
    const retry = screen.getByTestId(testids.illustrationRetry) as HTMLButtonElement
    expect(retry.disabled).toBe(true)
    fireEvent.click(retry)
    expect(onRetry).not.toHaveBeenCalled()
    // a Settings link is offered instead
    expect(screen.getByTestId(testids.illustrationSettingsLink)).toBeTruthy()
  })

  it('a live task takes priority over a stale recorded failure', () => {
    useTaskStore.setState({
      illustrationFailures: new Map([
        [
          illustrationFailureKey('section', S1),
          { code: 'pipeline', message: 'comfy_timeout', retryable: true },
        ],
      ]),
    })
    useTaskStore.getState().started(
      {
        id: T1,
        workId: 'w',
        spec: { kind: 'illustrate-section', sectionId: S1 },
        lane: 'illustration',
        status: 'running',
        queuedAt: 'now',
        startedAt: 'now',
        endedAt: null,
        error: null,
        partialText: null,
        unresolvedProposal: null,
      },
      'illustration',
      { kind: 'section', id: S1 },
    )
    // `started` clears the recorded failure for this target (a fresh submit means "try again")
    render(<IllustrationOverlay targetKind="section" targetId={S1} onRetry={vi.fn()} />)
    expect(screen.getByTestId(testids.illustrationShimmer)).toBeTruthy()
    expect(screen.queryByTestId(testids.illustrationBadge)).toBeNull()
  })
})
