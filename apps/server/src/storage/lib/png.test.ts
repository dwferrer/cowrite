import { describe, expect, it } from 'vitest'
import { readPngDimensions } from './png.js'

function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33)
  const view = new DataView(bytes.buffer)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0) // signature
  view.setUint32(8, 13) // IHDR payload length
  bytes.set([0x49, 0x48, 0x44, 0x52], 12) // 'IHDR'
  view.setUint32(16, width)
  view.setUint32(20, height)
  // bit depth, color type, compression, filter, interlace + CRC left zeroed —
  // the probe only reads the signature and the first 8 bytes of the IHDR payload.
  return bytes
}

describe('readPngDimensions', () => {
  it('reads width and height from the IHDR chunk', () => {
    expect(readPngDimensions(pngHeader(640, 480))).toEqual({ width: 640, height: 480 })
    expect(readPngDimensions(pngHeader(1, 1))).toEqual({ width: 1, height: 1 })
  })

  it('handles views into a larger buffer (non-zero byteOffset)', () => {
    const padded = new Uint8Array(40)
    padded.set(pngHeader(320, 200), 7)
    expect(readPngDimensions(padded.subarray(7))).toEqual({ width: 320, height: 200 })
  })

  it('returns null for a wrong signature', () => {
    const bytes = pngHeader(10, 10)
    bytes[0] = 0xff
    expect(readPngDimensions(bytes)).toBeNull()
  })

  it('returns null when IHDR is not the first chunk', () => {
    const bytes = pngHeader(10, 10)
    bytes.set([0x49, 0x44, 0x41, 0x54], 12) // 'IDAT'
    expect(readPngDimensions(bytes)).toBeNull()
  })

  it('returns null for a wrong IHDR payload length', () => {
    const bytes = pngHeader(10, 10)
    new DataView(bytes.buffer).setUint32(8, 12)
    expect(readPngDimensions(bytes)).toBeNull()
  })

  it('returns null for truncated input', () => {
    expect(readPngDimensions(new Uint8Array(0))).toBeNull()
    expect(readPngDimensions(pngHeader(10, 10).subarray(0, 23))).toBeNull()
  })

  it('returns null for zero or out-of-range dimensions', () => {
    expect(readPngDimensions(pngHeader(0, 10))).toBeNull()
    expect(readPngDimensions(pngHeader(10, 0))).toBeNull()
    expect(readPngDimensions(pngHeader(0x80000000, 10))).toBeNull()
  })
})
