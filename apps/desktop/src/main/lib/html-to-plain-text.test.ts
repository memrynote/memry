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

  it('single-spaces blocks, keeping a blank line only before headings', () => {
    expect(htmlToPlainText('  <p>One</p>\n\n\n\n<p>Two</p>  ')).toBe('One\nTwo')
  })

  it('single-spaces loose-list bullets and blanks only before section headings', () => {
    const html =
      '<h2>New Features</h2><ul><li><p>Feature one (#1)</p></li><li><p>Feature two (#2)</p></li></ul><h2>Bug Fixes</h2><ul><li><p>Bug one (#3)</p></li></ul>'
    expect(htmlToPlainText(html)).toBe(
      'New Features\n• Feature one (#1)\n• Feature two (#2)\n\nBug Fixes\n• Bug one (#3)'
    )
  })

  it('passes plain text through unchanged', () => {
    expect(htmlToPlainText('Just plain release notes')).toBe('Just plain release notes')
  })

  it('returns empty string for empty input', () => {
    expect(htmlToPlainText('')).toBe('')
  })
})
