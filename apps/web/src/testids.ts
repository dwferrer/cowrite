/**
 * Every data-testid constant, shared with the Playwright e2e suite (docs/04-frontend.md §15.2).
 * Selectors import from here only, so renames break compile, not CI.
 */

export const testids = {
  // works list
  worksList: 'works-list',
  worksRow: 'works-row',
  worksCreateInput: 'works-create-input',
  worksCreateButton: 'works-create-button',

  // settings
  settingsScreen: 'settings-screen',
  settingsFirstRun: 'settings-first-run',
  settingsCardHigh: 'settings-card-high',
  settingsCardLow: 'settings-card-low',
  settingsCardComfy: 'settings-card-comfyui',
  settingsTestButton: 'settings-test-button',
  settingsTestResult: 'settings-test-result',
  settingsSaveButton: 'settings-save-button',
  settingsReloadButton: 'settings-reload-button',
  settingsRestartNotice: 'settings-restart-notice',
  settingsOverrideBadge: 'settings-override-badge',
  settingsSkipLink: 'settings-skip-link',
  modelsBanner: 'models-banner',
  modelsBannerDismiss: 'models-banner-dismiss',

  // work view shell
  workView: 'work-view',
  workHeader: 'work-header',
  readonlyBanner: 'readonly-banner',
  offlineBanner: 'offline-banner',
  situationToggle: 'situation-toggle',
  worldToggle: 'world-toggle',

  // document view
  docView: 'doc-view',
  snippetBlock: 'snippet-block',
  sectionBlock: 'section-block',
  sectionHeader: 'section-header',
  sectionSkeleton: 'section-skeleton',
  staleBadge: 'stale-badge',
  nameCard: 'name-card',
  streamingBlock: 'streaming-block',
  frontierBar: 'frontier-bar',
  frontierContinue: 'frontier-continue',
  frontierNewSnippet: 'frontier-new-snippet',
  frontierInstruct: 'frontier-instruct',
  jumpToFrontier: 'jump-to-frontier',
  worldHovercard: 'world-hovercard',

  // editing / selection
  snippetEditor: 'snippet-editor',
  editorSave: 'editor-save',
  editorCancel: 'editor-cancel',
  // ConflictBanner testids — one distinct triple per surface (prefix, -theirs, -mine)
  snippetConflict: 'snippet-conflict',
  snippetConflictTheirs: 'snippet-conflict-theirs',
  snippetConflictMine: 'snippet-conflict-mine',
  worldConflict: 'world-conflict',
  worldConflictTheirs: 'world-conflict-theirs',
  worldConflictMine: 'world-conflict-mine',
  situationConflict: 'situation-conflict',
  situationConflictTheirs: 'situation-conflict-theirs',
  situationConflictMine: 'situation-conflict-mine',
  editorDiscardConfirm: 'editor-discard-confirm',
  editorDraftRestore: 'editor-draft-restore',
  selectionToolbar: 'selection-toolbar',
  snippetFooter: 'snippet-footer',
  snippetDelete: 'snippet-delete',
  addToSituation: 'add-to-situation',
  revisionCycler: 'revision-cycler',
  revisionPrev: 'revision-prev',
  revisionNext: 'revision-next',
  revisionRestore: 'revision-restore',
  revisionPeekBanner: 'revision-peek-banner',
  quickEditBox: 'quick-edit-box',

  // panes
  situationPane: 'situation-pane',
  situationText: 'situation-text',
  situationRendered: 'situation-rendered',
  situationSavedTick: 'situation-saved-tick',
  situationConflictChip: 'situation-conflict-chip',
  worldPanel: 'world-panel',
  worldList: 'world-list',
  worldSearch: 'world-search',
  worldCreateName: 'world-create-name',
  worldCreateButton: 'world-create-button',
  worldEntryRow: 'world-entry-row',
  worldEntryDetail: 'world-entry-detail',
  worldEntryName: 'world-entry-name',
  worldEntryDelete: 'world-entry-delete',
  worldKeyChip: 'world-key-chip',
  worldKeyInput: 'world-key-input',
  worldShortSummary: 'world-short-summary',
  worldBodyText: 'world-body-text',
  worldBodyPreview: 'world-body-preview',
  worldBodySave: 'world-body-save',
  worldImage: 'world-image',
  worldImageUpload: 'world-image-upload',
  worldImageDelete: 'world-image-delete',
  worldPanelClose: 'world-panel-close',

  // ui atoms
  toast: 'toast',
  dialog: 'dialog',
} as const

export type TestId = (typeof testids)[keyof typeof testids]
