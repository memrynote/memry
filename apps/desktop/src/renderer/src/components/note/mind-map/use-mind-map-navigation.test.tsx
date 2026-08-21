/**
 * Landing back in the note: the map closes, and then the block is scrolled to —
 * including when it is not in the document at the moment of the click.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { buildMindMap } from './build-mind-map'
import { useMindMapNavigation } from './use-mind-map-navigation'
import type { MindMapSourceBlock } from './mind-map-types'

function heading(id: string, level: number, text: string): MindMapSourceBlock {
  return { id, type: 'heading', props: { level }, content: [{ type: 'text', text }] }
}

const map = buildMindMap([heading('b-alpha', 1, 'Alpha')], {
  rootLabel: 'Test Note',
  noteId: 'note-1'
})
const alpha = map.nodes.find((node) => node.label === 'Alpha')!
const root = map.nodes.find((node) => node.kind === 'root')!

let container: HTMLElement
let top: HTMLElement
/** Every scroll the run asked for, in order, with what it was aimed at. */
let scrolled: Array<{ target: Element; options: boolean | ScrollIntoViewOptions | undefined }>

function setup(options: { smooth?: boolean } = {}) {
  const close = vi.fn()
  const view = renderHook(() =>
    useMindMapNavigation({
      close,
      getContainer: () => container,
      getTopElement: () => top,
      smooth: options.smooth ?? true
    })
  )
  return { close, view }
}

/** The block, once whatever gates the editor's render has let it through. */
function renderBlock(id: string): HTMLElement {
  const block = document.createElement('div')
  block.setAttribute('data-id', id)
  container.append(block)
  return block
}

beforeEach(() => {
  scrolled = []
  // Recording the element as well as the options: which one was scrolled is
  // the whole assertion, and jsdom implements none of this.
  Element.prototype.scrollIntoView = function scrollIntoViewStub(
    this: Element,
    options?: boolean | ScrollIntoViewOptions
  ): void {
    scrolled.push({ target: this, options })
  }
  container = document.createElement('div')
  top = document.createElement('div')
  document.body.append(container, top)
})

afterEach(() => {
  container.remove()
  top.remove()
})

describe('useMindMapNavigation', () => {
  it('closes the map before scrolling, because nothing hidden can be scrolled into view', () => {
    const { close, view } = setup()
    const block = renderBlock('b-alpha')

    act(() => view.result.current.navigateToBlock('b-alpha'))

    expect(close).toHaveBeenCalledTimes(1)
    expect(scrolled).toEqual([{ target: block, options: { behavior: 'smooth', block: 'start' } }])
  })

  it('waits for a block the content area has not rendered yet', async () => {
    const { view } = setup()

    // The window the note page's own heading anchor was written for: the map
    // named a target, and the editor's render is still behind its placeholder.
    act(() => view.result.current.navigateToBlock('b-alpha'))
    expect(scrolled).toHaveLength(0)

    const block = renderBlock('b-alpha')
    await waitFor(() => expect(scrolled.length).toBeGreaterThan(0))
    expect(scrolled[0].target).toBe(block)
    // Never smooth from here: there is no starting position for an animation to
    // be relative to when the content has not arrived.
    expect(scrolled[0].options).toEqual({ behavior: 'auto', block: 'start' })
  })

  it('calls a pending wait off when a second navigation starts', async () => {
    const { view } = setup()

    act(() => view.result.current.navigateToBlock('b-alpha'))
    act(() => view.result.current.navigateToBlock('b-beta'))

    const beta = renderBlock('b-beta')
    await waitFor(() => expect(scrolled.length).toBeGreaterThan(0))

    // Two waits racing would fight over the offset for the whole deadline.
    renderBlock('b-alpha')
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    for (const entry of scrolled) expect(entry.target).toBe(beta)
  })

  it('sends the root node to the top of the note', () => {
    const { close, view } = setup()

    act(() => view.result.current.activateNode(root))

    expect(close).toHaveBeenCalledTimes(1)
    expect(scrolled[0].target).toBe(top)
  })

  it('sends a heading node to its own block, through the same call the outline makes', () => {
    const { view } = setup()
    const block = renderBlock('b-alpha')

    act(() => view.result.current.activateNode(alpha))
    const fromMap = [...scrolled]
    scrolled = []

    // What the outline panel is handed, called with the same heading.
    act(() => view.result.current.navigateToBlock('b-alpha'))

    expect(fromMap).toEqual([{ target: block, options: { behavior: 'smooth', block: 'start' } }])
    expect(scrolled).toEqual(fromMap)
  })

  it('honours a request for less motion', () => {
    const { view } = setup({ smooth: false })
    renderBlock('b-alpha')

    act(() => view.result.current.navigateToBlock('b-alpha'))

    expect(scrolled[0].options).toEqual({ behavior: 'auto', block: 'start' })
  })
})
