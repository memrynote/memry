import { describe, expect, it } from 'vitest'
import { htmlToPlainText } from './html-to-plain-text'

describe('htmlToPlainText', () => {
  it('strips block tags and turns list items into bullet lines', () => {
    const result = htmlToPlainText('<h2>Fixes</h2><ul><li>Sync fix</li><li>Calendar fix</li></ul>')
    expect(result).toBe('Fixes\n• Sync fix\n• Calendar fix')
    expect(result).not.toMatch(/<[^>]+>/)
  })

  it('converts paragraphs and <br> to newlines', () => {
    expect(htmlToPlainText('<p>First line</p><p>Second<br>third</p>')).toBe(
      'First line\nSecond\nthird'
    )
  })

  it('decodes numeric and named HTML entities', () => {
    expect(htmlToPlainText('Tom &amp; Jerry &#39;quoted&#39; &#x2014; done &nbsp;here')).toBe(
      "Tom & Jerry 'quoted' — done  here"
    )
  })

  it('keeps inner text of links and inline tags, dropping the tags', () => {
    expect(
      htmlToPlainText('Fixed <a href="https://x/pull/529">#529</a> and <code>foo</code>')
    ).toBe('Fixed #529 and foo')
  })

  it('collapses excess blank lines and trims', () => {
    expect(htmlToPlainText('  <p>One</p>\n\n\n\n<p>Two</p>  ')).toBe('One\n\nTwo')
  })

  it('passes plain text through unchanged', () => {
    expect(htmlToPlainText('Just plain release notes')).toBe('Just plain release notes')
  })

  it('returns empty string for empty input', () => {
    expect(htmlToPlainText('')).toBe('')
  })
})
