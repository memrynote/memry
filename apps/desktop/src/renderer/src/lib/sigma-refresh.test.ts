import { renderHook } from '@testing-library/react'
import type { Sigma } from 'sigma'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { refreshSigmaIfMeasurable, useRepaintSigmaWhenContainerRegainsWidth } from './sigma-refresh'

function fakeSigma(container: HTMLElement): { sigma: Sigma; refresh: ReturnType<typeof vi.fn> } {
  const refresh = vi.fn()
  return {
    sigma: { getContainer: () => container, refresh } as unknown as Sigma,
    refresh
  }
}

function containerWithWidth(initial: number): {
  container: HTMLElement
  setWidth: (w: number) => void
} {
  let width = initial
  const container = document.createElement('div')
  Object.defineProperty(container, 'offsetWidth', { configurable: true, get: () => width })
  return { container, setWidth: (w) => (width = w) }
}

describe('refreshSigmaIfMeasurable', () => {
  it('skips the render for a 0px container and renders otherwise', () => {
    const { container, setWidth } = containerWithWidth(0)
    const { sigma, refresh } = fakeSigma(container)

    expect(refreshSigmaIfMeasurable(sigma)).toBe(false)
    expect(refresh).not.toHaveBeenCalled()

    setWidth(300)
    expect(refreshSigmaIfMeasurable(sigma)).toBe(true)
    expect(refresh).toHaveBeenCalledTimes(1)
  })
})

describe('useRepaintSigmaWhenContainerRegainsWidth', () => {
  const OriginalResizeObserver = globalThis.ResizeObserver

  afterEach(() => {
    globalThis.ResizeObserver = OriginalResizeObserver
  })

  function captureResizeObserver(): {
    fire: () => void
    disconnect: ReturnType<typeof vi.fn>
  } {
    let callback: ResizeObserverCallback | null = null
    const disconnect = vi.fn()
    globalThis.ResizeObserver = class {
      constructor(cb: ResizeObserverCallback) {
        callback = cb
      }
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = disconnect
    } as unknown as typeof ResizeObserver
    return {
      fire: () => callback?.([], {} as ResizeObserver),
      disconnect
    }
  }

  it('repaints once when a 0px container regains a width', () => {
    // #given a graph whose container collapsed to 0px, where an
    //   allowInvalidContainer render left the canvases 1px wide
    const observer = captureResizeObserver()
    const { container, setWidth } = containerWithWidth(0)
    const { sigma, refresh } = fakeSigma(container)
    renderHook(() => useRepaintSigmaWhenContainerRegainsWidth(sigma))

    // #when the observer reports while still 0px, nothing renders
    observer.fire()
    expect(refresh).not.toHaveBeenCalled()

    // #when the container comes back
    setWidth(420)
    observer.fire()

    // #then Sigma re-measures once; later size changes are Sigma's own business
    expect(refresh).toHaveBeenCalledTimes(1)
    setWidth(500)
    observer.fire()
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('does not repaint on the first observation of an already sized container', () => {
    const observer = captureResizeObserver()
    const { container } = containerWithWidth(640)
    const { sigma, refresh } = fakeSigma(container)
    renderHook(() => useRepaintSigmaWhenContainerRegainsWidth(sigma))

    observer.fire()

    expect(refresh).not.toHaveBeenCalled()
  })

  it('disconnects on unmount', () => {
    const observer = captureResizeObserver()
    const { container } = containerWithWidth(640)
    const { sigma } = fakeSigma(container)
    const { unmount } = renderHook(() => useRepaintSigmaWhenContainerRegainsWidth(sigma))

    unmount()

    expect(observer.disconnect).toHaveBeenCalledTimes(1)
  })
})
