// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'

import {
  installVisibleViewportInset,
  visibleViewportBottomInset,
  visibleViewportOccludedHeight,
  visibleViewportState
} from '../../editor-web/src/visual-viewport'

// One real iPhone 17 Pro frame, keyboard up and the visual viewport at rest:
// a 539 layout viewport, 432 of it visible, so the keyboard covers 107.
const AT_REST = { layoutHeight: 539, viewportHeight: 432, viewportOffsetTop: 0 }

describe('editor visual viewport', () => {
  it('measures what the keyboard covers while the viewport is at rest', () => {
    expect(visibleViewportOccludedHeight(AT_REST)).toBe(107)
    expect(
      visibleViewportOccludedHeight({
        layoutHeight: 767,
        viewportHeight: 767,
        viewportOffsetTop: 0
      })
    ).toBe(0)
  })

  // Scrolling down with the keyboard up pans the visual viewport, after which
  // `height + offsetTop === layoutHeight` and the difference says nothing about
  // the keyboard. Believing it collapsed the inset and let the toolbar climb the
  // screen on the way down while the way back up looked fine (#2131).
  it('refuses to measure the keyboard from a panned viewport', () => {
    expect(
      visibleViewportOccludedHeight({
        layoutHeight: 539,
        viewportHeight: 370,
        viewportOffsetTop: 169
      })
    ).toBeNull()
    expect(
      visibleViewportOccludedHeight({
        layoutHeight: 539,
        viewportHeight: 204,
        viewportOffsetTop: 335
      })
    ).toBeNull()
  })

  it('pushes chrome back down as the pan carries the fixed layer up', () => {
    expect(visibleViewportBottomInset(107, 0)).toBe(107)
    expect(visibleViewportBottomInset(107, 107)).toBe(0)
    // Negative: past the occluded height the layer has travelled further than
    // the keyboard covers, so chrome belongs BELOW its bottom edge.
    expect(visibleViewportBottomInset(107, 169)).toBe(-62)
    expect(visibleViewportBottomInset(107, 335)).toBe(-228)
  })

  it('keeps the keyboard visible through a pan by reusing the resting measurement', () => {
    expect(visibleViewportState(AT_REST, 0)).toEqual({ bottomInset: 107, keyboardVisible: true })
    expect(
      visibleViewportState({ layoutHeight: 539, viewportHeight: 204, viewportOffsetTop: 335 }, 107)
    ).toEqual({ bottomInset: -228, keyboardVisible: true })
  })

  it('lets the keyboard go once the visible viewport is whole again', () => {
    expect(
      visibleViewportState({ layoutHeight: 767, viewportHeight: 767, viewportOffsetTop: 0 }, 107)
    ).toEqual({ bottomInset: 0, keyboardVisible: false })
  })

  it('holds chrome on the keyboard across a whole downward scroll', () => {
    // `bottom` of the fixed layer in its own client coordinates. WKWebView
    // carries the layer up with the pan, so this is what the inset has to
    // cancel; a pinned toolbar lands on 432 in every frame.
    const layerBottom = (viewportOffsetTop: number): number => 539 - viewportOffsetTop
    let occluded = 0
    const landings: number[] = []
    for (const frame of [
      AT_REST,
      { layoutHeight: 539, viewportHeight: 432, viewportOffsetTop: 107 },
      { layoutHeight: 539, viewportHeight: 370, viewportOffsetTop: 169 },
      { layoutHeight: 539, viewportHeight: 204, viewportOffsetTop: 335 }
    ]) {
      occluded = visibleViewportOccludedHeight(frame) ?? occluded
      const { bottomInset } = visibleViewportState(frame, occluded)
      landings.push(layerBottom(frame.viewportOffsetTop) - bottomInset)
    }
    expect(landings).toEqual([432, 432, 432, 432])
  })

  it('does not report the keyboard gone while the reader scrolls under it', () => {
    let offsetTop = 0
    let height = 432
    const listeners = new Set<EventListenerOrEventListenerObject>()
    const viewport = {
      get height() {
        return height
      },
      get offsetTop() {
        return offsetTop
      },
      addEventListener(_type: string, listener: EventListenerOrEventListenerObject) {
        listeners.add(listener)
      },
      removeEventListener(_type: string, listener: EventListenerOrEventListenerObject) {
        listeners.delete(listener)
      }
    }
    const dispatchScroll = (): void => {
      const event = new Event('scroll')
      for (const listener of listeners) {
        if (typeof listener === 'function') listener(event)
        else listener.handleEvent(event)
      }
    }
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 539 })
    Object.defineProperty(document.documentElement, 'clientHeight', {
      configurable: true,
      value: 539
    })
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport })
    const seen: boolean[] = []
    const controller = installVisibleViewportInset((visible) => seen.push(visible))

    for (const [nextOffsetTop, nextHeight] of [
      [107, 432],
      [169, 370],
      [335, 204]
    ]) {
      offsetTop = nextOffsetTop
      height = nextHeight
      dispatchScroll()
    }

    expect(controller.getState()).toEqual({ bottomInset: -228, keyboardVisible: true })
    // The install-time `true`, and nothing after it. A `false` here is the bug.
    expect(seen).toEqual([true])
    controller.destroy()
  })

  it('notifies native chrome only when keyboard visibility changes', () => {
    let viewportHeight = 650
    const listeners = new Set<EventListenerOrEventListenerObject>()
    const viewport = {
      get height() {
        return viewportHeight
      },
      offsetTop: 0,
      addEventListener(_type: string, listener: EventListenerOrEventListenerObject) {
        listeners.add(listener)
      },
      removeEventListener(_type: string, listener: EventListenerOrEventListenerObject) {
        listeners.delete(listener)
      }
    }
    const dispatchResize = (): void => {
      const event = new Event('resize')
      for (const listener of listeners) {
        if (typeof listener === 'function') listener(event)
        else listener.handleEvent(event)
      }
    }
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 650 })
    Object.defineProperty(document.documentElement, 'clientHeight', {
      configurable: true,
      value: 650
    })
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport })
    const seen: boolean[] = []
    const controller = installVisibleViewportInset((visible) => seen.push(visible))

    viewportHeight = 400
    dispatchResize()
    viewportHeight = 360
    dispatchResize()
    viewportHeight = 650
    dispatchResize()

    expect(seen).toEqual([true, false])
    controller.destroy()
    viewportHeight = 400
    dispatchResize()
    expect(seen).toEqual([true, false])
  })
})
