import { describe, expect, it } from 'vitest'
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

  it('reads a fragment with no html or body element', async () => {
    expect(await readHtmlText('Plain [[Linked Note]] text')).toBe('Plain [[Linked Note]] text')
  })
})
