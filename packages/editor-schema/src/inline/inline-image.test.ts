/**
 * The `inlineImage` boundary (#1640).
 *
 * The spec's whole risk is `parse`: it runs as a `tag: '*'` rule, so it is
 * consulted for every element of every document BlockNote parses, and the one
 * thing it must never do is claim an image the `image` BLOCK used to claim.
 * Every note in every vault has those.
 */

import { describe, expect, it } from 'vitest'
import { inlineImageSerialization } from './inline-image'

/** Parse an HTML fragment and hand back the `<img>` in it, in a real tree. */
function imgIn(html: string): HTMLElement {
  const host = document.createElement('div')
  host.innerHTML = html
  const img = host.querySelector('img')
  if (!img) throw new Error(`no <img> in ${html}`)
  return img
}

describe('parse leaves block images alone', () => {
  it('declines an image that is the whole of its paragraph', () => {
    // #given the shape `![x](y)` on its own line arrives as
    // #when
    const parsed = inlineImageSerialization.parse(imgIn('<p><img src="a.png" alt="x"></p>'))

    // #then undefined makes ProseMirror skip this rule and keep looking, which
    // is how the image BLOCK still gets it. Anything else silently changes the
    // node type of every image in every existing note.
    expect(parsed).toBeUndefined()
  })

  it('declines an image whose paragraph holds only whitespace beside it', () => {
    // #given remark-rehype leaves newlines between the tags
    // #when / #then whitespace is not content
    expect(inlineImageSerialization.parse(imgIn('<p>\n  <img src="a.png">\n</p>'))).toBeUndefined()
  })

  it('declines anything that is not an image', () => {
    const span = document.createElement('span')
    span.textContent = 'not an image'
    expect(inlineImageSerialization.parse(span)).toBeUndefined()
  })

  it('declines an image with no src', () => {
    expect(inlineImageSerialization.parse(imgIn('<p>a <img alt="x"></p>'))).toBeUndefined()
  })
})

describe('parse claims the images that had no node at all', () => {
  it('claims an image inside a table cell, even alone in it', () => {
    // #given the case the issue is about: GFM allows phrasing content in a cell,
    // and a cell's content is inline-only, so no block rule can take this one
    // #when
    const parsed = inlineImageSerialization.parse(
      imgIn('<table><tr><td><img src="../attachments/n1/shot.png" alt="shot"></td></tr></table>')
    )

    // #then
    expect(parsed).toEqual({ src: '../attachments/n1/shot.png', alt: 'shot' })
  })

  it('claims an image alone in a heading, which no block rule can take', () => {
    // #given a heading's content is inline-only in BlockNote, so the image
    // block rule cannot replace it — before this node the image was dropped
    // and `# ![x](y)` came back as an empty heading
    // #when / #then
    expect(inlineImageSerialization.parse(imgIn('<h1><img src="a.png" alt="x"></h1>'))).toEqual({
      src: 'a.png',
      alt: 'x'
    })
  })

  it('claims an image sitting beside text in a paragraph', () => {
    // #given an image glued to the end of a line — what Apple Notes and Bear
    // exports produce, and what used to be dropped on parse
    // #when / #then
    expect(inlineImageSerialization.parse(imgIn('<p>before <img src="a.png"> after</p>'))).toEqual({
      src: 'a.png',
      alt: ''
    })
  })

  it('keeps a note-relative src exactly as written', () => {
    // #given `element.src` would resolve this against the document base URL and
    // hand back `http://localhost/…`, which is what would then reach the vault
    // #when
    const parsed = inlineImageSerialization.parse(
      imgIn('<p>x <img src="../attachments/n1/a.png"></p>')
    )

    // #then
    expect(parsed?.src).toBe('../attachments/n1/a.png')
  })
})

describe('toExternalHTML writes the ref, not a resolved URL', () => {
  it('emits an img carrying the raw src and alt', () => {
    // #given / #when
    const { dom } = inlineImageSerialization.toExternalHTML({
      props: { src: '../attachments/n1/a.png', alt: 'a shot' }
    })

    // #then rehype-remark turns exactly this into `![a shot](../attachments/n1/a.png)`
    expect(dom.outerHTML).toBe('<img src="../attachments/n1/a.png" alt="a shot">')
  })

  it('omits alt when there is none, so the markdown stays `![](src)`', () => {
    const { dom } = inlineImageSerialization.toExternalHTML({ props: { src: 'a.png', alt: '' } })
    expect(dom.outerHTML).toBe('<img src="a.png">')
  })
})
