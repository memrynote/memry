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
import { inlineImageConfig, inlineImageSerialization } from './inline-image'

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
    expect(inlineImageSerialization.parse(img)).toEqual({ src: 'a.png', alt: 'A' })
  })

  it('claims an image inside a header cell', () => {
    const img = imgIn('<table><thead><tr><th><img src="a.png" alt=""></th></tr></thead></table>')
    expect(inlineImageSerialization.parse(img)).toEqual({ src: 'a.png', alt: '' })
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
      alt: 'p'
    })
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

  it('is an atom with no content, so it cannot swallow the cell text', () => {
    expect(inlineImageConfig.content).toBe('none')
    expect(inlineImageConfig.type).toBe('inlineImage')
  })
})
