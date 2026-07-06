/**
 * Dependency-free PNG dimension probe: the index stores illustration pixel dims read
 * from the PNG header at index time (spec 02 §7.1).
 */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const IHDR_LENGTH = 13

/**
 * Parse the 8-byte PNG signature plus the IHDR chunk (which the PNG spec requires to
 * come first, with a fixed 13-byte payload). Returns null for anything that is not a
 * well-formed PNG header — never throws.
 */
export function readPngDimensions(data: Uint8Array): { width: number; height: number } | null {
  // signature (8) + IHDR length (4) + 'IHDR' (4) + width (4) + height (4)
  if (data.byteLength < 24) return null
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (data[i] !== PNG_SIGNATURE[i]) return null
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  if (view.getUint32(8) !== IHDR_LENGTH) return null
  // 'IHDR'
  if (data[12] !== 0x49 || data[13] !== 0x48 || data[14] !== 0x44 || data[15] !== 0x52) return null
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  // The PNG spec caps dimensions at 2^31-1 and forbids zero.
  if (width === 0 || height === 0 || width > 0x7fffffff || height > 0x7fffffff) return null
  return { width, height }
}
