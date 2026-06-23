import { describe, it, expect } from 'vitest'
import { interFileWikilink } from './rewrite-links.ts'

function makeMap(entries: [string, string][]): Map<string, string> {
  return new Map(entries.map(([k, v]) => [k.toLowerCase(), v]))
}

describe('interFileWikilink', () => {
  const map = makeMap([
    ['page-two', 'Page Two'],
    ['my notes', 'My Notes']
  ])

  it('returns the title when the href basename matches an imported file', () => {
    expect(interFileWikilink('page-two.html', map)).toBe('Page Two')
  })

  it('resolves relative paths (leading ./ or subdir)', () => {
    expect(interFileWikilink('./page-two.html', map)).toBe('Page Two')
    expect(interFileWikilink('sub/page-two.html', map)).toBe('Page Two')
  })

  it('strips fragment and query before matching', () => {
    expect(interFileWikilink('page-two.html#section', map)).toBe('Page Two')
    expect(interFileWikilink('page-two.html?v=1', map)).toBe('Page Two')
  })

  it('is case-insensitive', () => {
    expect(interFileWikilink('Page-Two.html', map)).toBe('Page Two')
    expect(interFileWikilink('PAGE-TWO.HTML', map)).toBe('Page Two')
  })

  it('returns null for hrefs that do not match any imported file', () => {
    expect(interFileWikilink('unknown.html', map)).toBeNull()
    expect(interFileWikilink('https://example.com', map)).toBeNull()
  })

  it('handles percent-encoded hrefs', () => {
    expect(interFileWikilink('my%20notes.html', map)).toBe('My Notes')
  })

  it('matches .htm extension too', () => {
    const map2 = makeMap([['page-two', 'Page Two']])
    expect(interFileWikilink('page-two.htm', map2)).toBe('Page Two')
  })
})
