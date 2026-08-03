import { describe, expect, it, beforeEach } from 'vitest'
import { forgetWindow, getCanvasWindowId, markCanvasClosed, markCanvasOpen } from './live-registry'

describe('canvas live registry', () => {
  beforeEach(() => {
    forgetWindow(1)
    forgetWindow(2)
  })

  it('remembers which window has a canvas open', () => {
    markCanvasOpen('c1', 1)

    expect(getCanvasWindowId('c1')).toBe(1)
    expect(getCanvasWindowId('c2')).toBeNull()
  })

  it('lets a second window take over a canvas', () => {
    markCanvasOpen('c1', 1)
    markCanvasOpen('c1', 2)

    expect(getCanvasWindowId('c1')).toBe(2)
  })

  it('ignores a close from a window that no longer owns the canvas', () => {
    markCanvasOpen('c1', 1)
    markCanvasOpen('c1', 2)
    markCanvasClosed('c1', 1)

    expect(getCanvasWindowId('c1')).toBe(2)
  })

  it('drops every entry for a closed window', () => {
    markCanvasOpen('c1', 1)
    markCanvasOpen('c2', 1)

    forgetWindow(1)

    expect(getCanvasWindowId('c1')).toBeNull()
    expect(getCanvasWindowId('c2')).toBeNull()
  })
})
