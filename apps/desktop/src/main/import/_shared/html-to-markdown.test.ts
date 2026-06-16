import { describe, it, expect } from 'vitest'
import { JSDOM } from 'jsdom'
import { htmlToMarkdown, decodeRef, percentDecodeRef } from './html-to-markdown'

function convert(html: string, hooks?: Parameters<typeof htmlToMarkdown>[1]) {
  const doc = new JSDOM(`<body>${html}</body>`).window.document
  return htmlToMarkdown(doc.body, hooks)
}

describe('htmlToMarkdown', () => {
  it('renders headings, paragraphs and rules', () => {
    const { markdown } = convert('<h1>Title</h1><p>Body text</p><hr><h3>Sub</h3>')
    expect(markdown).toBe('# Title\n\nBody text\n\n---\n\n### Sub')
  })

  it('renders inline emphasis, code and line breaks', () => {
    const { markdown } = convert(
      '<p><strong>b</strong> <em>i</em> <del>d</del> <mark>m</mark> <code>c</code><br>next</p>'
    )
    expect(markdown).toBe('**b** *i* ~~d~~ ==m== `c`\nnext')
  })

  it('renders ordered, unordered and todo lists', () => {
    const ul = convert('<ul><li>one</li><li>two</li></ul>').markdown
    expect(ul).toBe('- one\n- two')
    const ol = convert('<ol><li>a</li><li>b</li></ol>').markdown
    expect(ol).toBe('1. a\n2. b')
    const todo = convert(
      '<ul><li><input type="checkbox" checked>done</li><li><input type="checkbox">open</li></ul>'
    ).markdown
    expect(todo).toBe('- [x] done\n- [ ] open')
  })

  it('renders code blocks with language and blockquotes', () => {
    const code = convert('<pre><code class="language-ts">const x = 1</code></pre>').markdown
    expect(code).toBe('```ts\nconst x = 1\n```')
    const quote = convert('<blockquote><p>line one</p><p>line two</p></blockquote>').markdown
    expect(quote).toBe('> line one\n>\n> line two')
  })

  it('renders tables with a header divider', () => {
    const { markdown } = convert(
      '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>'
    )
    expect(markdown).toBe('| A | B |\n| --- | --- |\n| 1 | 2 |')
  })

  it('keeps external links and images, collecting local refs by default', () => {
    const link = convert('<p><a href="https://x.com">site</a></p>')
    expect(link.markdown).toBe('[site](https://x.com)')
    expect(link.assets).toEqual([])

    const localLink = convert('<p><a href="../files/doc.pdf">doc</a></p>')
    expect(localLink.markdown).toBe('[doc](files/doc.pdf)')
    expect(localLink.assets).toEqual(['files/doc.pdf'])

    const img = convert('<p><img src="pics/a.png" alt="A"></p>')
    expect(img.markdown).toBe('![A](pics/a.png)')
    expect(img.assets).toEqual(['pics/a.png'])

    const dataImg = convert('<p><img src="data:image/png;base64,AAAA" alt="d"></p>')
    expect(dataImg.markdown).toBe('![d](data:image/png;base64,AAAA)')
    expect(dataImg.assets).toEqual([])
  })

  it('lets hooks override anchors, images and skip blocks', () => {
    const { markdown, assets } = convert(
      '<table class="meta"><tr><td>x</td></tr></table><p><a href="note.html">N</a> <img src="i.png" alt=""></p>',
      {
        skipBlock: (el) => el.tagName.toLowerCase() === 'table' && el.classList.contains('meta'),
        anchor: (href, text) => (href === 'note.html' ? `[[${text}]]` : null),
        image: (src, _alt, collect) => {
          collect(src)
          return `![saved](${src})`
        }
      }
    )
    expect(markdown).toBe('[[N]] ![saved](i.png)')
    expect(assets).toEqual(['i.png'])
  })
})

describe('decodeRef', () => {
  it('strips parent segments and percent-decodes', () => {
    expect(decodeRef('../../My%20File.png')).toBe('My File.png')
  })
  it('returns the raw ref when decoding fails', () => {
    expect(decodeRef('bad%ref')).toBe('bad%ref')
  })
})

describe('percentDecodeRef', () => {
  it('percent-decodes but preserves ../ segments (unlike decodeRef)', () => {
    expect(percentDecodeRef('../images/My%20File.png')).toBe('../images/My File.png')
  })
  it('returns the raw ref when decoding fails', () => {
    expect(percentDecodeRef('bad%ref')).toBe('bad%ref')
  })
})
