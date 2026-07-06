import { describe, expect, it } from 'vitest'
import { parseFrontmatter, serializeFrontmatter } from './frontmatter.js'

describe('parseFrontmatter', () => {
  it('parses data and body from a fenced document', () => {
    const text = '---\nid: 01J2P7R9GT5W0ZNXK3M8QAB4CD\nrev: 3\n---\nMara pressed her palm...\n'
    const parsed = parseFrontmatter(text)
    expect(parsed.hadFrontmatter).toBe(true)
    expect(parsed.parseError).toBeUndefined()
    expect(parsed.data).toEqual({ id: '01J2P7R9GT5W0ZNXK3M8QAB4CD', rev: 3 })
    expect(parsed.body).toBe('Mara pressed her palm...\n')
  })

  it('treats a file without frontmatter as pure body', () => {
    const parsed = parseFrontmatter('Just prose.\n\n---\n\nA scene break, not a fence.\n')
    expect(parsed).toEqual({
      data: undefined,
      body: 'Just prose.\n\n---\n\nA scene break, not a fence.\n',
      hadFrontmatter: false,
    })
  })

  it('treats an unclosed fence as pure body rather than throwing', () => {
    const text = '---\nid: abc\nno closing fence'
    const parsed = parseFrontmatter(text)
    expect(parsed.hadFrontmatter).toBe(false)
    expect(parsed.body).toBe(text)
  })

  it('returns a parse-error marker for broken YAML instead of throwing', () => {
    const parsed = parseFrontmatter('---\nid: [unclosed\n---\nbody\n')
    expect(parsed.hadFrontmatter).toBe(true)
    expect(parsed.data).toBeUndefined()
    expect(parsed.parseError).toBeTruthy()
    expect(parsed.body).toBe('body\n')
  })

  it('handles empty frontmatter', () => {
    const parsed = parseFrontmatter('---\n---\nbody\n')
    expect(parsed.hadFrontmatter).toBe(true)
    expect(parsed.data).toBeNull()
    expect(parsed.body).toBe('body\n')
  })

  it('tolerates CRLF line endings', () => {
    const parsed = parseFrontmatter('---\r\nid: abc\r\n---\r\nbody\r\n')
    expect(parsed.hadFrontmatter).toBe(true)
    expect(parsed.data).toEqual({ id: 'abc' })
    expect(parsed.body).toBe('body\r\n')
  })

  it('handles a closing fence at end-of-file with no body', () => {
    const parsed = parseFrontmatter('---\nid: abc\n---')
    expect(parsed.hadFrontmatter).toBe(true)
    expect(parsed.data).toEqual({ id: 'abc' })
    expect(parsed.body).toBe('')
  })

  it('parses YAML flow sequences like the spec sample', () => {
    const parsed = parseFrontmatter('---\nkeys: [Mara, Voss, the keeper]\n---\n')
    expect(parsed.data).toEqual({ keys: ['Mara', 'Voss', 'the keeper'] })
  })
})

describe('serializeFrontmatter', () => {
  it('writes fences with keys in insertion order', () => {
    const out = serializeFrontmatter({ id: 'abc', orderKey: 'i0', rev: 1 }, 'body\n')
    expect(out).toBe('---\nid: abc\norderKey: i0\nrev: 1\n---\nbody\n')
  })

  it('round-trips data and body exactly', () => {
    const data = {
      id: '01J2P7R9GT5W0ZNXK3M8QAB4CD',
      orderKey: 'i2',
      createdAt: '2026-07-06T14:02:11Z',
      authorship: 'agent',
      originRunId: null,
      keys: ['Mara', 'the keeper'],
      rev: 12,
    }
    const body = '# Heading\n\nProse with --- inline and\n\n---\n\na scene break.\n'
    const parsed = parseFrontmatter(serializeFrontmatter(data, body))
    expect(parsed.hadFrontmatter).toBe(true)
    expect(parsed.data).toEqual(data)
    expect(parsed.body).toBe(body)
  })

  it('is stable under repeated round-trips', () => {
    const once = serializeFrontmatter({ b: 2, a: 1 }, 'text\n')
    const parsed = parseFrontmatter(once)
    const twice = serializeFrontmatter(parsed.data as Record<string, unknown>, parsed.body)
    expect(twice).toBe(once)
  })

  it('does not fold long scalar values', () => {
    const long = 'x'.repeat(300)
    const parsed = parseFrontmatter(serializeFrontmatter({ note: long }, ''))
    expect(parsed.data).toEqual({ note: long })
  })
})
