import { Button } from './Button.js'

/**
 * The ONE 409 theirs/mine banner (docs/04-frontend.md §7.1): shown when a save hit a
 * stale concurrency token. Each surface passes its own testid prefix so e2e selectors
 * stay distinct: `${prefix}` on the banner, `${prefix}-theirs` / `${prefix}-mine` on
 * the buttons (the testids.ts constants encode the same derivation).
 */

export interface ConflictBannerProps {
  message: string
  /** Adopt the server version and drop the local draft. */
  onTakeTheirs(): void
  /** Resubmit the local draft against the refreshed base. */
  onKeepMine(): void
  /** data-testid prefix, e.g. 'snippet-conflict' — from testids.ts, never inline. */
  testidPrefix: string
}

export function ConflictBanner({
  message,
  onTakeTheirs,
  onKeepMine,
  testidPrefix,
}: ConflictBannerProps) {
  return (
    <div className="editor-banner editor-banner--conflict" data-testid={testidPrefix}>
      <span style={{ flex: 1 }}>{message}</span>
      <Button data-testid={`${testidPrefix}-theirs`} onClick={onTakeTheirs}>
        Take theirs
      </Button>
      <Button data-testid={`${testidPrefix}-mine`} onClick={onKeepMine}>
        Keep mine
      </Button>
    </div>
  )
}
