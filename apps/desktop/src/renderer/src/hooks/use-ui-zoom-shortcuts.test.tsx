import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { __setShortcutOverridesForTests } from '@/lib/shortcut-bindings'

const zoom = vi.hoisted(() => ({
  zoomIn: vi.fn(),
  zoomOut: vi.fn(),
  resetZoom: vi.fn()
}))

vi.mock('./use-ui-zoom', () => ({
  useUiZoom: () => ({ factor: 1, setFactor: vi.fn(), ...zoom })
}))

import { useUiZoomShortcuts } from './use-ui-zoom-shortcuts'

/**
 * jsdom reports an empty `navigator.platform`, so `isMac` is false and the
 * bound `meta` modifier resolves to Ctrl. That is the Windows path, which is
 * the platform the zoom request came from.
 */
function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, cancelable: true, ...init })
  window.dispatchEvent(event)
  return event
}

describe('useUiZoomShortcuts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __setShortcutOverridesForTests({})
  })

  afterEach(() => {
    __setShortcutOverridesForTests({})
  })

  it('#given the default binding #when Ctrl+= #then it zooms in', () => {
    renderHook(() => useUiZoomShortcuts())

    const event = press('=', { ctrlKey: true })

    expect(zoom.zoomIn).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
  })

  it('#given Ctrl+Shift+= #then it still zooms in', () => {
    renderHook(() => useUiZoomShortcuts())

    // What a user calls "Ctrl plus": the shifted '=' key reports as '+', which
    // the bound Ctrl+= chord rejects on its own.
    const event = press('+', { ctrlKey: true, shiftKey: true })

    expect(zoom.zoomIn).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
  })

  it('#given the numpad plus with no shift #then it zooms in', () => {
    renderHook(() => useUiZoomShortcuts())

    press('+', { ctrlKey: true })

    expect(zoom.zoomIn).toHaveBeenCalledTimes(1)
  })

  it('#given the default binding #when Ctrl+- #then it zooms out', () => {
    renderHook(() => useUiZoomShortcuts())

    const event = press('-', { ctrlKey: true })

    expect(zoom.zoomOut).toHaveBeenCalledTimes(1)
    expect(zoom.zoomIn).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true)
  })

  it('#given the default binding #when Ctrl+0 #then it resets to actual size', () => {
    renderHook(() => useUiZoomShortcuts())

    const event = press('0', { ctrlKey: true })

    expect(zoom.resetZoom).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
  })

  it('#given the modifier is missing #then the bare key is left to the page', () => {
    renderHook(() => useUiZoomShortcuts())

    const event = press('=')

    expect(zoom.zoomIn).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it('#given an unrelated chord #then no zoom control fires', () => {
    renderHook(() => useUiZoomShortcuts())

    press('k', { ctrlKey: true })

    expect(zoom.zoomIn).not.toHaveBeenCalled()
    expect(zoom.zoomOut).not.toHaveBeenCalled()
    expect(zoom.resetZoom).not.toHaveBeenCalled()
  })

  it('#given the user rebound zoom in #then the new chord drives it and the old one does not', () => {
    __setShortcutOverridesForTests({
      'view.zoomIn': { key: '9', modifiers: { meta: true } }
    })
    renderHook(() => useUiZoomShortcuts())

    press('9', { ctrlKey: true })
    expect(zoom.zoomIn).toHaveBeenCalledTimes(1)

    press('=', { ctrlKey: true })
    expect(zoom.zoomIn).toHaveBeenCalledTimes(1)
  })

  it('#given the hook unmounts #then it stops listening', () => {
    const { unmount } = renderHook(() => useUiZoomShortcuts())

    unmount()
    press('=', { ctrlKey: true })

    expect(zoom.zoomIn).not.toHaveBeenCalled()
  })
})
