import type { PipelinePhase } from '@cowrite/shared'

/**
 * Illustration pipeline caption + failure-badge text (docs/08-illustration.md §8, §10;
 * docs/04-frontend.md §10). Pure formatting only, so the wording lives in one tested place —
 * the shimmer overlay reads `task.progress` fields off the background map through
 * `illustrationCaption`, and the failure badge reads a `task.failed` code/message pair
 * through `illustrationFailureText`.
 */

/** The shimmer caption cycling composing → generating (with attempt/pct) → critiquing → … */
export function illustrationCaption(
  phase: PipelinePhase,
  attempt: number,
  maxAttempts: number,
  pct: number | null,
): string {
  switch (phase) {
    case 'composing':
      return 'Composing prompt'
    case 'submitting':
      return 'Submitting to ComfyUI'
    case 'queued':
      return `Queued (attempt ${attempt}/${maxAttempts})`
    case 'generating':
      return `Generating (attempt ${attempt}/${maxAttempts}${
        pct !== null ? `, ${Math.round(pct)}%` : ''
      })`
    case 'critiquing':
      return 'Critiquing…'
    case 'revising':
      return 'Revising prompt…'
    case 'committing':
      return 'Committing…'
  }
}

/** §8/§10 `pipeline` failure details → the badge's friendly text. */
const PIPELINE_DETAIL_TEXT: Record<string, string> = {
  comfy_unreachable: 'ComfyUI unreachable',
  workflow_invalid: 'Workflow invalid — check the %marker% setup',
  comfy_exec_error: 'Image generation failed',
  comfy_timeout: 'Generation timed out',
  commit_target_missing: 'Section changed before the image finished',
  compose_failed: 'Prompt model failed',
  budget_exhausted: 'Ran out of time before an image was ready',
  critique_failed: 'Image review failed',
  transcode_failed: 'Generated image could not be converted to PNG',
  commit_failed: 'Saving the image failed',
}

/** `task.failed`'s `{code, message}` → the small badge's friendly one-liner (§10). */
export function illustrationFailureText(code: string, message: string): string {
  if (code === 'pipeline') return PIPELINE_DETAIL_TEXT[message] ?? 'Illustration failed'
  if (code === 'config_missing') return 'ComfyUI not configured'
  return message || 'Illustration failed'
}
