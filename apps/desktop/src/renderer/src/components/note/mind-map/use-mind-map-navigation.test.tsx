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

const map = buildMindMap(
  [
    heading('b-alpha', 1, 'Alpha'),
    {
      id: 'b-item',
      type: 'bulletListItem',
      content: [{ type: 'wikiLink', props: { target: 'Roadmap', alias: 'the plan' } }]
    },
    { id: 'b-task', type: 'taskBlock', props: { taskId: 't-1', title: 'Cut the build' } }
  ],
  {
    rootLabel: 'Test Note',
    noteId: 'note-1'
  }
)
const alpha = map.nodes.find((node) => node.label === 'Alpha')!
const root = map.nodes.find((node) => node.kind === 'root')!
const link = map.nodes.find((node) => node.kind === 'wikiLink')!
const task = map.nodes.find((node) => node.kind === 'task')!

/** A note wide enough that the root folds its overflow behind a marker. */
const marker = buildMindMap(
  Array.from({ length: 40 }, (_, index) => heading(`b-${index}`, 1, `Section ${index}`)),
  { rootLabel: 'Test Note', noteId: 'note-1' }
).nodes.find((node) => node.kind === 'more')!

let container: HTMLElement
let top: HTMLElement
/** Every scroll the run asked for, in order, with what it was aimed at. */
let scrolled: Array<{ target: Element; options: boolean | ScrollIntoViewOptions | undefined }>

function setup(options: { smooth?: boolean; canFocus?: boolean } = {}) {
  const close = vi.fn()
  const openNote = vi.fn()
  const openTask = vi.fn()
  const expandBranch = vi.fn()
  // What a live map answers: true once it has moved its camera onto the block.
  // False is every other state — closed, not mounted, or asked for a block it
  // never drew — and is the default here because most of this file is about
  // the path taken when the map cannot answer.
  const focusBlock = vi.fn(() => options.canFocus ?? false)
  const view = renderHook(() =>
    useMindMapNavigation({
      close,
      expandBranch,
      getContainer: () => container,
      getTopElement: () => top,
      smooth: options.smooth ?? true,
      openNote,
      openTask,
      focusBlock
    })
  )
  return { close, openNote, openTask, expandBranch, focusBlock, view }
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

  it('opens a fold marker in place, without closing the map or scrolling', () => {
    const { close, expandBranch, view } = setup()

    act(() => view.result.current.activateNode(marker))

    expect(expandBranch).toHaveBeenCalledWith(marker.id)
    // A fold is undone where it is: closing the map here would hide the branch
    // the user just asked to see. (A wiki link also leaves the map open, but it
    // leaves the NOTE — this one goes nowhere at all.)
    expect(close).not.toHaveBeenCalled()
    expect(scrolled).toHaveLength(0)
  })

  it('sends the root node to the top of the note', () => {
    const { close, view } = setup()

    act(() => view.result.current.activateNode(root))

    expect(close).toHaveBeenCalledTimes(1)
    expect(scrolled[0].target).toBe(top)
  })

  it('sends a heading node to its own block, and the outline lands in the same place', () => {
    const { view } = setup()
    const block = renderBlock('b-alpha')

    act(() => view.result.current.activateNode(alpha))
    const fromMap = [...scrolled]
    scrolled = []

    // The outline's own entry point, called with the same heading. It only
    // diverges while a map is showing that block; with none, the two agree.
    act(() => view.result.current.navigateFromOutline('b-alpha'))

    expect(fromMap).toEqual([{ target: block, options: { behavior: 'smooth', block: 'start' } }])
    expect(scrolled).toEqual(fromMap)
  })

  it('moves the open map\'s camera on an outline click, and leaves the map open', () => {
    const { close, focusBlock, view } = setup({ canFocus: true })
    renderBlock('b-alpha')

    act(() => view.result.current.navigateFromOutline('b-alpha'))

    expect(focusBlock).toHaveBeenCalledWith('b-alpha')
    // The panel sits over the picture on purpose: on a map too big to see at
    // once it is the only way to reach a far branch, so the click has to be a
    // move rather than an exit.
    expect(close).not.toHaveBeenCalled()
    expect(scrolled).toEqual([])
  })

  it('falls back to opening the note when the map did not draw that block', () => {
    const { close, focusBlock, view } = setup({ canFocus: false })
    const block = renderBlock('b-alpha')

    act(() => view.result.current.navigateFromOutline('b-alpha'))

    // A heading folded behind a "+N more", or dropped at the node cap, has no
    // box to move to. The click still has to go somewhere.
    expect(focusBlock).toHaveBeenCalledWith('b-alpha')
    expect(close).toHaveBeenCalledTimes(1)
    expect(scrolled).toEqual([{ target: block, options: { behavior: 'smooth', block: 'start' } }])
  })

  it('still closes the map when a node on it is clicked, even though the map can focus', () => {
    const { close, focusBlock, view } = setup({ canFocus: true })
    const block = renderBlock('b-alpha')

    act(() => view.result.current.activateNode(alpha))

    // The regression this split exists to prevent: a box on the map is a place
    // in the NOTE, so clicking it has to leave the map rather than re-centre on
    // the thing the user just clicked.
    expect(focusBlock).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledTimes(1)
    expect(scrolled).toEqual([{ target: block, options: { behavior: 'smooth', block: 'start' } }])
  })

  it('hands a wiki-link node to the page, leaving the map where it was', () => {
    const { close, openNote, openTask, view } = setup()

    act(() => view.result.current.activateNode(link))

    // The target as written — the page's own wiki-link handler resolves it, so
    // the map inherits the open-in-new-tab preference instead of inventing one.
    expect(openNote).toHaveBeenCalledWith('Roadmap')
    expect(openTask).not.toHaveBeenCalled()
    // Nothing in THIS note was asked for, so nothing here closes or scrolls:
    // the linked note arrives in whichever tab the preference says.
    expect(close).not.toHaveBeenCalled()
    expect(scrolled).toEqual([])
  })

  it('hands a task node to the page, leaving the map where it was', () => {
    const { close, openNote, openTask, view } = setup()

    act(() => view.result.current.activateNode(task))

    expect(openTask).toHaveBeenCalledWith('t-1')
    expect(openNote).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
    expect(scrolled).toEqual([])
  })

  it('honours a request for less motion', () => {
    const { view } = setup({ smooth: false })
    renderBlock('b-alpha')

    act(() => view.result.current.navigateToBlock('b-alpha'))

    expect(scrolled[0].options).toEqual({ behavior: 'auto', block: 'start' })
  })
})
