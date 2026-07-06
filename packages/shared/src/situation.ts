import { z } from 'zod'
import { Hash, IsoTime } from './ids.js'

/**
 * The per-work singleton scratchpad DTO (docs/02-data-model.md §2.2, §11):
 * `getSituation()` / `GET /works/:w/situation` payload.
 *
 * `hash` (xxh64 of the text) is the §6.6 optimistic-concurrency token — mtime is only
 * display metadata: coarse filesystem timestamps can collide across distinct writes,
 * which would let a stale put clobber silently. `updatedAt` stays for the UI.
 */

export const SituationDto = z.object({
  text: z.string(),
  updatedAt: IsoTime,
  hash: Hash,
})
export type SituationDto = z.infer<typeof SituationDto>
