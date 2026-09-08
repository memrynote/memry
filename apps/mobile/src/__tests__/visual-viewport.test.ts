// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'

import {
  installVisibleViewportInset,
  visibleViewportBottomInset,
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

  it('derives keyboard visibility from the same inset that positions chrome', () => {
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
