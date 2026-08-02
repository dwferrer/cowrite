import { create } from 'zustand'
import { usePanelStore } from '../state/panelStore.js'

/**
 * The copy-selection-from-doc helper channel (docs/04-frontend.md §9.1): the selection
 * toolbar requests an append; the situation pane (which owns the draft/save lifecycle)
 * consumes it. Requesting also opens the pane so the paste is visible.
 */

export interface SituationAppendRequest {
  workId: string
  /** Markdown to append: a blockquote of the selection with an attribution line. */
  markdown: string
}

interface SituationBridgeState {
  pending: SituationAppendRequest | null
  request(req: SituationAppendRequest): void
  consume(): SituationAppendRequest | null
}

export const useSituationBridge = create<SituationBridgeState>()((set, get) => ({
  pending: null,
  request: (pending) => set({ pending }),
  consume: () => {
    const pending = get().pending
    if (pending) set({ pending: null })
    return pending
  },
}))

/** Format the selection as a markdown blockquote with a `— <source>` attribution line. */
export function formatSituationQuote(text: string, sourceLabel: string): string {
  const quoted = text
    .trim()
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
  return `${quoted}\n> — ${sourceLabel}\n`
}

export function requestSituationAppend(workId: string, text: string, sourceLabel: string): void {
  usePanelStore.getState().setSituationOpen(workId, true)
  useSituationBridge
    .getState()
    .request({ workId, markdown: formatSituationQuote(text, sourceLabel) })
}
