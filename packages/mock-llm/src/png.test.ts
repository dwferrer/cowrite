import { describe, expect, it } from 'vitest'
import { addTextChunk, buildPng, crc32, inflateIdat, PNG_SIGNATURE, readTextChunks } from './png.js'

describe('buildPng', () => {
  it('produces a spec-valid PNG: signature, IHDR geometry, real IDAT, IEND', () => {
    const png = buildPng({ width: 3, height: 2, rgb: [10, 20, 30] })
    expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true)
    // IHDR immediately follows the signature.
    expect(png.toString('latin1', 12, 16)).toBe('IHDR')
    expect(png.readUInt32BE(16)).toBe(3) // width
    expect(png.readUInt32BE(20)).toBe(2) // height
    // IEND terminates the file.
    expect(png.toString('latin1', png.length - 8, png.length - 4)).toBe('IEND')
    // The IDAT inflates to filter-prefixed RGB scanlines with our fill color.
    const raw = inflateIdat(png)
    expect(raw.length).toBe(2 * (1 + 3 * 3))
    expect([raw[0], raw[1], raw[2], raw[3]]).toEqual([0, 10, 20, 30])
  })

  it('has valid CRCs on every chunk', () => {
    const png = buildPng()
    let offset = 8
    let chunksSeen = 0
    while (offset + 8 <= png.length) {
      const length = png.readUInt32BE(offset)
      const typeAndData = png.subarray(offset + 4, offset + 8 + length)
      const stored = png.readUInt32BE(offset + 8 + length)
      expect(stored).toBe(crc32(typeAndData))
      chunksSeen += 1
      offset += 12 + length
    }
    expect(chunksSeen).toBe(3) // IHDR, IDAT, IEND
  })
})

describe('tEXt chunks', () => {
  it('round-trips keyword → text and keeps the chunk before IEND', () => {
    const text = 'a lighthouse keeper, oil painting — "storm glass" & unicode: café'
    const png = addTextChunk(buildPng(), 'prompt', text)
    expect(readTextChunks(png)).toEqual({ prompt: text })
    // Still terminated by IEND after insertion.
    expect(png.toString('latin1', png.length - 8, png.length - 4)).toBe('IEND')
    // And the embedded text is discoverable from raw bytes (the black-box injection probe).
    expect(png.includes(Buffer.from('storm glass', 'utf8'))).toBe(true)
  })

  it('supports multiple chunks', () => {
    let png = buildPng()
    png = addTextChunk(png, 'prompt', '{"6":{"text":"hello"}}')
    png = addTextChunk(png, 'seed', '42')
    expect(readTextChunks(png)).toEqual({ prompt: '{"6":{"text":"hello"}}', seed: '42' })
  })

  it('rejects invalid keywords and non-PNG buffers', () => {
    expect(() => addTextChunk(buildPng(), '', 'x')).toThrow(/keyword/)
    expect(() => addTextChunk(buildPng(), 'k'.repeat(80), 'x')).toThrow(/keyword/)
    expect(() => addTextChunk(Buffer.from('not a png'), 'k', 'x')).toThrow(/signature/)
    expect(() => readTextChunks(Buffer.from('nope'))).toThrow(/signature/)
  })
})
