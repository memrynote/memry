/**
 * `inlineImage`'s `parse` is the half that has to be exactly this narrow.
 *
 * It shares its element — `<img>` — with BlockNote's own `image` BLOCK, and the
 * two rules are asked in order until one matches. Claiming an image outside a
 * table cell would silently convert every picture in every existing note into
 * an inline one on its next load; claiming none inside a cell leaves #1640
 * broken. So the context test is the contract, and it is asserted directly here
 * rather than only through the converter.
 */

import { describe, expect, it } from 'vitest'
import {
  inlineImageConfig,
  inlineImageSerialization,
  parseInlineImageAlt,
  serializeInlineImageAlt
} from './inline-image'

function imgIn(html: string): HTMLElement {
  const host = document.createElement('div')
  host.innerHTML = html
  return host.querySelector('img') as HTMLElement
}

describe('inlineImage parse', () => {
  it('claims an image inside a table cell', () => {
    // #given the one place a picture cannot be a block
    const img = imgIn('<table><tbody><tr><td><img src="a.png" alt="A"></td></tr></tbody></table>')

    // #when / #then
    expect(inlineImageSerialization.parse(img)).toEqual({ src: 'a.png', alt: 'A', width: 0 })
  })

  it('claims an image inside a header cell', () => {
    const img = imgIn('<table><thead><tr><th><img src="a.png" alt=""></th></tr></thead></table>')
    expect(inlineImageSerialization.parse(img)).toEqual({ src: 'a.png', alt: '', width: 0 })
  })

  it('leaves an image in a paragraph to the image block', () => {
    // #given the shape every existing note's images arrive in
    const img = imgIn('<p><img src="a.png" alt="A"></p>')

    // #when / #then undefined is what makes BlockNote skip this rule and fall
    // through to the block spec — returning props here would rewrite the lot
    expect(inlineImageSerialization.parse(img)).toBeUndefined()
  })

  it('ignores a cell element that is not an image', () => {
    const host = document.createElement('div')
    host.innerHTML = '<table><tbody><tr><td><span data-x="1">hi</span></td></tr></tbody></table>'
    expect(
      inlineImageSerialization.parse(host.querySelector('span') as HTMLElement)
    ).toBeUndefined()
  })

  it('ignores a cell image with no src', () => {
    // #given nothing to point at — a node with an empty `src` serializes to
    // `![]()`, which is worse than not claiming the element at all
    const img = imgIn('<table><tbody><tr><td><img alt="A"></td></tr></tbody></table>')
    expect(inlineImageSerialization.parse(img)).toBeUndefined()
  })

  it('reads the raw attribute, not the resolved property', () => {
    // #given a note-relative ref, which is what the vault file holds
    const img = imgIn(
      '<table><tbody><tr><td><img src="../attachments/n1/p.png" alt="p"></td></tr></tbody></table>'
    )

    // #when / #then `.src` would hand back an absolute URL resolved against the
    // document base, and writing THAT back is how a vault stops being portable
    expect(inlineImageSerialization.parse(img)).toEqual({
      src: '../attachments/n1/p.png',
      alt: 'p',
      width: 0
    })
  })
})

describe('the width that rides in the alt text', () => {
  // A markdown image has no width, and the two obvious carriers are both dead
  // ends: `![a](x "300")` loses its title going through BlockNote, and a BARE
  // `| ![a|300](x) |` splits the row — `|` is the cell delimiter. Escaping is
  // remark's job: `a|300` in the alt attribute lands on disk as `![a\\|300](x)`.
  it('reads a numeric suffix as a width and keeps the name', () => {
    expect(parseInlineImageAlt('shot.png|300')).toEqual({ alt: 'shot.png', width: 300 })
  })

  it('leaves an alt with no suffix alone', () => {
    expect(parseInlineImageAlt('shot.png')).toEqual({ alt: 'shot.png', width: 0 })
  })

  it('leaves Obsidian’s `300x200` form as alt text', () => {
    // #given / #when / #then reading it as a width would re-serialize it as
    // `|300`, quietly rewriting somebody else's vault file to say something
    // slightly different. Unclaimed, it round-trips untouched.
    expect(parseInlineImageAlt('shot.png|300x200')).toEqual({
      alt: 'shot.png|300x200',
      width: 0
    })
  })

  it('ignores a zero suffix', () => {
    expect(parseInlineImageAlt('shot.png|0')).toEqual({ alt: 'shot.png|0', width: 0 })
  })

  it('writes the suffix back only when there is a width', () => {
    expect(serializeInlineImageAlt('shot.png', 300)).toBe('shot.png|300')
    expect(serializeInlineImageAlt('shot.png', 0)).toBe('shot.png')
  })

  it('round-trips a width through the alt', () => {
    const { alt, width } = parseInlineImageAlt(serializeInlineImageAlt('a b.png', 128))
    expect({ alt, width }).toEqual({ alt: 'a b.png', width: 128 })
  })

  it('takes a width seeded as a STRING, which is how the Y.Doc delivers it', () => {
    // #given attributes seeded into the shared doc are strings — a `"300"` read
    // as NaN surfaces as a `style.width: NaNpx` twelve calls away
    expect(serializeInlineImageAlt('a.png', '300')).toBe('a.png|300')
  })

  it('parses a real width attribute ahead of the alt convention', () => {
    // #given an HTML paste from the web, which carries a measurement rather than
    // a convention
    const img = imgIn(
      '<table><tbody><tr><td><img src="a.png" alt="q|120" width="300"></td></tr></tbody></table>'
    )
    expect(inlineImageSerialization.parse(img)).toEqual({ src: 'a.png', alt: 'q', width: 300 })
  })

  it('claims the alt width when there is no width attribute', () => {
    const img = imgIn(
      '<table><tbody><tr><td><img src="a.png" alt="q|120"></td></tr></tbody></table>'
    )
    expect(inlineImageSerialization.parse(img)).toEqual({ src: 'a.png', alt: 'q', width: 120 })
  })
})

describe('inlineImage serialization', () => {
  it('emits a real <img>, which is what becomes ![alt](src)', () => {
    // #given / #when
    const { dom } = inlineImageSerialization.toExternalHTML({
      props: { src: '../attachments/n1/p.png', alt: 'p.png' }
    })

    // #then a `<span>` holding the same text would be escaped to `!\[p.png]\(…\)`
    expect(dom.tagName).toBe('IMG')
    expect(dom.getAttribute('src')).toBe('../attachments/n1/p.png')
    expect(dom.getAttribute('alt')).toBe('p.png')
  })

  it('folds the width into the alt, which is the only place markdown keeps it', () => {
    // #given / #when
    const { dom } = inlineImageSerialization.toExternalHTML({
      props: { src: 'x.png', alt: 'shot.png', width: 300 }
    })

    // #then remark writes the `|` escaped, so the row stays one row
    expect(dom.getAttribute('alt')).toBe('shot.png|300')
  })

  it('is an atom with no content, so it cannot swallow the cell text', () => {
    expect(inlineImageConfig.content).toBe('none')
    expect(inlineImageConfig.type).toBe('inlineImage')
  })
})
