import { describe, expect, it } from 'vitest'
import { maskRawHtmlForExport, sanitizeExportHtml } from './html-export'

/** The markdown through the mask and the sanitizer with an identity parser. */
function through(markdown: string): string {
  const { markdown: masked, finish } = maskRawHtmlForExport(markdown)
  return finish(masked)
}

describe('maskRawHtmlForExport', () => {
  it('hides a construct the editor shows as text and gives it back escaped', () => {
    const { markdown, finish } = maskRawHtmlForExport('a <script>x</script> b <kbd>k</kbd>')
    expect(markdown).not.toContain('<')
    expect(finish(markdown)).toBe('a &lt;script&gt;x&lt;/script&gt; b &lt;kbd&gt;k&lt;/kbd&gt;')
  })

  it('leaves the markdown alone when nothing is hidden', () => {
    expect(maskRawHtmlForExport('**b** `<script>`').markdown).toBe('**b** `<script>`')
  })

  it('keeps toggle markup and hides a details block that is no toggle', () => {
    const toggle =
      '<details data-memry-toggle>\n<summary>T <kbd>k</kbd></summary>\n\nb\n\n</details>'
    expect(through(toggle)).toBe(
      '<details data-memry-toggle>\n<summary>T &lt;kbd&gt;k&lt;/kbd&gt;</summary>\n\nb\n\n</details>'
    )
    expect(through('<details>\n<summary>T</summary>\n\nb\n\n</details>')).toBe(
      '&lt;details&gt;\n&lt;summary&gt;T&lt;/summary&gt;\n\nb\n\n&lt;/details&gt;'
    )
  })

  it('reads a summary outside a toggle as text', () => {
    expect(through('<summary>T</summary>')).toBe('&lt;summary&gt;T&lt;/summary&gt;')
  })
})

describe('sanitizeExportHtml', () => {
  it('escapes a tag the export does not carry, with its attributes', () => {
    expect(sanitizeExportHtml('<p>a<script src=x>alert(1)</script></p>')).toBe(
      '<p>a&lt;script src=x&gt;alert(1)&lt;/script&gt;</p>'
    )
    expect(sanitizeExportHtml('<svg onload=alert(1)>')).toBe('&lt;svg onload=alert(1)&gt;')
  })

  it('escapes a < that opens no whole tag', () => {
    expect(sanitizeExportHtml('<img src="x" onerror=alert(1)')).toBe(
      '&lt;img src="x" onerror=alert(1)'
    )
    expect(sanitizeExportHtml('1 < 2')).toBe('1 &lt; 2')
  })

  it('drops handlers and attributes outside the allowlist', () => {
    expect(
      sanitizeExportHtml('<img src="a.png" alt="a" onerror="alert(1)" srcset="b.png" ONLOAD=x>')
    ).toBe('<img src="a.png" alt="a">')
    expect(sanitizeExportHtml('<a href="https://a.example" target="_blank" ping="x">a</a>')).toBe(
      '<a href="https://a.example">a</a>'
    )
  })

  it.each([
    'javascript:alert(1)',
    ' JaVaScRiPt:alert(1)',
    'jav&#x09;ascript:alert(1)',
    'java&Tab;script:alert(1)',
    '&#106;avascript:alert(1)',
    'javascript&colon;alert(1)',
    'vbscript:x',
    'data:text/html;base64,PHNjcmlwdD4='
  ])('drops the address %s', (href) => {
    expect(sanitizeExportHtml(`<a href="${href}">x</a>`)).toBe('<a>x</a>')
  })

  it('keeps ordinary addresses and a data image on an img only', () => {
    expect(sanitizeExportHtml('<a href="mailto:a@b.example">x</a><a href="#fn-1">y</a>')).toBe(
      '<a href="mailto:a@b.example">x</a><a href="#fn-1">y</a>'
    )
    expect(sanitizeExportHtml('<a href="obsidian://open?vault=a&amp;file=b">x</a>')).toContain(
      'href='
    )
    const long = `data:image/png;base64,${'A'.repeat(5000)}`
    expect(sanitizeExportHtml(`<img src="${long}">`)).toBe(`<img src="${long}">`)
    expect(sanitizeExportHtml(`<a href="${long}">x</a>`)).toBe('<a>x</a>')
    expect(sanitizeExportHtml('<img src="data:text/html,<b>">')).toBe('<img>')
  })

  it('keeps a colour or decoration and drops the rest of a style', () => {
    expect(sanitizeExportHtml('<span style="color:red">a</span>')).toBe(
      '<span style="color:red">a</span>'
    )
    expect(sanitizeExportHtml('<span style="color: rgb(1, 2, 3); position:fixed">a</span>')).toBe(
      '<span style="color:rgb(1, 2, 3)">a</span>'
    )
    expect(sanitizeExportHtml('<span style="color:red;background:url(x)">a</span>')).toBe(
      '<span style="color:red">a</span>'
    )
    expect(sanitizeExportHtml('<span style="background-color:expression(alert(1))">a</span>')).toBe(
      '<span>a</span>'
    )
    expect(sanitizeExportHtml('<span style="color:&#117;rl(x)">a</span>')).toBe('<span>a</span>')
  })

  it('keeps a closed comment and escapes one a browser would end early or never end', () => {
    expect(sanitizeExportHtml('a<!---->b')).toBe('a<!---->b')
    expect(sanitizeExportHtml('<!--> <b>x</b>')).toBe('&lt;!--> <b>x</b>')
    expect(sanitizeExportHtml('<!-- never')).toBe('&lt;!-- never')
  })

  it('keeps a task checkbox the parser writes', () => {
    const input = '<li><input checked="" disabled="" type="checkbox"> a</li>'
    expect(sanitizeExportHtml(input)).toBe(input)
    expect(sanitizeExportHtml('<input type="text" onfocus=x>')).toBe(
      '&lt;input type=&quot;text&quot; onfocus=x&gt;'
    )
  })
})
