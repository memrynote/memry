import { describe, expect, it } from 'vitest'
import { planReaderNote } from '@memry/importers/readwise'
import { readerFullText } from './reader-full-text'

const HTML = `
<h1>Why notes compound</h1>
<p>First <strong>paragraph</strong> with a <a href="https://example.com/a">link</a> and <em>emphasis</em>.</p>
<img src="https://cdn.example.com/hero.jpg" alt="hero">
<blockquote><p>A quote worth keeping.</p></blockquote>
<h2>Steps</h2>
<ol><li>Capture</li><li>Connect <code>links</code></li></ol>
<ul><li>One</li><li>Two<ul><li>Nested</li></ul></li></ul>
<pre><code>const x = 1</code></pre>
<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>
<script>alert(1)</script>
`

describe('readerFullText', () => {
  it('converts an HTML-heavy article and leaves no remote image', async () => {
    const markdown = await readerFullText(HTML)
    expect(markdown).toMatchSnapshot()
    expect(markdown).not.toContain('cdn.example.com')
    expect(markdown).not.toContain('alert(1)')
  })

  it('feeds the mapper: the text stays below the section', async () => {
    const fullText = await readerFullText(HTML)
    const plan = planReaderNote(
      { id: 'a1', category: 'article', title: 'Why notes compound', parent_id: null },
      { root: 'Readwise', folderLayout: 'by-category', fullText }
    )
    expect(plan?.fullText).toBe(fullText)
    expect(plan?.section).not.toContain('Why notes compound')
  })
})
