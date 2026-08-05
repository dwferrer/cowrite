import type { ContextSnapshot, CritiqueResult, RunEvent } from '@cowrite/shared'
import { api, CritiqueResult as CritiqueResultSchema } from '@cowrite/shared'
import { useEffect, useRef } from 'react'
import { useRun } from '../api/queries.js'
import { useDocUiStore } from '../state/docUiStore.js'
import { testids } from '../testids.js'
import { Button } from '../ui/Button.js'

/**
 * The provenance viewer (docs/04-frontend.md §7.4), route `/w/:workId/runs/:runId` — a wide
 * modal over the work view rendering one agent run (parsed RunEvent[] from GET /runs/:r) as
 * a vertical timeline, not a raw transcript:
 *
 * - meta header: kind · lane · model · usage/cost · duration · status (errors prominent);
 * - prompt region breakdown from the meta event's ContextSnapshot (region names + token
 *   counts; per-item fidelity/source one level deeper); the raw prompt text comes from the
 *   `message` events — the user sees exactly what the model saw, one click deep;
 * - tool calls as timeline steps with human labels, raw input/output on expand;
 * - streamed output, retries, usage rows, proposal resolution;
 * - artifacts link back into the document (select + navigate).
 *
 * `illustrate-section` / `world-image` runs additionally get a dedicated Illustration section
 * (docs/08-illustration.md §4.2, §4.3): the composed/revised prompts, each attempt's
 * `vlm.critique` scores/problems/promptAdvice, and the committed image (08 §8). The loop emits a
 * per-attempt `attempt` event carrying that attempt's seed (and score), so each attempt shows its
 * recorded seed for reproducibility from the run file.
 */

export interface RunViewerProps {
  workId: string
  runId: string
  onClose: () => void
}

type MetaEvent = Extract<RunEvent, { type: 'meta' }>
type ResultEvent = Extract<RunEvent, { type: 'result' }>

function formatTokens(n: number): string {
  return n.toLocaleString('en-US')
}

function durationLabel(meta: MetaEvent | undefined, result: ResultEvent | undefined): string {
  if (!meta || !result) return ''
  const ms = Date.parse(result.endedAt) - Date.parse(meta.startedAt)
  if (!Number.isFinite(ms) || ms < 0) return ''
  return `${(ms / 1000).toFixed(1)} s`
}

function Regions({ snapshot }: { snapshot: ContextSnapshot }) {
  const total = snapshot.regions.reduce((sum, r) => sum + r.tokens, 0)
  return (
    <details className="run-section">
      <summary data-testid={testids.runPromptToggle}>
        Prompt ({snapshot.regions.length} regions, {formatTokens(total)} tokens)
      </summary>
      <ul className="run-region-list">
        {snapshot.regions.map((region) => (
          <li key={region.name} data-testid={testids.runRegion}>
            <span className="run-region__name">{region.name}</span>
            <span className="run-region__tokens">{formatTokens(region.tokens)} tok</span>
          </li>
        ))}
      </ul>
      {snapshot.items.length > 0 ? (
        <details className="run-section run-section--nested">
          <summary>context items ({snapshot.items.length})</summary>
          <ul className="run-region-list">
            {snapshot.items.map((item) => (
              <li key={`${item.kind}:${item.id}`}>
                <span className="run-region__name">
                  {item.kind} {item.id.slice(0, 8)}… · {item.fidelity} · {item.source}
                </span>
                <span className="run-region__tokens">{formatTokens(item.tokens)} tok</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </details>
  )
}

/** A composed/revised `<image-prompt>` reply — distinguished from a critique reply by shape
 *  (the critic always answers fenced JSON carrying `"verdict"`; the composer never does). */
function isComposedPromptText(text: string): boolean {
  const trimmed = text.trim()
  return trimmed !== '' && !trimmed.includes('"verdict"')
}

function Illustration({
  workId,
  meta,
  events,
  artifacts,
}: {
  workId: string
  meta: MetaEvent
  events: RunEvent[]
  artifacts: ResultEvent['artifacts']
}) {
  const prompts = events
    .filter((e): e is Extract<RunEvent, { type: 'message' }> => e.type === 'message')
    .filter((e) => e.role === 'assistant' && isComposedPromptText(e.text))
  const critiques = events.filter(
    (e): e is Extract<RunEvent, { type: 'toolCall' }> =>
      e.type === 'toolCall' && e.name === 'vlm.critique',
  )
  const artifact = artifacts.find((a) => a.kind === 'illustration' || a.kind === 'world-image')
  const imgSrc =
    artifact?.sectionId !== undefined
      ? api.getSectionIllustration.path(workId, artifact.sectionId)
      : artifact?.entryId !== undefined
        ? api.getWorldImage.path(workId, artifact.entryId)
        : null

  if (prompts.length === 0 && critiques.length === 0 && imgSrc === null) return null

  return (
    <div className="run-section run-section--nested" data-testid={testids.runIllustrationSection}>
      <div style={{ fontWeight: 600, marginBottom: 'var(--space-2)' }}>Illustration</div>
      {prompts.map((p, i) => (
        <details
          // biome-ignore lint/suspicious/noArrayIndexKey: run JSONL is immutable — the line index is a stable identity
          key={`p:${i}`}
          className="run-section run-section--nested"
          data-testid={testids.runIllustrationPrompt}
        >
          <summary>{i === 0 ? 'Composed prompt' : `Revised prompt (${i + 1})`}</summary>
          <pre className="run-raw">{p.text}</pre>
        </details>
      ))}
      {critiques.map((c, i) => {
        let raw: unknown = null
        try {
          raw = JSON.parse(c.output)
        } catch {
          // fall through to the raw-text rendering below
        }
        const parsed = CritiqueResultSchema.safeParse(raw)
        const crit: CritiqueResult | null = parsed.success ? parsed.data : null
        return (
          <details
            // biome-ignore lint/suspicious/noArrayIndexKey: run JSONL is immutable — the line index is a stable identity
            key={`c:${i}`}
            className="run-section run-section--nested"
            data-testid={testids.runIllustrationCritique}
          >
            <summary>
              Attempt {i + 1} — {crit ? `${crit.verdict}, ${crit.overall}/10` : 'unparsed'}
            </summary>
            {crit ? (
              <>
                <div style={{ color: 'var(--fg-muted)', fontSize: 12 }}>
                  subject {crit.scores.subject} · consistency {crit.scores.consistency} · craft{' '}
                  {crit.scores.craft} · mood {crit.scores.mood}
                </div>
                {crit.problems.length > 0 ? (
                  <ul className="run-region-list">
                    {crit.problems.map((problem) => (
                      <li key={problem}>{problem}</li>
                    ))}
                  </ul>
                ) : null}
                {crit.promptAdvice ? (
                  <div style={{ fontSize: 12 }}>advice: {crit.promptAdvice}</div>
                ) : null}
              </>
            ) : (
              <pre className="run-raw">{c.output}</pre>
            )}
          </details>
        )
      })}
      {imgSrc !== null ? (
        <img
          data-testid={testids.runIllustrationArtifactImage}
          src={imgSrc}
          alt={
            meta.spec.kind === 'illustrate-section' ? 'Committed illustration' : 'Committed image'
          }
          style={{
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-1)',
            marginTop: 'var(--space-2)',
            maxWidth: 240,
          }}
        />
      ) : null}
    </div>
  )
}

export function RunViewer({ workId, runId, onClose }: RunViewerProps) {
  const run = useRun(workId, runId)
  const select = useDocUiStore((s) => s.select)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    panelRef.current?.focus()
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const events = run.data ?? []
  const meta = events.find((e): e is MetaEvent => e.type === 'meta')
  const result = events.find((e): e is ResultEvent => e.type === 'result')
  const outputText = events
    .filter((e): e is Extract<RunEvent, { type: 'output' }> => e.type === 'output')
    .map((e) => e.text)
    .join('')
  const messages = events.filter(
    (e): e is Extract<RunEvent, { type: 'message' }> => e.type === 'message',
  )
  const promptsHash =
    meta && typeof meta.params.promptsHash === 'string' ? meta.params.promptsHash : null

  const jumpTo = (kind: 'snippet' | 'section', id: string) => {
    select({ kind, id })
    onClose()
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-close is supplementary; Esc is the accessible path
    // biome-ignore lint/a11y/useKeyWithClickEvents: the document-level Escape listener is the keyboard equivalent
    <div className="run-viewer-backdrop" onClick={onClose}>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: click containment only; keys must BUBBLE so the document-level Escape listener closes the modal */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Run ${runId}`}
        tabIndex={-1}
        className="run-viewer"
        data-testid={testids.runViewer}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="run-viewer__header" data-testid={testids.runViewerHeader}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="run-viewer__title">
              Run {runId.slice(0, 8)}…{meta ? ` · ${meta.kind} · ${meta.lane} model` : ''}
            </div>
            {meta ? (
              <div className="run-viewer__meta">
                {meta.model}
                {promptsHash ? ` · prompts ${promptsHash}` : ''}
                {result
                  ? ` · ${formatTokens(result.usageTotal.promptTokens)} in / ${formatTokens(
                      result.usageTotal.completionTokens,
                    )} out`
                  : ''}
                {durationLabel(meta, result) ? ` · ${durationLabel(meta, result)}` : ''}
                {result ? ` · ${result.status}` : ' · running'}
              </div>
            ) : null}
            {result?.error ? (
              <div className="run-viewer__error">
                {result.error.code}: {result.error.message}
              </div>
            ) : null}
          </div>
          <Button variant="ghost" data-testid={testids.runViewerClose} onClick={onClose}>
            ✕
          </Button>
        </header>

        {run.isLoading ? <div style={{ color: 'var(--fg-faint)' }}>Loading run…</div> : null}
        {run.isError ? <div className="run-viewer__error">Run not found or unreadable.</div> : null}

        {meta?.contextSnapshot ? <Regions snapshot={meta.contextSnapshot} /> : null}

        {meta && (meta.kind === 'illustrate-section' || meta.kind === 'world-image') ? (
          <Illustration
            workId={workId}
            meta={meta}
            events={events}
            artifacts={result?.artifacts ?? []}
          />
        ) : null}

        <ol className="run-timeline">
          {events.map((event, i) => {
            // run JSONL is immutable — the line index is a stable identity
            const key = `${event.type}:${i}`
            switch (event.type) {
              case 'stage':
                return (
                  <li key={key} className="run-step">
                    ● {event.stage}
                    {event.round > 0 ? ` (round ${event.round})` : ''}
                  </li>
                )
              case 'toolCall':
                return (
                  <li key={key} className="run-step" data-testid={testids.runToolCall}>
                    <details>
                      <summary>
                        ● {event.name} · {Math.round(event.durationMs)} ms
                      </summary>
                      <pre className="run-raw">{JSON.stringify(event.input, null, 2)}</pre>
                      <pre className="run-raw">{event.output}</pre>
                    </details>
                  </li>
                )
              case 'attempt': {
                // Illustration attempts carry a seed (and score on a critiqued attempt) for
                // reproducibility (08 §4.4); a bare retry (writing lane) carries only a reason.
                const scored = event.score !== undefined
                const seedText = event.seed !== undefined ? ` · seed ${event.seed}` : ''
                return (
                  <li
                    key={key}
                    className={`run-step${scored ? '' : ' run-step--warn'}`}
                    data-testid={testids.runAttempt}
                  >
                    ● attempt {event.n}
                    {seedText}
                    {scored ? ` · score ${event.score}` : ` — ${event.reason}`}
                  </li>
                )
              }
              case 'usage':
                return (
                  <li key={key} className="run-step run-step--faint">
                    usage ({event.call}): {formatTokens(event.promptTokens)} in /{' '}
                    {formatTokens(event.completionTokens)} out{event.estimated ? ' (est.)' : ''}
                  </li>
                )
              case 'proposal':
                return (
                  <li key={key} className="run-step">
                    ● proposal {event.resolution} at {new Date(event.at).toLocaleString()}
                  </li>
                )
              default:
                return null
            }
          })}
        </ol>

        {messages.length > 0 ? (
          <details className="run-section">
            <summary data-testid={testids.runPromptText}>
              Prompt text ({messages.length} messages)
            </summary>
            {messages.map((m, i) => (
              <details
                // biome-ignore lint/suspicious/noArrayIndexKey: run JSONL is immutable — the line index is a stable identity
                key={`m:${i}`}
                className="run-section run-section--nested"
                data-testid={testids.runPromptMessage}
              >
                <summary>{m.role}</summary>
                <pre className="run-raw">{m.text}</pre>
              </details>
            ))}
          </details>
        ) : null}

        {outputText.length > 0 ? (
          <details className="run-section" open data-testid={testids.runOutput}>
            <summary>Output</summary>
            <div className="prose run-output">{outputText}</div>
          </details>
        ) : null}

        {result && result.artifacts.length > 0 ? (
          <div className="run-artifacts">
            {result.artifacts.map((artifact, i) => {
              const targetId = artifact.snippetId ?? artifact.sectionId ?? artifact.entryId
              const jumpKind = artifact.snippetId
                ? ('snippet' as const)
                : artifact.sectionId
                  ? ('section' as const)
                  : null
              return (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: run JSONL is immutable — the line index is a stable identity
                  key={`a:${i}`}
                  className="run-step"
                  data-testid={testids.runArtifact}
                >
                  ● produced: {artifact.kind}
                  {targetId ? ` ${targetId.slice(0, 8)}…` : ''}
                  {artifact.rev !== undefined ? ` rev ${artifact.rev}` : ''}
                  {artifact.state !== 'committed' ? ` (${artifact.state})` : ''}
                  {jumpKind && targetId ? (
                    <Button variant="ghost" onClick={() => jumpTo(jumpKind, targetId)}>
                      jump to {jumpKind}
                    </Button>
                  ) : null}
                </div>
              )
            })}
          </div>
        ) : null}
      </div>
    </div>
  )
}
