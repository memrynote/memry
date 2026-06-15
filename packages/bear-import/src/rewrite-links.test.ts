import { describe, it, expect } from 'vitest'
import { rewriteBearLinks } from './rewrite-links.ts'

describe('rewriteBearLinks', () => {
  it('rewrites a mapped bear link to wiki-link', () => {
    const idMap = new Map([['ABC-123', 'My Note']])
    const body = '[Link text](bear://x-callback-url/open-note?id=ABC-123)'
    const result = rewriteBearLinks(body, idMap)
    expect(result).toBe('[[My Note]]')
  })

  it('leaves unmapped bear links as-is', () => {
    const idMap = new Map<string, string>()
    const body = '[Link text](bear://x-callback-url/open-note?id=UNKNOWN-999)'
    const result = rewriteBearLinks(body, idMap)
    expect(result).toBe(body)
  })

  it('handles bear links with additional query params', () => {
    const idMap = new Map([['DEF-456', 'Other Note']])
    const body = '[see this](bear://x-callback-url/open-note?title=foo&id=DEF-456&show_window=yes)'
    const result = rewriteBearLinks(body, idMap)
    expect(result).toBe('[[Other Note]]')
  })

  it('rewrites multiple links', () => {
    const idMap = new Map([
      ['ID-1', 'Note One'],
      ['ID-2', 'Note Two']
    ])
    const body =
      '[one](bear://x-callback-url/open-note?id=ID-1) and [two](bear://x-callback-url/open-note?id=ID-2)'
    const result = rewriteBearLinks(body, idMap)
    expect(result).toBe('[[Note One]] and [[Note Two]]')
  })

  it('leaves non-bear links untouched', () => {
    const idMap = new Map([['X', 'Y']])
    const body = '[click](https://example.com)'
    const result = rewriteBearLinks(body, idMap)
    expect(result).toBe(body)
  })
})
