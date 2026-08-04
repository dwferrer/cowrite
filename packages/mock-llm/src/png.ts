/**
 * Tiny valid PNGs, built from scratch (no image deps), plus `tEXt` chunk read/write.
 *
 * The mock ComfyUI embeds the submitted workflow JSON — including the injected `%prompt%`
 * text — into a `tEXt` chunk keyed `prompt` (exactly what real ComfyUI does), so a test can
 * assert end-to-end prompt injection from the committed bytes alone, no white-box hooks.
 */
import { deflateSync, inflateSync } from 'node:zlib'

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'latin1')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])))
  return Buffer.concat([length, typeBytes, data, crc])
}

export interface PngOptions {
  width?: number
  height?: number
  /** Flat fill color. */
  rgb?: [number, number, number]
}

/** Build a minimal, spec-valid 8-bit RGB PNG (default 4×4 mid-gray). */
export function buildPng(options?: PngOptions): Buffer {
  const width = options?.width ?? 4
  const height = options?.height ?? 4
  const [r, g, b] = options?.rgb ?? [128, 128, 128]

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.writeUInt8(8, 8) // bit depth
  ihdr.writeUInt8(2, 9) // color type: truecolor RGB
  // compression, filter, interlace all 0

  const stride = 1 + width * 3 // leading filter byte per scanline
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const row = y * stride
    raw[row] = 0 // filter: none
    for (let x = 0; x < width; x++) {
      raw[row + 1 + x * 3] = r
      raw[row + 2 + x * 3] = g
      raw[row + 3 + x * 3] = b
    }
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** Insert a `tEXt` chunk (keyword + NUL + text) immediately before IEND. */
export function addTextChunk(png: Buffer, keyword: string, text: string): Buffer {
  if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('not a PNG: bad signature')
  }
  if (keyword.length === 0 || keyword.length > 79) {
    throw new Error('tEXt keyword must be 1-79 characters')
  }
  const data = Buffer.concat([
    Buffer.from(keyword, 'latin1'),
    Buffer.from([0]),
    Buffer.from(text, 'utf8'),
  ])
  const textChunk = chunk('tEXt', data)
  const iendOffset = findChunkOffset(png, 'IEND')
  return Buffer.concat([png.subarray(0, iendOffset), textChunk, png.subarray(iendOffset)])
}

function findChunkOffset(png: Buffer, type: string): number {
  let offset = 8
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset)
    const chunkType = png.toString('latin1', offset + 4, offset + 8)
    if (chunkType === type) return offset
    offset += 12 + length
  }
  throw new Error(`PNG chunk ${type} not found`)
}

/** Read every `tEXt` chunk into a keyword → text map (later chunks win on duplicate keys). */
export function readTextChunks(png: Buffer): Record<string, string> {
  if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('not a PNG: bad signature')
  }
  const out: Record<string, string> = {}
  let offset = 8
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset)
    const chunkType = png.toString('latin1', offset + 4, offset + 8)
    if (chunkType === 'tEXt') {
      const data = png.subarray(offset + 8, offset + 8 + length)
      const nul = data.indexOf(0)
      if (nul > 0) {
        out[data.toString('latin1', 0, nul)] = data.toString('utf8', nul + 1)
      }
    }
    offset += 12 + length
  }
  return out
}

/** Decode the raw (filtered) scanline bytes — used by tests to prove the IDAT is real. */
export function inflateIdat(png: Buffer): Buffer {
  const offset = findChunkOffset(png, 'IDAT')
  const length = png.readUInt32BE(offset)
  return inflateSync(png.subarray(offset + 8, offset + 8 + length))
}
