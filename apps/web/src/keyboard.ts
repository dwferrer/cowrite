/**
 * Global keymap (docs/04-frontend.md §12). One resolver dispatches by context, most-specific
 * first: editor open → instruction input focused → selection active → global. WorkView
 * installs the window listener via `installKeyboard`; editable surfaces (textareas, inputs)
 * own their keys directly — the global listener skips events originating in them, which is
 * exactly the editor/instruction rows of the table.
 */

export type KeyContext = 'editor' | 'instruction' | 'selection' | 'global'

/** Context precedence, most-specific first. */
export const KEY_CONTEXT_ORDER: readonly KeyContext[] = [
  'editor',
  'instruction',
  'selection',
  'global',
]

export type KeyAction =
  | 'editor.newline'
  | 'editor.save'
  | 'editor.cancel'
  | 'instruction.launch'
  | 'instruction.dismiss'
  | 'selection.prevRevision'
  | 'selection.nextRevision'
  | 'selection.clear'
  | 'selection.quickEdit'
  | 'global.continue'
  | 'global.jumpToFrontier'
  | 'global.toggleSituation'
  | 'global.toggleEditTask'
  | 'global.toggleWorld'
  | 'global.closeTopmost'
  | 'global.cheatSheet'

export interface KeyCombo {
  key: string // KeyboardEvent.key
  ctrl?: boolean
  alt?: boolean
  shift?: boolean
}

export interface KeyBinding {
  context: KeyContext
  combo: KeyCombo
  action: KeyAction
  description: string
}

/** The §12 table, verbatim. Order within a context matters (first match wins). */
export const KEYMAP: readonly KeyBinding[] = [
  // editor open
  {
    context: 'editor',
    combo: { key: 'Enter', ctrl: true },
    action: 'editor.save',
    description: 'Save',
  },
  {
    context: 'editor',
    combo: { key: 'Enter' },
    action: 'editor.newline',
    description: 'Newline (never submits)',
  },
  {
    context: 'editor',
    combo: { key: 'Escape' },
    action: 'editor.cancel',
    description: 'Cancel (confirm if dirty)',
  },
  // instruction inputs
  {
    context: 'instruction',
    combo: { key: 'Enter', ctrl: true },
    action: 'instruction.launch',
    description: 'Launch the task',
  },
  {
    context: 'instruction',
    combo: { key: 'Escape' },
    action: 'instruction.dismiss',
    description: 'Blur/clear the box',
  },
  // selection active
  {
    context: 'selection',
    combo: { key: 'ArrowLeft', alt: true },
    action: 'selection.prevRevision',
    description: 'Previous revision',
  },
  {
    context: 'selection',
    combo: { key: 'ArrowRight', alt: true },
    action: 'selection.nextRevision',
    description: 'Next revision',
  },
  {
    context: 'selection',
    combo: { key: 'Escape' },
    action: 'selection.clear',
    description: 'Clear selection (exits revision peek)',
  },
  {
    context: 'selection',
    combo: { key: 'Enter', ctrl: true },
    action: 'selection.quickEdit',
    description: 'Launch quick edit if its box has text',
  },
  // global (work view)
  {
    context: 'global',
    combo: { key: 'Enter', ctrl: true },
    action: 'global.continue',
    description: 'Continue (nothing selected, no editor)',
  },
  {
    context: 'global',
    combo: { key: 'End' },
    action: 'global.jumpToFrontier',
    description: 'Jump to frontier',
  },
  {
    context: 'global',
    combo: { key: 'End', ctrl: true },
    action: 'global.jumpToFrontier',
    description: 'Jump to frontier',
  },
  {
    context: 'global',
    combo: { key: ';', ctrl: true },
    action: 'global.toggleSituation',
    description: 'Toggle situation pane',
  },
  {
    context: 'global',
    combo: { key: "'", ctrl: true },
    action: 'global.toggleEditTask',
    description: 'Toggle edit-task pane (M2)',
  },
  {
    context: 'global',
    combo: { key: '.', ctrl: true },
    action: 'global.toggleWorld',
    description: 'Toggle world panel',
  },
  {
    context: 'global',
    combo: { key: 'Escape' },
    action: 'global.closeTopmost',
    description: 'Close topmost surface',
  },
  {
    context: 'global',
    combo: { key: '?' },
    action: 'global.cheatSheet',
    description: 'Shortcut cheat sheet',
  },
]

export interface KeyContextState {
  editorOpen: boolean
  instructionFocused: boolean
  selectionActive: boolean
}

/** Most-specific active context for the current UI state. */
export function resolveContext(state: KeyContextState): KeyContext {
  if (state.editorOpen) return 'editor'
  if (state.instructionFocused) return 'instruction'
  if (state.selectionActive) return 'selection'
  return 'global'
}

export interface KeyEventLike {
  key: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

function comboMatches(combo: KeyCombo, e: KeyEventLike): boolean {
  return (
    combo.key === e.key &&
    (combo.ctrl ?? false) === e.ctrlKey &&
    (combo.alt ?? false) === e.altKey &&
    (combo.shift ?? false) === e.shiftKey
  )
}

/**
 * Resolve a key event against the map, most-specific context first: an exact match in the
 * active context wins; a key the active context binds at all (any modifiers) never falls
 * through (e.g. Ctrl-Enter under `selection` never reaches global Continue, 04 §12);
 * everything else falls through to `global` only — intermediate contexts never intercept.
 */
export function matchBinding(e: KeyEventLike, state: KeyContextState): KeyBinding | null {
  const active = resolveContext(state)
  const activeBindings = KEYMAP.filter((b) => b.context === active)
  const exact = activeBindings.find((b) => comboMatches(b.combo, e))
  if (exact) return exact
  if (activeBindings.some((b) => b.combo.key === e.key)) return null
  if (active === 'global') return null
  return KEYMAP.find((b) => b.context === 'global' && comboMatches(b.combo, e)) ?? null
}

// ---------------------------------------------------------------------------
// The installer (wired by WorkView). Actions without a registered handler are no-ops —
// Stage 2 registers no `global.continue` (the frontier Continue is disabled until Stage 3).
// ---------------------------------------------------------------------------

export type KeyActionHandlers = Partial<Record<KeyAction, () => void>>

/** Editable surfaces own their keys (04 §12) — the global listener never intercepts them. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}

export function installKeyboard(
  win: Window,
  getState: () => KeyContextState,
  handlers: KeyActionHandlers,
): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return
    if (isEditableTarget(e.target)) return
    const binding = matchBinding(e, getState())
    if (!binding) return
    const handler = handlers[binding.action]
    if (!handler) return
    e.preventDefault()
    handler()
  }
  win.addEventListener('keydown', onKeyDown)
  return () => win.removeEventListener('keydown', onKeyDown)
}
