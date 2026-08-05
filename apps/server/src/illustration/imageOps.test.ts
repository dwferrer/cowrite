import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { readPngDimensions } from '../storage/lib/png.js'
import { downscalePng, transcodeToPng } from './imageOps.js'

/** A solid-color image of arbitrary dimensions in the requested format. */
async function makeImage(
  width: number,
  height: number,
  format: 'png' | 'jpeg' | 'webp',
): Promise<Buffer> {
  const base = sharp({
    create: { width, height, channels: 3, background: { r: 40, g: 90, b: 160 } },
  })
  return format === 'png' ? base.png().toBuffer() : base.toFormat(format).toBuffer()
}

describe('downscalePng', () => {
  it('reduces the longest edge to ≤ 768 and stays a valid PNG (landscape)', async () => {
    const out = await downscalePng(await makeImage(2000, 800, 'png'))
    const dims = readPngDimensions(out)
    expect(dims).not.toBeNull()
    expect(Math.max(dims?.width ?? 0, dims?.height ?? 0)).toBeLessThanOrEqual(768)
    // Aspect ratio preserved: 2000×800 → 768×307.
    expect(dims?.width).toBe(768)
    expect(dims?.height).toBe(307)
  })

  it('caps a portrait image on its height', async () => {
    const out = await downscalePng(await makeImage(600, 1500, 'png'))
    const dims = readPngDimensions(out)
    expect(dims?.height).toBe(768)
    expect(dims?.width).toBeLessThanOrEqual(768)
  })

  it('honors a custom maxEdge', async () => {
    const out = await downscalePng(await makeImage(1000, 1000, 'png'), 256)
    const dims = readPngDimensions(out)
    expect(dims?.width).toBe(256)
    expect(dims?.height).toBe(256)
  })

  it('never upscales an already-small image', async () => {
    const out = await downscalePng(await makeImage(300, 200, 'png'))
    const dims = readPngDimensions(out)
    expect(dims?.width).toBe(300)
    expect(dims?.height).toBe(200)
  })

  it('downscales AND transcodes a non-PNG input (webp) to a valid PNG', async () => {
    const out = await downscalePng(await makeImage(1600, 900, 'webp'))
    expect(readPngDimensions(out)).not.toBeNull()
    expect((await sharp(out).metadata()).format).toBe('png')
  })
})

describe('transcodeToPng', () => {
  it('re-encodes a JPEG to PNG at native resolution', async () => {
    const out = await transcodeToPng(await makeImage(1024, 512, 'jpeg'))
    const dims = readPngDimensions(out)
    expect(dims).toEqual({ width: 1024, height: 512 })
    expect((await sharp(out).metadata()).format).toBe('png')
  })

  it('round-trips an already-PNG buffer', async () => {
    const out = await transcodeToPng(await makeImage(64, 64, 'png'))
    expect(readPngDimensions(out)).toEqual({ width: 64, height: 64 })
  })

  it('rejects an undecodable buffer', async () => {
    await expect(transcodeToPng(Buffer.from('not an image'))).rejects.toThrow()
  })
})
