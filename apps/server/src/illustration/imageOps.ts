/**
 * Image helpers backed by `sharp` (docs/08-illustration.md §4.3, §10).
 *
 * Two jobs, both small:
 * - `downscalePng` shrinks a generated image to ≤ `maxEdge` px on its longest side before the
 *   critic attaches it as a base64 `image_url` part — a 0–5 rubric judgement never needs native
 *   resolution, and the ~4× smaller body matters for modest self-hosted VLM endpoints (§4.3).
 * - `transcodeToPng` re-encodes any decodable image to PNG, the on-disk format rule (02 §layout):
 *   exotic ComfyUI save nodes can emit WebP/JPEG, and the pipeline's format/size guards (§10)
 *   normalize those to PNG before committing.
 *
 * Both decode with `failOn: 'none'` so a slightly-nonconformant-but-renderable image still gets
 * through; a truly undecodable buffer rejects and the caller fails the attempt (§10).
 */
import sharp from 'sharp'

/** Cap on the longest edge of a critic-facing image (§4.3). */
export const DEFAULT_MAX_EDGE = 768

/**
 * Return a PNG whose longest edge is ≤ `maxEdge` px (never upscales a smaller image). The result
 * is always PNG, so this doubles as a transcode for the critic path. `fit: 'inside'` preserves
 * aspect ratio; `withoutEnlargement` keeps an already-small image untouched in dimensions.
 */
export async function downscalePng(buf: Buffer, maxEdge = DEFAULT_MAX_EDGE): Promise<Buffer> {
  return sharp(buf, { failOn: 'none' })
    .resize(maxEdge, maxEdge, { fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer()
}

/**
 * Re-encode any decodable image to PNG at its native resolution — the >32 MB / non-PNG guard
 * (§10) and world-image commit path use this so only PNG bytes ever hit disk. A buffer that is
 * already valid PNG is round-tripped (cheap, and it strips exotic ancillary chunks).
 */
export async function transcodeToPng(buf: Buffer): Promise<Buffer> {
  return sharp(buf, { failOn: 'none' }).png().toBuffer()
}
