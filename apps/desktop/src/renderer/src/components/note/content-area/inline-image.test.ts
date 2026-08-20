/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The editor's `inlineImage` render has one job the main process's must not do
 * — resolve a note-relative `src` for display — and one rule about when: never
 * while BlockNote is serializing.
 *
 * BlockNote reaches this same function with `renderType: 'dom'` to serialize a
 * table cell, and reads the element it returns. An absolute
 * `memry-file:///Users/…/vault/…` landing on that `<img>` is what would get
 * written into the note's markdown, pinning it to this machine.
 */

import { describe, expect, it, vi } from 'vitest'
import { InlineImage, renderInlineImage } from './inline-image'

const RELATIVE = '../attachments/n1/photo.png'
const RESOLVED = 'memry-file://local/v/attachments/n1/photo.png'

function render(
  renderType: 'dom' | 'nodeView',
  src: string,
  resolveFileUrl?: (url: string) => Promise<string>
): HTMLElement {
  const node = { type: 'inlineImage', props: { src, alt: 'photo.png' } }
  return renderInlineImage.call({ renderType }, node, () => {}, { resolveFileUrl }).dom
}

/** The path BlockNote's exporter actually takes — no `this`, so no resolution. */
function renderThroughSpec(src: string, resolveFileUrl: (url: string) => Promise<string>) {
  const node = { type: 'inlineImage', props: { src, alt: 'photo.png' } }
  return (InlineImage as any).implementation.render(node, () => {}, { resolveFileUrl }).dom
}

describe('InlineImage render', () => {
  it('carries the on-disk src the moment it is built', () => {
    // #given / #when — no resolver at all, the main-process shape
    const dom = render('dom', RELATIVE)

    // #then
    expect(dom.getAttribute('src')).toBe(RELATIVE)
    expect(dom.getAttribute('alt')).toBe('photo.png')
  })

  it('never resolves while serializing', async () => {
    // #given the exact call BlockNote's exporter makes for a table cell
    const resolveFileUrl = vi.fn(async () => RESOLVED)

    // #when
    const dom = renderThroughSpec(RELATIVE, resolveFileUrl)
    await Promise.resolve()
    await Promise.resolve()

    // #then the resolver is not even asked: whatever is on this element is what
    // reaches the vault file, and it has to stay the portable relative ref
    expect(resolveFileUrl).not.toHaveBeenCalled()
    expect(dom.getAttribute('src')).toBe(RELATIVE)
  })

  it('resolves a note-relative src for the editing view', async () => {
    // #given a vault written by another app: `../Images/photo.png` resolves
    // against the renderer document base and 404s unless it is resolved
    const resolveFileUrl = vi.fn(async () => RESOLVED)

    // #when
    const dom = render('nodeView', RELATIVE, resolveFileUrl)
    await vi.waitFor(() => expect(dom.getAttribute('src')).toBe(RESOLVED))

    // #then
    expect(resolveFileUrl).toHaveBeenCalledWith(RELATIVE)
  })

  it('leaves a src that already has a scheme alone', async () => {
    // #given every attachment written before note-relative refs existed
    const resolveFileUrl = vi.fn(async () => RESOLVED)

    // #when
    const dom = render('nodeView', 'https://example.com/a.png', resolveFileUrl)
    await Promise.resolve()

    // #then
    expect(resolveFileUrl).not.toHaveBeenCalled()
    expect(dom.getAttribute('src')).toBe('https://example.com/a.png')
  })

  it('keeps the unresolved ref when resolution fails', async () => {
    // #given a resolver that rejects (no vault path yet, note not indexed)
    const resolveFileUrl = vi.fn(async () => {
      throw new Error('no vault')
    })

    // #when
    const dom = render('nodeView', RELATIVE, resolveFileUrl)
    await Promise.resolve()
    await Promise.resolve()

    // #then a broken image beats an unhandled rejection that takes the editor
    expect(dom.getAttribute('src')).toBe(RELATIVE)
  })
})
