/**
 * SVG sanitizer for stored custom icons.
 *
 * @module icons/sanitize-svg.test
 */

import { describe, it, expect } from 'vitest'
import { sanitizeSvg, sanitizeSvgBytes } from './sanitize-svg'

function clean(svg: string): string {
  const out = sanitizeSvg(svg)
  expect(out).not.toBeNull()
  return out as string
}

describe('sanitizeSvg', () => {
  it('keeps a clean icon structurally intact', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
      '<path d="M4 4h16v16H4z" fill="#ff671a"/><circle cx="12" cy="12" r="4"/></svg>'
    const out = clean(svg)

    expect(out).toContain('<svg')
    expect(out).toContain('viewBox="0 0 24 24"')
    expect(out).toContain('d="M4 4h16v16H4z"')
    expect(out).toContain('<circle cx="12" cy="12" r="4"/>')
  })

  it('strips script elements and their contents', () => {
    const out = clean('<svg><script>fetch("https://evil.test")</script><rect/></svg>')

    expect(out).not.toMatch(/script/i)
    expect(out).not.toContain('evil.test')
    expect(out).toContain('<rect/>')
  })

  it('strips namespace-prefixed script and foreignObject elements', () => {
    const out = clean(
      '<svg xmlns:svg="http://www.w3.org/2000/svg">' +
        '<svg:script>alert(1)</svg:script>' +
        '<xhtml:script>alert(2)</xhtml:script>' +
        '<svg:foreignObject><b>markup</b></svg:foreignObject>' +
        '<a:b:script>alert(3)</a:b:script>' +
        '<script>alert(4)</svg:script>' +
        '<rect/></svg>'
    )

    expect(out).not.toMatch(/script/i)
    expect(out).not.toMatch(/foreignObject/i)
    expect(out).not.toContain('alert(1)')
    expect(out).not.toContain('alert(2)')
    expect(out).not.toContain('alert(3)')
    // Asymmetric prefixing: unprefixed open tag, prefixed close tag.
    expect(out).not.toContain('alert(4)')
    expect(out).not.toContain('markup')
    expect(out).toContain('<rect/>')
  })

  it('drops an unclosed forbidden element together with the rest of the document', () => {
    const out = clean('<svg><rect/><foreignObject><b onclick="x()">trailing</b></svg>')

    expect(out).not.toMatch(/foreignObject/i)
    expect(out).not.toContain('trailing')
    expect(out).toContain('<rect/>')
  })

  it('strips foreignObject elements and their contents', () => {
    const out = clean('<svg><foreignObject><body onload="x()">hi</body></foreignObject><g/></svg>')

    expect(out).not.toMatch(/foreignObject/i)
    expect(out).not.toContain('hi')
    expect(out).toContain('<g/>')
  })

  it('strips event handler attributes in any casing and quoting', () => {
    const out = clean(
      '<svg OnLoad="alert(1)"><rect onerror=\'alert(2)\' onclick=alert(3) fill="red"/></svg>'
    )

    expect(out.toLowerCase()).not.toContain('onload')
    expect(out.toLowerCase()).not.toContain('onerror')
    expect(out.toLowerCase()).not.toContain('onclick')
    expect(out).toContain('fill="red"')
  })

  it('strips javascript: and external URLs but keeps fragment references', () => {
    const out = clean(
      '<svg>' +
        '<use xlink:href="#glyph"/>' +
        '<use href="https://evil.test/x.svg#a"/>' +
        '<image href="file:///etc/passwd"/>' +
        '<image src="//evil.test/x.png"/>' +
        '<rect href="javascript:alert(1)"/>' +
        '</svg>'
    )

    expect(out).toContain('xlink:href="#glyph"')
    expect(out).not.toContain('evil.test')
    expect(out).not.toContain('file://')
    expect(out.toLowerCase()).not.toContain('javascript:')
  })

  it('unwraps anchors, keeping their drawing', () => {
    const out = clean('<svg><a href="https://evil.test"><path d="M0 0"/></a></svg>')

    expect(out).not.toMatch(/<a[\s>]/i)
    expect(out).not.toContain('evil.test')
    expect(out).toContain('<path d="M0 0"/>')
  })

  it('strips url() and expression() out of style attributes', () => {
    const out = clean(
      '<svg><rect style="fill:url(https://evil.test/x)"/><g style="fill:red"/></svg>'
    )

    expect(out).not.toContain('evil.test')
    expect(out).toContain('style="fill:red"')
  })

  it('drops style elements that reach outside the document', () => {
    const out = clean('<svg><style>@import url(https://evil.test/x.css);</style><rect/></svg>')

    expect(out).not.toContain('evil.test')
    expect(out).not.toContain('@import')
    expect(out).toContain('<rect/>')
  })

  it('strips DOCTYPE with an internal subset (billion laughs / XXE)', () => {
    const out = clean(
      '<?xml version="1.0"?>' +
        '<!DOCTYPE svg [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;">]>' +
        '<svg><text>&lol2;</text></svg>'
    )

    expect(out).not.toMatch(/DOCTYPE/i)
    expect(out).not.toMatch(/ENTITY/i)
    expect(out).toContain('<svg>')
  })

  it('drops external references from animation values whatever they target', () => {
    const out = clean(
      '<svg><rect><animate attributeName="fill" to="url(https://evil.test/x.png)"/>' +
        '<set attributeName="fill" to="javascript:alert(1)"/>' +
        '<animate attributeName="opacity" values="0;1"/></rect></svg>'
    )

    expect(out).not.toContain('evil.test')
    expect(out.toLowerCase()).not.toContain('javascript:')
    // A legitimate animation keeps its values.
    expect(out).toContain('values="0;1"')
  })

  it('catches obfuscated expression() in a style attribute', () => {
    const out = clean('<svg><rect style="width:expr\tession(alert(1))"/><g style="fill:red"/></svg>')

    expect(out).not.toContain('ession(')
    expect(out).toContain('style="fill:red"')
  })

  it('keeps the constructs a real icon depends on', () => {
    const svg =
      '<svg><title>Logo</title><desc>A logo</desc>' +
      '<defs><linearGradient id="grad"><stop offset="0"/></linearGradient>' +
      '<clipPath id="clip"><rect/></clipPath><mask id="m"><rect/></mask></defs>' +
      '<style>.a{fill:url(#grad)}</style>' +
      '<linearGradient id="grad2" xlink:href="#grad"/>' +
      '<use xlink:href="#glyph" clip-path="url(#clip)" style="fill:url(#grad)"/></svg>'
    const out = clean(svg)

    expect(out).toContain('<title>Logo</title>')
    expect(out).toContain('<desc>A logo</desc>')
    expect(out).toContain('<clipPath id="clip">')
    expect(out).toContain('<mask id="m">')
    expect(out).toContain('.a{fill:url(#grad)}')
    expect(out).toContain('xlink:href="#glyph"')
    expect(out).toContain('<linearGradient id="grad2" xlink:href="#grad"/>')
    expect(out).toContain('style="fill:url(#grad)"')
  })

  it('is idempotent, because ingest and the disk write both sanitize', () => {
    const dirty =
      '<svg onload="x()"><svg:script>alert(1)</svg:script>' +
      '<a href="https://evil.test"><path d="M0 0"/></a>' +
      '<use xlink:href="#g"/><style>.a{fill:url(#g)}</style></svg>'
    const once = clean(dirty)

    expect(sanitizeSvg(once)).toBe(once)
  })

  it('drops animation elements that retarget a reference', () => {
    const out = clean('<svg><use href="#a"><animate attributeName="href" to="javascript:x"/></use></svg>')

    expect(out).not.toMatch(/<animate/i)
    expect(out).toContain('href="#a"')
  })

  it('rejects input whose svg root does not survive', () => {
    expect(sanitizeSvg('<html><script>alert(1)</script></html>')).toBeNull()
    expect(sanitizeSvg('not an image at all')).toBeNull()
    expect(sanitizeSvgBytes(Buffer.from('<foreignObject/>'))).toBeNull()
  })

  it('round-trips bytes', () => {
    const out = sanitizeSvgBytes(Buffer.from('<svg><rect onclick="x()"/></svg>', 'utf8'))

    expect(out).not.toBeNull()
    expect(out?.toString('utf8')).toBe('<svg><rect/></svg>')
  })
})
