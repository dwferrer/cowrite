import { useEffect } from 'react'
import { Link, useMatch, useNavigate, useParams } from 'react-router'
import { useWorkEvents, useWorkStatusStore } from '../api/events.js'
import { useWork } from '../api/queries.js'
import { DocView } from '../doc/DocView.js'
import { dispatchRevisionCycle } from '../edit/RevisionCycler.js'
import { installKeyboard } from '../keyboard.js'
import { SituationPane } from '../panes/SituationPane.js'
import { WorldPanel } from '../panes/world/WorldPanel.js'
import { useDocUiStore } from '../state/docUiStore.js'
import { usePanelStore } from '../state/panelStore.js'
import { testids } from '../testids.js'
import { Button } from '../ui/Button.js'
import { ModelsNotConfiguredBanner } from './Settings.js'

/**
 * `/w/:workId[/world[/:entryId]]` — the layout shell (docs/04-frontend.md §3, §9): situation
 * pane left (local UI state), document center, world panel as a route-driven right overlay.
 * Owns the work's single SSE connection, the readonly banner, and the global keymap
 * (Esc ladder + Ctrl-Enter routing, §12).
 */

export function WorkView() {
  const params = useParams<{ workId: string; entryId?: string }>()
  const workId = params.workId ?? ''
  const work = useWork(workId)
  const navigate = useNavigate()
  useWorkEvents(workId)

  const worldEntryMatch = useMatch('/w/:workId/world/*')
  const worldListMatch = useMatch('/w/:workId/world')
  const worldOpen = worldEntryMatch !== null || worldListMatch !== null
  const readonlyBanner = useWorkStatusStore((s) => s.readonlyBanner)
  const connected = useWorkStatusStore((s) => s.connected)

  const situationOpen = usePanelStore((s) => s.byWork[workId]?.situationOpen ?? false)
  const situationWidth = usePanelStore((s) => s.byWork[workId]?.situationWidth ?? 320)
  const setSituationOpen = usePanelStore((s) => s.setSituationOpen)

  const readonly = readonlyBanner?.readonly ?? work.data?.readonly ?? false

  // the global keymap (04 §12): editable surfaces own their keys; everything else lands here
  useEffect(() => {
    if (!workId) return
    return installKeyboard(
      window,
      () => ({
        editorOpen: useDocUiStore.getState().editing !== null,
        instructionFocused: false, // instruction inputs are editable targets — they own their keys
        selectionActive: useDocUiStore.getState().selection !== null,
      }),
      {
        'editor.cancel': () => window.dispatchEvent(new CustomEvent('cowrite:editor-cancel')),
        'selection.prevRevision': () => dispatchRevisionCycle(-1),
        'selection.nextRevision': () => dispatchRevisionCycle(1),
        'selection.clear': () => useDocUiStore.getState().select(null),
        'global.jumpToFrontier': () => useDocUiStore.getState().setFollowBottom(true),
        'global.toggleSituation': () => {
          const open = usePanelStore.getState().byWork[workId]?.situationOpen ?? false
          usePanelStore.getState().setSituationOpen(workId, !open)
        },
        'global.toggleWorld': () => navigate(worldOpen ? `/w/${workId}` : `/w/${workId}/world`),
        'global.closeTopmost': () => {
          // Esc ladder (§12): modal (owns its own Esc) → panel → nothing
          if (worldOpen) navigate(worldEntryMatch ? `/w/${workId}/world` : `/w/${workId}`)
        },
        // 'global.continue' stays unregistered — Continue is disabled until Stage 3
      },
    )
  }, [workId, worldOpen, worldEntryMatch, navigate])

  return (
    <div className="work-view" data-testid={testids.workView}>
      <header className="work-header" data-testid={testids.workHeader}>
        <Link to="/" aria-label="Back to works" style={{ color: 'var(--fg-muted)' }}>
          ←
        </Link>
        <h1 className="work-header__title">{work.data?.title ?? '…'}</h1>
        <Button
          variant="ghost"
          data-testid={testids.situationToggle}
          aria-pressed={situationOpen}
          onClick={() => setSituationOpen(workId, !situationOpen)}
        >
          Situation
        </Button>
        <Link to={worldOpen ? `/w/${workId}` : `/w/${workId}/world`}>
          <Button variant="ghost" data-testid={testids.worldToggle} aria-pressed={worldOpen}>
            World
          </Button>
        </Link>
      </header>

      <ModelsNotConfiguredBanner />

      {readonly ? (
        <div className="banner banner--readonly" data-testid={testids.readonlyBanner} role="status">
          Read-only{readonlyBanner?.reason ? ` — ${readonlyBanner.reason}` : ''} · editing is
          disabled
        </div>
      ) : null}
      {!connected && work.isSuccess ? (
        <div className="banner banner--offline" data-testid={testids.offlineBanner} role="status">
          Reconnecting…
        </div>
      ) : null}

      <div className="work-view__body">
        {situationOpen ? <SituationPane workId={workId} width={situationWidth} /> : null}
        <DocView workId={workId} readonly={readonly} />
        {worldOpen ? (
          <WorldPanel workId={workId} entryId={params.entryId} readonly={readonly} />
        ) : null}
      </div>
    </div>
  )
}
