/**
 * The editor's `inlineImage` render, and the one rule it cannot break.
 *
 * Inside a table BlockNote serializes cell content through ProseMirror's own
 * DOM serializer, which builds its HTML from `render` — there is no
 * `toExternalHTML` on that path. So whatever `src` the render puts on the
 * element is what lands in the vault file, and a resolved `memry-file://` URL
 * is an absolute path on ONE machine. This is the `linkMention` bug class
 * (#1433) with a worse payload.
 *
 * Serialization is synchronous end to end, so "the element holds the ref until
 * a promise resolves" is what keeps the bytes safe. That is what these assert:
 * synchronously, the ref; after a tick, the resolved URL.
 */

import { describe, expect, it, vi } from 'vitest'
import { InlineImage } from './inline-image'

const RELATIVE_SRC = '../attachments/n1/shot.png'
const RESOLVED_SRC = 'memry-file://local/Users/kaan/vault/attachments/n1/shot.png'

interface SpecImplementation {
  render: (content: unknown, update: () => void, editor: unknown) => { dom: HTMLElement }
}

function render(src: string, resolveFileUrl?: () => Promise<string>): HTMLElement {
  const { implementation } = InlineImage as unknown as { implementation: SpecImplementation }
  return implementation.render(
    { type: 'inlineImage', props: { src, alt: 'a shot' } },
    () => {},
    resolveFileUrl ? { resolveFileUrl } : {}
  ).dom
}

describe('the DOM a serializer reads carries the ref, never a resolved URL', () => {
  it('holds the note-relative src synchronously, before anything resolves', () => {
    // #given the render a table cell's serialization goes through
    const resolveFileUrl = vi.fn(async () => RESOLVED_SRC)

    // #when — read exactly as `serializeFragment` reads it: same tick, no await
    const dom = render(RELATIVE_SRC, resolveFileUrl)

    // #then the bytes that could reach the vault are the ref the note was
    // written with, not this machine's vault path
    expect(dom.getAttribute('src')).toBe(RELATIVE_SRC)
  })

  it('emits an img, which is what rehype-remark turns into `![alt](src)`', () => {
    const dom = render(RELATIVE_SRC)
    expect(dom.tagName).toBe('IMG')
    expect(dom.getAttribute('alt')).toBe('a shot')
  })
})

describe('the live element resolves so the image actually loads', () => {
  it('swaps in the resolved URL once the vault path is known', async () => {
    // #given a note-relative ref, which resolves against the renderer's own base
    // URL and 404s until the real URL arrives
    const resolveFileUrl = vi.fn(async () => RESOLVED_SRC)

    // #when
    const dom = render(RELATIVE_SRC, resolveFileUrl)

    // #then
    await vi.waitFor(() => expect(dom.getAttribute('src')).toBe(RESOLVED_SRC))
    expect(resolveFileUrl).toHaveBeenCalledWith(RELATIVE_SRC)
  })

  it('leaves the ref in place when resolution fails', async () => {
    // #given a vault lookup that rejects
    const resolveFileUrl = vi.fn(async () => {
      throw new Error('no vault')
    })

    // #when
    const dom = render(RELATIVE_SRC, resolveFileUrl)

    // #then a broken image the user can see beats an empty element they cannot
    await Promise.resolve()
    expect(dom.getAttribute('src')).toBe(RELATIVE_SRC)
  })

  it('never asks about an src that already carries a scheme', () => {
    // #given an https image, or one written before attachments became
    // note-relative
    const resolveFileUrl = vi.fn(async () => RESOLVED_SRC)

    // #when
    const dom = render('https://example.com/a.png', resolveFileUrl)

    // #then
    expect(dom.getAttribute('src')).toBe('https://example.com/a.png')
    expect(resolveFileUrl).not.toHaveBeenCalled()
  })
})
