import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useAppZoom } from './use-app-zoom'

const mocks = vi.hoisted(() => {
  // `isMac` is frozen when use-keyboard-shortcuts-base is first evaluated, and
  // off a Mac the matcher reads e.ctrlKey instead of e.metaKey. Stub the
  // platform before the import graph runs so ⌘ chords resolve as they do for
  // the user who reported the bug.
  Object.defineProperty(globalThis.navigator, 'platform', {
    value: 'MacIntel',
    configurable: true,
    enumerable: true
  })

  return {
    setZoomFactor: vi.fn(),
    updateSettings: vi.fn(),
    settings: { zoomFactor: 1 } as { zoomFactor: number },
    isLoading: false
  }
})

vi.mock('@/contexts/hint-mode', () => ({ hintModeActiveRef: { current: false } }))
vi.mock('@/hooks/use-general-settings', () => ({
  useGeneralSettings: () => ({
    settings: mocks.settings,
    isLoading: mocks.isLoading,
    updateSettings: mocks.updateSettings
  })
}))

const press = (key: string, options: Partial<KeyboardEventInit> = {}): void => {
  window.dispatchEvent(
    new KeyboardEvent('keydown', {
      key,
      metaKey: true,
      bubbles: true,
      cancelable: true,
      ...options
    })
  )
}

describe('useAppZoom', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.settings = { zoomFactor: 1 }
    mocks.isLoading = false
    mocks.updateSettings.mockResolvedValue(true)
    window.api = { setZoomFactor: mocks.setZoomFactor } as unknown as typeof window.api
  })

  it('#given ⌘- #then the interface shrinks one stop and the stop is persisted', () => {
    mocks.settings = { zoomFactor: 1.2 }
    renderHook(() => useAppZoom())

    press('-')

    expect(mocks.setZoomFactor).toHaveBeenCalledWith(1.1)
    expect(mocks.updateSettings).toHaveBeenCalledWith({ zoomFactor: 1.1 })
  })

  it('#given ⌘= #then the unshifted key still zooms in', () => {
    mocks.settings = { zoomFactor: 1.2 }
    renderHook(() => useAppZoom())

    press('=')

    expect(mocks.setZoomFactor).toHaveBeenCalledWith(1.3)
    expect(mocks.updateSettings).toHaveBeenCalledWith({ zoomFactor: 1.3 })
  })

  it('#given ⌘⇧+ #then the shifted key zooms in too', () => {
    mocks.settings = { zoomFactor: 1.2 }
    renderHook(() => useAppZoom())

    press('+', { shiftKey: true })

    expect(mocks.setZoomFactor).toHaveBeenCalledWith(1.3)
    expect(mocks.updateSettings).toHaveBeenCalledWith({ zoomFactor: 1.3 })
  })

  it('#given ⌘0 #then the interface returns to 100%', () => {
    mocks.settings = { zoomFactor: 1.7 }
    renderHook(() => useAppZoom())

    press('0')

    expect(mocks.setZoomFactor).toHaveBeenCalledWith(1)
    expect(mocks.updateSettings).toHaveBeenCalledWith({ zoomFactor: 1 })
  })

  it('#given the caret in a text input #then zoom still works', () => {
    mocks.settings = { zoomFactor: 1 }
    renderHook(() => useAppZoom())

    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: '-', metaKey: true, bubbles: true, cancelable: true })
    )

    expect(mocks.setZoomFactor).toHaveBeenCalledWith(0.9)
    input.remove()
  })

  it('#given the settings read has not resolved #then the keystroke is dropped', () => {
    mocks.isLoading = true
    renderHook(() => useAppZoom())

    press('=')

    expect(mocks.setZoomFactor).not.toHaveBeenCalled()
    expect(mocks.updateSettings).not.toHaveBeenCalled()
  })

  it('#given the largest zoom #then ⌘= holds at 200% rather than stepping past it', () => {
    mocks.settings = { zoomFactor: 2 }
    renderHook(() => useAppZoom())

    press('=')

    expect(mocks.setZoomFactor).toHaveBeenCalledWith(2)
    expect(mocks.updateSettings).toHaveBeenCalledWith({ zoomFactor: 2 })
  })

  it('#given the smallest zoom #then ⌘- holds at 50% rather than stepping past it', () => {
    mocks.settings = { zoomFactor: 0.5 }
    renderHook(() => useAppZoom())

    press('-')

    expect(mocks.setZoomFactor).toHaveBeenCalledWith(0.5)
    expect(mocks.updateSettings).toHaveBeenCalledWith({ zoomFactor: 0.5 })
  })

  it('#given a bare - with no ⌘ #then nothing zooms', () => {
    renderHook(() => useAppZoom())

    press('-', { metaKey: false })

    expect(mocks.setZoomFactor).not.toHaveBeenCalled()
  })

  it('#given the menu items #then they run the same actions as the keystrokes', () => {
    mocks.settings = { zoomFactor: 1.2 }
    const { result } = renderHook(() => useAppZoom())

    result.current.zoomIn()
    expect(mocks.setZoomFactor).toHaveBeenLastCalledWith(1.3)

    result.current.zoomOut()
    expect(mocks.setZoomFactor).toHaveBeenLastCalledWith(1.1)

    result.current.resetZoom()
    expect(mocks.setZoomFactor).toHaveBeenLastCalledWith(1)
  })
})
