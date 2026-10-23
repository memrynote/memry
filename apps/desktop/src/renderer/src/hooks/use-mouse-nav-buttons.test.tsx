import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useMouseNavButtons } from './use-mouse-nav-buttons'

const mockTabs = vi.hoisted(() => ({
  navBack: vi.fn(),
  navForward: vi.fn(),
  state: {
    activeGroupId: 'group-a'
  }
}))

vi.mock('@/contexts/tabs', () => ({
  useTabs: () => mockTabs
}))

type AppNavigationCommand = { direction: 'back' | 'forward' }
type AppNavigationCallback = (command: AppNavigationCommand) => void

const setAppNavigationMock = (
  handlerRef: { current: AppNavigationCallback | null },
  unsubscribe = vi.fn()
): ReturnType<typeof vi.fn> => {
  const onAppNavigationCommand = vi.fn((callback: AppNavigationCallback) => {
    handlerRef.current = callback
    return unsubscribe
  })

  ;(
    window.api as typeof window.api & {
      onAppNavigationCommand: typeof onAppNavigationCommand
    }
  ).onAppNavigationCommand = onAppNavigationCommand

  return onAppNavigationCommand
}

const dispatchMouseButton = (type: string, button: number): MouseEvent => {
  const event = new MouseEvent(type, { button, bubbles: true, cancelable: true })
  act(() => {
    window.dispatchEvent(event)
  })
  return event
}

const dispatchBrowserKey = (key: string, target: EventTarget = window): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  act(() => {
    target.dispatchEvent(event)
  })
  return event
}

describe('useMouseNavButtons', () => {
  let appNavigationHandler: { current: AppNavigationCallback | null }

  beforeEach(() => {
    appNavigationHandler = { current: null }
    mockTabs.navBack.mockClear()
    mockTabs.navForward.mockClear()
    setAppNavigationMock(appNavigationHandler)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('navigates back on side-button mousedown', () => {
    renderHook(() => useMouseNavButtons())

    const event = dispatchMouseButton('mousedown', 3)

    expect(event.defaultPrevented).toBe(true)
    expect(mockTabs.navBack).toHaveBeenCalledWith('group-a')
    expect(mockTabs.navForward).not.toHaveBeenCalled()
  })

  it('also catches side-button mouseup and auxclick fallbacks', () => {
    vi.useFakeTimers()
    renderHook(() => useMouseNavButtons())

    const mouseUp = dispatchMouseButton('mouseup', 3)
    act(() => {
      vi.advanceTimersByTime(100)
    })
    const auxClick = dispatchMouseButton('auxclick', 4)

    expect(mouseUp.defaultPrevented).toBe(true)
    expect(auxClick.defaultPrevented).toBe(true)
    expect(mockTabs.navBack).toHaveBeenCalledWith('group-a')
    expect(mockTabs.navForward).toHaveBeenCalledWith('group-a')
  })

  it('handles dedicated browser back/forward keys even inside editable content', () => {
    const editor = document.createElement('div')
    editor.contentEditable = 'true'
    document.body.append(editor)
    renderHook(() => useMouseNavButtons())

    const backEvent = dispatchBrowserKey('BrowserBack', editor)
    const forwardEvent = dispatchBrowserKey('BrowserForward', editor)

    expect(backEvent.defaultPrevented).toBe(true)
    expect(forwardEvent.defaultPrevented).toBe(true)
    expect(mockTabs.navBack).toHaveBeenCalledWith('group-a')
    expect(mockTabs.navForward).toHaveBeenCalledWith('group-a')

    editor.remove()
  })

  it('subscribes to native app navigation commands through the preload api', () => {
    const unsubscribe = vi.fn()
    const onAppNavigationCommand = setAppNavigationMock(appNavigationHandler, unsubscribe)

    const { unmount } = renderHook(() => useMouseNavButtons())

    expect(onAppNavigationCommand).toHaveBeenCalledTimes(1)

    act(() => {
      appNavigationHandler.current?.({ direction: 'forward' })
    })

    expect(mockTabs.navForward).toHaveBeenCalledWith('group-a')

    unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('suppresses duplicate native and mouse fallback commands for the same click', () => {
    vi.useFakeTimers()
    renderHook(() => useMouseNavButtons())

    act(() => {
      appNavigationHandler.current?.({ direction: 'back' })
    })
    dispatchMouseButton('mousedown', 3)

    expect(mockTabs.navBack).toHaveBeenCalledTimes(1)

    act(() => {
      vi.advanceTimersByTime(100)
    })
    dispatchMouseButton('mousedown', 3)

    expect(mockTabs.navBack).toHaveBeenCalledTimes(2)
  })
})
