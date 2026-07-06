import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

/**
 * Markdown + YAML frontmatter (spec 02 §5.1). Parsing is tolerant by design: external
 * editors strip or mangle frontmatter, and adoption — not rejection — is the failure
 * mode (§8), so parse never throws on user files.
 */

export interface ParsedFrontmatter {
  /** Parsed YAML value; undefined when there was no (or broken) frontmatter. */
  data: unknown
  /** The Markdown body (everything after the closing fence, verbatim). */
  body: string
  /** true when opening AND closing `---` fences were found. */
  hadFrontmatter: boolean
  /** Set when fences were found but the YAML between them failed to parse. */
  parseError?: string
}

// Opening fence: '---' as the very first line. Closing fence: a '---' line (trailing
// blanks tolerated) followed by a newline or end-of-file. CRLF tolerated throughout.
const FENCED = /^---[ \t]*\r?\n([\s\S]*?)^---[ \t]*\r?(?:\n|$)/m

export function parseFrontmatter(text: string): ParsedFrontmatter {
  const match = FENCED.exec(text)
  if (match?.index !== 0) {
    // No opening fence, or an opening fence with no closing fence: the whole file is body.
    return { data: undefined, body: text, hadFrontmatter: false }
  }
  const body = text.slice(match[0].length)
  const yamlText = match[1] ?? ''
  try {
    return { data: parseYaml(yamlText), body, hadFrontmatter: true }
  } catch (err) {
    return {
      data: undefined,
      body,
      hadFrontmatter: true,
      parseError: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * Serialize `data` between `---` fences followed by `body`, verbatim. Key order is the
 * insertion order of `data` (yaml's stringify preserves it), so output is deterministic
 * for a given object. `lineWidth: 0` disables line folding so long scalar values
 * round-trip byte-identically.
 */
export function serializeFrontmatter(data: Record<string, unknown>, body: string): string {
  const yamlText = stringifyYaml(data, { lineWidth: 0 })
  return `---\n${yamlText}---\n${body}`
}
