import { describe, expect, it } from 'vitest'
import { planReaderNote } from '@memry/importers/readwise'
import { prepareReaderFullText } from './reader-full-text'

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

const saved = (urls: string[]) =>
  new Map(urls.map((url, i) => [url, `../../attachments/n1/rw-${i}.png`]))

describe('prepareReaderFullText', () => {
  it('converts an HTML-heavy article, keeps the image once saved, and leaves no remote URL', async () => {
    const text = await prepareReaderFullText(HTML)
    expect(text.imageUrls).toEqual(['https://cdn.example.com/hero.jpg'])

    const markdown = text.render(saved(text.imageUrls))

    expect(markdown).toMatchSnapshot()
    expect(markdown).not.toContain('cdn.example.com')
    expect(markdown).not.toContain('alert(1)')
  })

  it('leaves an image out when it was not saved', async () => {
    const text = await prepareReaderFullText(HTML)

    expect(text.render(new Map())).not.toContain('hero')
  })

  it('keeps a figure caption under the image, as the editor writes it', async () => {
    // The markup Reader sent for a page saved from memrynote.com (2026-10): the
    // image and its caption inside one <figure>, a single-candidate srcset.
    const text = await prepareReaderFullText(
      '<figure><img alt="Notes in MemryNote" src="https://cdn.example.com/n.webp" srcset="https://cdn.example.com/n-1100.webp 1100w,"/><figcaption>Notes in MemryNote</figcaption></figure>' +
        '<figure><img alt="No caption" src="https://cdn.example.com/b.webp"/></figure>'
    )

    expect(text.imageUrls).toEqual([
      'https://cdn.example.com/n.webp',
      'https://cdn.example.com/b.webp'
    ])
    expect(text.render(saved(text.imageUrls))).toBe(
      '<figure><img src="../../attachments/n1/rw-0.png"><figcaption>Notes in MemryNote</figcaption></figure>\n\n![No caption](../../attachments/n1/rw-1.png)'
    )
  })

  it('finds the image behind lazy-loading attributes, srcset, picture and relative URLs', async () => {
    const text = await prepareReaderFullText(
      [
        '<img src="data:image/gif;base64,R0lGOD" data-src="https://cdn.example.com/lazy.png">',
        '<img srcset="/img/small.png 400w, /img/large.png 1200w">',
        '<picture><source srcset="https://cdn.example.com/p.webp 2x"><img></picture>',
        '<img src="blob:nope">'
      ].join(''),
      'https://example.com/post/1'
    )

    expect(text.imageUrls).toEqual([
      'https://cdn.example.com/lazy.png',
      'https://example.com/img/large.png',
      'https://cdn.example.com/p.webp'
    ])
  })

  it('feeds the mapper: the text stays below the section', async () => {
    const fullText = (await prepareReaderFullText(HTML)).render(new Map())
    const plan = planReaderNote(
      { id: 'a1', category: 'article', title: 'Why notes compound', parent_id: null },
      { root: 'Readwise', folderLayout: 'by-category', fullText }
    )
    expect(plan?.fullText).toBe(fullText)
    expect(plan?.section).not.toContain('Why notes compound')
  })
})
