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

function renderDom(
  renderType: 'dom' | 'nodeView',
  props: Record<string, unknown>,
  resolveFileUrl?: (url: string) => Promise<string>,
  update: (content: unknown) => void = () => {}
): HTMLElement {
  const node = { type: 'inlineImage', props: { alt: 'photo.png', ...props } }
  return renderInlineImage.call({ renderType }, node, update, { resolveFileUrl }).dom
}

/** The editing-view picture, with whatever props the case is about. */
function render2(props: Record<string, unknown>): HTMLImageElement {
  const dom = renderDom('nodeView', props)
  return dom.querySelector('img') as HTMLImageElement
}

/** The picture itself — in the editing view it is wrapped for the resize grip. */
function render(
  renderType: 'dom' | 'nodeView',
  src: string,
  resolveFileUrl?: (url: string) => Promise<string>
): HTMLElement {
  const dom = renderDom(renderType, { src }, resolveFileUrl)
  return (dom.tagName === 'IMG' ? dom : dom.querySelector('img')) as HTMLElement
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

describe('InlineImage width', () => {
  it('applies an explicit width and lifts the CSS height cap with it', () => {
    // #given the cap (`max-height: 8em`) is what stops an un-sized screenshot
    // blowing a row out. Once a width is dragged it would silently override the
    // user — the picture would refuse to grow and the grip would look broken.
    const img = render2({ src: RELATIVE, width: 220 })

    // #then
    expect(img.style.width).toBe('220px')
    expect(img.style.maxHeight).toBe('none')
  })

  it('leaves an unsized image to the stylesheet', () => {
    const img = render2({ src: RELATIVE, width: 0 })
    expect(img.style.width).toBe('')
    expect(img.style.maxHeight).toBe('')
  })

  it('takes a width seeded as a STRING, which is how the Y.Doc delivers it', () => {
    // #given attributes on a synced doc are strings; `NaNpx` is what the naive
    // read produces, and it fails silently as "no width at all"
    expect(render2({ src: RELATIVE, width: '180' }).style.width).toBe('180px')
  })

  it('keeps the alt clean in the editor and folds the width in on the way out', () => {
    // #given `name|300` is a layout instruction, not something to read aloud
    expect(render2({ src: RELATIVE, width: 300 }).getAttribute('alt')).toBe('photo.png')

    // #when serializing — the alt is the only place markdown keeps a width
    const serialized = renderDom('dom', { src: RELATIVE, width: 300 })
    expect(serialized.tagName).toBe('IMG')
    expect(serialized.getAttribute('alt')).toBe('photo.png|300')
  })

  it('has no wrapper or grip to serialize into the cell', () => {
    const serialized = renderDom('dom', { src: RELATIVE, width: 300 })
    expect(serialized.querySelector('.inline-image-grip')).toBeNull()
  })
})

describe('InlineImage resize grip', () => {
  /** jsdom reports every box as 0×0, so the starting width is stubbed. */
  function gripAndImage(startWidth: number, update: (content: unknown) => void) {
    const wrap = renderDom('nodeView', { src: RELATIVE, width: startWidth }, undefined, update)
    const img = wrap.querySelector('img') as HTMLImageElement
    img.getBoundingClientRect = () => ({ width: startWidth }) as DOMRect
    const grip = wrap.querySelector('.inline-image-grip') as HTMLElement
    grip.setPointerCapture = vi.fn()
    return { grip, img }
  }

  function drag(grip: HTMLElement, from: number, to: number): void {
    grip.dispatchEvent(
      new MouseEvent('pointerdown', { clientX: from, bubbles: true, cancelable: true })
    )
    grip.dispatchEvent(new MouseEvent('pointermove', { clientX: to, bubbles: true }))
  }

  it('is offered in the editing view', () => {
    const wrap = renderDom('nodeView', { src: RELATIVE })
    expect(wrap.classList.contains('inline-image-wrap')).toBe(true)
    expect(wrap.querySelector('.inline-image-grip')).not.toBeNull()
  })

  it('resizes live while dragging', () => {
    // #given
    const update = vi.fn()
    const { grip, img } = gripAndImage(200, update)

    // #when
    drag(grip, 100, 160)

    // #then the picture follows the pointer…
    expect(img.style.width).toBe('260px')
    // …but nothing is written yet: a write per pointermove is one undo entry and
    // one CRDT update per pixel
    expect(update).not.toHaveBeenCalled()
  })

  it('writes the new width once, on release', () => {
    // #given
    const update = vi.fn()
    const { grip, img } = gripAndImage(200, update)
    drag(grip, 100, 160)
    img.getBoundingClientRect = () => ({ width: 260 }) as DOMRect

    // #when
    grip.dispatchEvent(new MouseEvent('pointerup', { clientX: 160, bubbles: true }))

    // #then
    expect(update).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith({
      type: 'inlineImage',
      props: { src: RELATIVE, alt: 'photo.png', width: 260 }
    })
  })

  it('will not drag a picture below a grabbable size', () => {
    // #given past this there is no grip left to grab and no picture left to see
    const { grip, img } = gripAndImage(60, vi.fn())

    // #when dragged far past zero
    drag(grip, 100, -400)

    // #then
    expect(img.style.width).toBe('24px')
  })

  it('swallows the pointerdown so ProseMirror does not read it as a selection', () => {
    // #given the grip lives inside a contenteditable
    const { grip } = gripAndImage(200, vi.fn())
    const event = new MouseEvent('pointerdown', { clientX: 10, bubbles: true, cancelable: true })

    // #when
    grip.dispatchEvent(event)

    // #then
    expect(event.defaultPrevented).toBe(true)
  })
})
