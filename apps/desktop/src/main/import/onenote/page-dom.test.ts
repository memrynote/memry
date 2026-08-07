/**
 * Unit tests for the OneNote DOM transforms, driven through jsdom + the shared
 * HTML→markdown walker exactly as the importer runs them.
 */

import { describe, it, expect } from 'vitest'
import { JSDOM } from 'jsdom'
import { htmlToMarkdown } from '../_shared/html-to-markdown'
import {
  collectFileAttachments,
  collectRemoteImages,
  convertCodeRuns,
  convertInternalLinks,
  convertMathToLatex,
  convertOneNoteTags,
  convertStyledElements,
  convertVideoEmbeds,
  mergeCodeParagraphs,
  replaceWithParagraphText,
  sanitizeOcrText
} from './page-dom'

function bodyOf(html: string): Element {
  return new JSDOM(html).window.document.body
}

describe('convertOneNoteTags', () => {
  it('turns to-do tags into task prefixes and collects note tags', () => {
    const body = bodyOf(
      '<p data-tag="to-do">Buy milk</p>' +
        '<p data-tag="to-do:completed">Done thing</p>' +
        '<p data-tag="important,project-a">Note text</p>'
    )
    const tags = convertOneNoteTags(body)
    const { markdown } = htmlToMarkdown(body)

    expect(markdown).toContain('- [ ] Buy milk')
    expect(markdown).toContain('- [x] Done thing')
    expect(tags.sort()).toEqual(['important', 'project-a'])
    expect(markdown).not.toContain('data-tag')
  })

  it('normalizes colons in tag names', () => {
    const body = bodyOf('<p data-tag="to-do:priority:high">x</p><p data-tag="a:b">y</p>')
    // to-do:priority... still starts with to-do → task; a:b → a-b tag.
    const tags = convertOneNoteTags(body)
    expect(tags).toEqual(['a-b'])
  })
})

describe('convertInternalLinks', () => {
  it('unwraps onenote: links to their text', () => {
    const body = bodyOf(
      '<p><a href="onenote:https://d.docs.live.net/x#page-id={1}&end">My page</a> and ' +
        '<a href="https://example.com">web</a></p>'
    )
    convertInternalLinks(body)
    const { markdown } = htmlToMarkdown(body)
    expect(markdown).toContain('My page and [web](https://example.com)')
    expect(markdown).not.toContain('onenote:')
  })
})

describe('convertVideoEmbeds', () => {
  it('turns youtube iframes into markdown links and others into anchors', () => {
    const body = bodyOf(
      '<iframe src="https://www.youtube.com/embed/abc"></iframe>' +
        '<iframe src="https://other.example/v/1"></iframe>' +
        '<iframe></iframe>'
    )
    convertVideoEmbeds(body)
    const { markdown } = htmlToMarkdown(body)
    expect(markdown).toContain('[Embedded video](https://www.youtube.com/embed/abc)')
    expect(markdown).toContain('[https://other.example/v/1](https://other.example/v/1)')
    expect(body.querySelector('iframe')).toBeNull()
  })
})

describe('convertMathToLatex', () => {
  it('replaces MathML with inline latex', () => {
    const body = bodyOf(
      '<p>Formula: <math xmlns="http://www.w3.org/1998/Math/MathML">' +
        '<mfrac><mn>1</mn><mn>2</mn></mfrac></math></p>'
    )
    convertMathToLatex(body)
    const { markdown } = htmlToMarkdown(body)
    expect(markdown).toContain('Formula: $\\frac{1}{2}$')
  })
})

describe('code conversion', () => {
  it('converts a lone Consolas span into inline code', () => {
    const body = bodyOf('<p>Run <span style="font-family:Consolas">npm test</span> locally</p>')
    convertCodeRuns(body)
    const { markdown } = htmlToMarkdown(body)
    expect(markdown).toContain('Run `npm test` locally')
  })

  it('merges code paragraphs split by <br> into one fenced block', () => {
    const body = bodyOf(
      '<p><span style="font-family:Consolas">const a = 1</span></p>' +
        '<br>' +
        '<p><span style="font-family:Consolas">const b = 2</span></p>'
    )
    mergeCodeParagraphs(body)
    convertCodeRuns(body)
    const { markdown } = htmlToMarkdown(body)
    expect(markdown).toContain('```\nconst a = 1\nconst b = 2\n```')
  })

  it('joins sibling code spans separated by <br> into one block', () => {
    const body = bodyOf(
      '<p><span style="font-family:Consolas">line one</span><br>' +
        '<span style="font-family:Consolas">line two</span></p>'
    )
    convertCodeRuns(body)
    const { markdown } = htmlToMarkdown(body)
    expect(markdown).toContain('```\nline one\nline two\n```')
  })
})

describe('convertStyledElements', () => {
  it('maps styled spans to semantic markdown', () => {
    const body = bodyOf(
      '<p><span style="font-weight:bold">B</span> ' +
        '<span style="font-style:italic">I</span> ' +
        '<span style="text-decoration:line-through">S</span> ' +
        '<span style="background-color:yellow">H</span></p>'
    )
    convertStyledElements(body)
    const { markdown } = htmlToMarkdown(body)
    expect(markdown).toContain('**B**')
    expect(markdown).toContain('*I*')
    expect(markdown).toContain('~~S~~')
    expect(markdown).toContain('==H==')
  })

  it('only strips styles from table cells', () => {
    const body = bodyOf('<table><tr><td style="font-weight:bold">Cell</td></tr></table>')
    convertStyledElements(body)
    expect(body.querySelector('td')).not.toBeNull()
    expect(body.querySelector('td')?.getAttribute('style')).toBeNull()
  })
})

describe('attachment collection', () => {
  it('collects object attachments and hoists their children', () => {
    const body = bodyOf(
      '<p><object data-attachment="report.pdf" data="https://graph.microsoft.com/v1.0/res/1/$value" type="application/pdf"><span>inside</span></object></p>' +
        '<object data="no-name"></object>'
    )
    const refs = collectFileAttachments(body)
    expect(refs).toHaveLength(1)
    expect(refs[0].originalName).toBe('report.pdf')
    expect(refs[0].url).toContain('/res/1/')
    // Child content survived the hoist; the nameless object was dropped.
    expect(body.textContent).toContain('inside')
    expect(body.querySelectorAll('object')).toHaveLength(1)
  })

  it('collects remote images, preferring the full-res source', () => {
    const body = bodyOf(
      '<img src="https://graph.microsoft.com/v1.0/res/low/$value" ' +
        'data-fullres-src="https://graph.microsoft.com/v1.0/res/full/$value" ' +
        'data-fullres-src-type="image/png" alt="Some OCR text from OneNote">' +
        '<img src="onenote-img-0">'
    )
    const refs = collectRemoteImages(body)
    expect(refs).toHaveLength(1)
    expect(refs[0].url).toContain('/res/full/')
    expect(refs[0].mime).toBe('image/png')
    expect(refs[0].alt).toBe('Some OCR text from OneNote')
  })
})

describe('sanitizeOcrText', () => {
  it('strips markdown-hostile characters and truncates', () => {
    expect(sanitizeOcrText('a [link](x) `code`')).toBe('a linkx code')
    expect(sanitizeOcrText('x'.repeat(80))).toHaveLength(51)
    expect(sanitizeOcrText('  spaced   out  ')).toBe('spaced out')
  })
})

describe('security + fidelity guards', () => {
  it('only collects attachments hosted on Graph, leaving foreign refs alone', () => {
    const body = bodyOf(
      '<img src="https://graph.microsoft.com/v1.0/res/1/$value">' +
        '<img src="https://attacker.example/pixel.png">' +
        '<object data-attachment="x.pdf" data="https://attacker.example/x.pdf"></object>'
    )
    const images = collectRemoteImages(body)
    expect(images).toHaveLength(1)
    expect(images[0].url).toContain('graph.microsoft.com')
    // The foreign object is dropped rather than downloaded with a bearer token.
    expect(collectFileAttachments(body)).toEqual([])
    // The foreign image stays in the document as a plain external reference.
    expect(body.querySelectorAll('img')).toHaveLength(2)
  })

  it('ignores a full-res source that points off Graph', () => {
    const body = bodyOf(
      '<img src="https://graph.microsoft.com/v1.0/res/low/$value" ' +
        'data-fullres-src="https://attacker.example/full.png">'
    )
    expect(collectRemoteImages(body)[0].url).toContain('graph.microsoft.com')
  })

  it('hoists object children in document order', () => {
    const body = bodyOf(
      '<p><object data-attachment="a.pdf" data="https://graph.microsoft.com/v1.0/r/$value">' +
        '<span>one</span><span>two</span><span>three</span></object></p>'
    )
    collectFileAttachments(body)
    expect(body.textContent).toBe('onetwothree')
  })

  it('renders a to-do list item as a checkbox, not a doubled marker', () => {
    const body = bodyOf(
      '<ul><li data-tag="to-do">Buy milk</li><li data-tag="to-do:completed">Done</li></ul>'
    )
    convertOneNoteTags(body)
    const { markdown } = htmlToMarkdown(body)
    expect(markdown).toBe('- [ ] Buy milk\n- [x] Done')
  })

  it('keeps list items and links while applying every matching style', () => {
    const body = bodyOf(
      '<ul><li style="background-color:yellow">Highlighted item</li></ul>' +
        '<p><a href="https://example.com" style="font-weight:bold">Link</a></p>' +
        '<p><span style="font-weight:bold;background-color:yellow">Both</span></p>'
    )
    convertStyledElements(body)
    const { markdown } = htmlToMarkdown(body)
    expect(markdown).toContain('- ==Highlighted item==')
    expect(markdown).toContain('[**Link**](https://example.com)')
    expect(markdown).toContain('**==Both==**')
  })

  it('does not treat a white or transparent background as a highlight', () => {
    const body = bodyOf(
      '<p><span style="background-color:white">plain</span>' +
        '<span style="background-color:transparent">also plain</span></p>'
    )
    convertStyledElements(body)
    const { markdown } = htmlToMarkdown(body)
    expect(markdown).not.toContain('==')
  })

  it('places a file-block marker on its own line when the object sits inline', () => {
    const body = bodyOf(
      '<p>Report attached: <object data-attachment="r.pdf" data="https://graph.microsoft.com/v1.0/r/$value"></object> see it.</p>'
    )
    const [ref] = collectFileAttachments(body)
    replaceWithParagraphText(ref.el, '<!-- file:{"url":"x"} -->')
    const { markdown } = htmlToMarkdown(body)
    const markerLine = markdown.split('\n').find((line) => line.includes('<!-- file:'))
    expect(markerLine).toBe('<!-- file:{"url":"x"} -->')
  })

  it('keeps non-Latin OCR text', () => {
    expect(sanitizeOcrText('Türkçe metin çok güzel')).toBe('Türkçe metin çok güzel')
    expect(sanitizeOcrText('日本語のテキスト')).toBe('日本語のテキスト')
  })
})
