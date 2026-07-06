import xxhash from 'xxhash-wasm'

/**
 * xxh64 content hashing (spec 02 §10.1): output format `xxh64:<16 lowercase hex>`,
 * matching the shared `Hash` schema. The wasm module initializes asynchronously, so the
 * instance lives behind a lazy singleton — first caller pays the init, everyone shares it.
 */

type XxhashApi = Awaited<ReturnType<typeof xxhash>>

let apiPromise: Promise<XxhashApi> | null = null

function api(): Promise<XxhashApi> {
  apiPromise ??= xxhash()
  return apiPromise
}

function format(hash: string): string {
  return `xxh64:${hash}`
}

/** Hash a UTF-8 string → 'xxh64:<16 lowercase hex>'. */
export async function xxh64OfString(text: string): Promise<string> {
  const { h64ToString } = await api()
  return format(h64ToString(text))
}

/** Hash raw bytes (e.g. PNG contents) → 'xxh64:<16 lowercase hex>'. */
export async function xxh64OfBuffer(data: Uint8Array): Promise<string> {
  const { h64Raw } = await api()
  return format(h64Raw(data).toString(16).padStart(16, '0'))
}

/**
 * Word count via whitespace split — the staleness math of spec 02 §6.5 (illustration
 * word-delta) and the index's `word_count` columns both use this definition.
 */
export function wordCount(text: string): number {
  const trimmed = text.trim()
  if (trimmed === '') return 0
  return trimmed.split(/\s+/).length
}
