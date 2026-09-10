// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'

import {
  installVisibleViewportInset,
  visibleViewportBottomInset,
  visibleViewportOccludedHeight,
  visibleViewportState
} from '../../editor-web/src/visual-viewport'

describe('editor visual viewport', () => {
  it('moves fixed chrome above the software keyboard', () => {
    expect(
      visibleViewportBottomInset({
        layoutHeight: 650,
        viewportHeight: 360,
        viewportOffsetTop: 0
      })
    ).toBe(290)
  })

  it('accounts for a visible viewport offset', () => {
    expect(
      visibleViewportBottomInset({
        layoutHeight: 650,
        viewportHeight: 600,
        viewportOffsetTop: 20
      })
    ).toBe(30)
  })

  it('never creates a negative inset', () => {
    expect(
      visibleViewportBottomInset({
        layoutHeight: 650,
        viewportHeight: 650,
        viewportOffsetTop: 10
      })
    ).toBe(0)
  })

  it('reads the keyboard as gone only when the visible viewport is whole again', () => {
    expect(
      visibleViewportState({
        layoutHeight: 650,
        viewportHeight: 360,
        viewportOffsetTop: 0
      })
    ).toEqual({ bottomInset: 290, keyboardVisible: true })
    expect(
      visibleViewportState({
        layoutHeight: 650,
        viewportHeight: 650,
        viewportOffsetTop: 0
      })
    ).toEqual({ bottomInset: 0, keyboardVisible: false })
  })

  // The numbers are one frame of a real iPhone 17 Pro scroll, taken off the
  // WebView while the keyboard was up: `offsetTop` climbs to the whole occluded
  // height, the inset it drives correctly reaches zero because chrome pinned to
  // the layout viewport's bottom is already sitting on the keyboard, and the
  // keyboard is still there. Deriving visibility from that zero deleted the
  // formatting toolbar part-way down every note (#2131).
  it('keeps the keyboard visible once a scroll has zeroed the inset', () => {
    expect(
      visibleViewportState({
        layoutHeight: 539,
        viewportHeight: 432,
        viewportOffsetTop: 107
      })
    ).toEqual({ bottomInset: 0, keyboardVisible: true })
  })

  it('measures occlusion independently of the scroll offset', () => {
    const occluded = { layoutHeight: 539, viewportHeight: 432 }
    expect(visibleViewportOccludedHeight({ ...occluded, viewportOffsetTop: 0 })).toBe(107)
    expect(visibleViewportOccludedHeight({ ...occluded, viewportOffsetTop: 107 })).toBe(107)
    expect(
      visibleViewportOccludedHeight({
        layoutHeight: 767,
        viewportHeight: 767,
        viewportOffsetTop: 0
      })
    ).toBe(0)
  })

  it('does not report the keyboard gone while the reader scrolls under it', () => {
    let offsetTop = 0
    const listeners = new Set<EventListenerOrEventListenerObject>()
    const viewport = {
      height: 432,
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

    for (offsetTop of [0, 40, 80, 107]) dispatchScroll()

    expect(controller.getState()).toEqual({ bottomInset: 0, keyboardVisible: true })
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
