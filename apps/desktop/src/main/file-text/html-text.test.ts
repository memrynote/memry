import { describe, expect, it } from 'vitest'
import { extractWikiLinks } from '../vault/frontmatter'
import { readHtmlText } from './html-text'

describe('readHtmlText', () => {
  it('keeps the visible text and drops scripts, styles, templates and comments', async () => {
    const text = await readHtmlText(
      '<style>p::after { content: "styled away" }</style>' +
        '<p>Visible <em>words</em></p>' +
        '<script type="module">document.body.append("scripted away")</script>' +
        '<noscript>Fallback away</noscript>' +
        '<template><p>Template away</p></template>' +
        '<!-- comment away -->'
    )

    expect(text).toBe('Visible words')
  })

  it('separates blocks, table cells and line breaks, and decodes entities', async () => {
    const text = await readHtmlText(
      '<ul><li>First&amp;one</li><li>Second</li></ul>' +
        '<table><tr><td>Cell&nbsp;a</td><td>Cell b</td></tr></table>' +
        'Line one<br>Line two'
    )

    expect(text).toBe('First&one\n\nSecond\n\nCell a\n\nCell b\n\nLine one\nLine two')
  })

  it('keeps link syntax inside code, pre, kbd and samp searchable but out of the links', async () => {
    const text = await readHtmlText(
      '<p>Write <code>[[Inline Code]]</code> or <kbd>[[Typed Keys]]</kbd>, ' +
        'see <samp>[[Sample Output]]</samp>.</p>' +
        '<pre><code>let a = "`"\n[[Fenced Code]]\n```</code></pre>' +
        '<p>Then [[Visible Link]].</p>'
    )

    for (const words of ['Inline Code', 'Typed Keys', 'Sample Output', 'Fenced Code']) {
      expect(text).toContain(words)
    }
    expect(extractWikiLinks(text)).toEqual(['Visible Link'])
  })

  it('reads a fragment with no html or body element', async () => {
    expect(await readHtmlText('Plain [[Linked Note]] text')).toBe('Plain [[Linked Note]] text')
  })
})
