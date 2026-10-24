import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useActiveHeading, type HeadingItem } from './use-active-heading'

let rafCallbacks: FrameRequestCallback[] = []

function flushRaf(): void {
  const callbacks = [...rafCallbacks]
  rafCallbacks = []
  callbacks.forEach((callback) => callback(0))
}

/** A scroll container that is nowhere near its bottom. */
function makePane(): HTMLDivElement {
  const pane = document.createElement('div')
  Object.defineProperties(pane, {
    scrollHeight: { value: 5000, configurable: true },
    clientHeight: { value: 800, configurable: true },
    scrollTop: { value: 0, configurable: true, writable: true }
  })
  document.body.append(pane)
  return pane
}

function addHeading(pane: HTMLElement, id: string, top: number): HTMLElement {
  const element = document.createElement('h2')
  element.dataset.id = id
  element.getBoundingClientRect = () => ({ top, bottom: top + 30 }) as DOMRect
  pane.append(element)
  return element
}

function headingItems(ids: string[]): HeadingItem[] {
  return ids.map((id, index) => ({ id, level: 2, text: id, position: index }))
}

describe('useActiveHeading', () => {
  beforeEach(() => {
    rafCallbacks = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      rafCallbacks.push(callback)
      return rafCallbacks.length
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('resolves headings inside its own pane when the same note is open in split view', () => {
    const paneA = makePane()
    const paneB = makePane()
    // Both panes render the same note, so the block ids are identical and a
    // document-wide lookup hands pane B the element that belongs to pane A.
    addHeading(paneA, 'block-1', 900)
    addHeading(paneA, 'block-2', 960)
    addHeading(paneB, 'block-1', 10)
    addHeading(paneB, 'block-2', 60)
    const scrollContainerRef = { current: paneB }

    const { result } = renderHook(() =>
      useActiveHeading({
        headings: headingItems(['block-1', 'block-2']),
        offset: 120,
        throttleMs: 0,
        scrollContainerRef
      })
    )

    act(flushRaf)

    expect(result.current.activeHeadingId).toBe('block-2')
  })

  it('stops querying the DOM for heading elements once they are resolved', () => {
    const pane = makePane()
    const ids = Array.from({ length: 60 }, (_, index) => `block-${index}`)
    // Every heading sits above the offset line, so the scan walks all 60.
    ids.forEach((id, index) => addHeading(pane, id, index * 10 - 500))
    const scrollContainerRef = { current: pane }

    const documentQuery = vi.spyOn(document, 'querySelector')
    const paneQuery = vi.spyOn(pane, 'querySelector')

    const { result } = renderHook(() =>
      useActiveHeading({
        headings: headingItems(ids),
        offset: 120,
        throttleMs: 0,
        scrollContainerRef
      })
    )

    act(flushRaf)
    expect(result.current.activeHeadingId).toBe('block-59')

    const lookupsToResolve = paneQuery.mock.calls.length
    documentQuery.mockClear()
    paneQuery.mockClear()

    for (let tick = 0; tick < 20; tick++) {
      act(() => {
        pane.dispatchEvent(new Event('scroll'))
      })
    }

    expect(result.current.activeHeadingId).toBe('block-59')
    expect(lookupsToResolve).toBe(60)
    expect(documentQuery).not.toHaveBeenCalled()
    expect(paneQuery).not.toHaveBeenCalled()
  })

  it('re-resolves a heading whose element the editor replaced', () => {
    const pane = makePane()
    addHeading(pane, 'block-1', -200)
    const stale = addHeading(pane, 'block-2', -100)
    addHeading(pane, 'block-3', 400)
    const scrollContainerRef = { current: pane }
    const headings = headingItems(['block-1', 'block-2', 'block-3'])

    const { result } = renderHook(() =>
      useActiveHeading({ headings, offset: 120, throttleMs: 0, scrollContainerRef })
    )

    act(flushRaf)
    expect(result.current.activeHeadingId).toBe('block-2')

    // A sync update rewrites the body: the old node is detached and a fresh
    // node carrying the same block id lands further down the document.
    stale.remove()
    addHeading(pane, 'block-2', 500)

    act(() => {
      pane.dispatchEvent(new Event('scroll'))
    })

    expect(result.current.activeHeadingId).toBe('block-1')
  })

  it('keeps its scroll subscription when the editor re-emits an identical headings array', () => {
    const pane = makePane()
    addHeading(pane, 'block-1', -100)
    addHeading(pane, 'block-2', 400)
    const scrollContainerRef = { current: pane }

    const addListener = vi.spyOn(pane, 'addEventListener')
    const removeListener = vi.spyOn(pane, 'removeEventListener')

    const { result, rerender } = renderHook(
      (headings: HeadingItem[]) =>
        useActiveHeading({ headings, offset: 120, throttleMs: 0, scrollContainerRef }),
      { initialProps: headingItems(['block-1', 'block-2']) }
    )

    act(flushRaf)
    const subscriptions = addListener.mock.calls.length

    // The editor re-extracts headings 200 ms after every keystroke and hands
    // back a brand-new array even when nothing about the outline changed.
    for (let sync = 0; sync < 5; sync++) {
      rerender(headingItems(['block-1', 'block-2']))
    }

    expect(addListener.mock.calls.length).toBe(subscriptions)
    expect(removeListener).not.toHaveBeenCalled()
    expect(result.current.activeHeadingId).toBe('block-1')
  })

  it('re-runs when a heading is added while the note is scrolled', () => {
    const pane = makePane()
    addHeading(pane, 'block-1', -300)
    addHeading(pane, 'block-2', 400)
    const scrollContainerRef = { current: pane }

    const { result, rerender } = renderHook(
      (headings: HeadingItem[]) =>
        useActiveHeading({ headings, offset: 120, throttleMs: 0, scrollContainerRef }),
      { initialProps: headingItems(['block-1', 'block-2']) }
    )

    act(flushRaf)
    expect(result.current.activeHeadingId).toBe('block-1')

    const inserted = document.createElement('h2')
    inserted.dataset.id = 'block-1a'
    inserted.getBoundingClientRect = () => ({ top: -50, bottom: -20 }) as DOMRect
    pane.insertBefore(inserted, pane.children[1])

    rerender(headingItems(['block-1', 'block-1a', 'block-2']))
    act(flushRaf)

    expect(result.current.activeHeadingId).toBe('block-1a')
  })
})
