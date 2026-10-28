import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (payload: unknown) => void

const shell = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  setRects: vi.fn(() => Promise.resolve(null))
}))

vi.mock('../../../generated/bindings', () => {
  const event = (name: string) => ({
    listen: (handler: (e: { payload: unknown }) => void) => {
      shell.handlers.set(name, (payload) => handler({ payload }))
      return Promise.resolve(() => shell.handlers.delete(name))
    }
  })
  return {
    commands: { windowSetCaptionRects: shell.setRects },
    events: {
      windowCaptionHoverChangedEvent: event('hover'),
      windowCaptionPressedChangedEvent: event('pressed'),
      windowChromeStateChangedEvent: event('chrome')
    }
  }
})

import { CaptionButtons } from './caption-buttons'

const root = document.documentElement
const emit = (name: string, payload: unknown): void => {
  act(() => shell.handlers.get(name)?.(payload))
}
const button = (container: HTMLElement, name: string): HTMLElement =>
  container.querySelector(`[data-caption-button="${name}"]`)!

describe('CaptionButtons', () => {
  beforeEach(() => {
    root.setAttribute('data-platform', 'win32')
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = vi.fn()
        disconnect = vi.fn()
      }
    )
    Object.defineProperty(window, 'devicePixelRatio', { value: 1.5, configurable: true })
  })
  afterEach(() => {
    root.removeAttribute('data-platform')
    root.removeAttribute('data-fullscreen')
    vi.unstubAllGlobals()
    shell.setRects.mockClear()
  })

  it('draws the three buttons and reports their rectangles in physical pixels', () => {
    const rect = { x: 10, y: 0, width: 46, height: 36 } as DOMRect
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(rect)
    const { container } = render(<CaptionButtons />)
    expect(button(container, 'minimize')).toBeTruthy()
    expect(button(container, 'maximize')).toBeTruthy()
    expect(button(container, 'close')).toBeTruthy()
    const physical = { x: 15, y: 0, width: 69, height: 54 }
    expect(shell.setRects).toHaveBeenCalledWith(physical, physical, physical)
  })

  it('styles hover and press from shell events, since the page gets no mouse events', () => {
    const { container } = render(<CaptionButtons />)
    expect(button(container, 'close').hasAttribute('data-caption-hover')).toBe(false)
    emit('hover', { button: 'close' })
    expect(button(container, 'close').hasAttribute('data-caption-hover')).toBe(true)
    expect(button(container, 'minimize').hasAttribute('data-caption-hover')).toBe(false)
    emit('pressed', { button: 'close' })
    expect(button(container, 'close').hasAttribute('data-caption-pressed')).toBe(true)
    emit('hover', { button: null })
    emit('pressed', { button: null })
    expect(button(container, 'close').hasAttribute('data-caption-hover')).toBe(false)
    expect(button(container, 'close').hasAttribute('data-caption-pressed')).toBe(false)
  })

  it('shows the restore glyph while maximized', () => {
    const { container } = render(<CaptionButtons />)
    expect(button(container, 'maximize').textContent).toBe('\uE922')
    emit('chrome', { fullscreen: false, maximized: true })
    expect(button(container, 'maximize').textContent).toBe('\uE923')
  })

  it('clears the native rectangles when the buttons hide, so nothing catches clicks there', async () => {
    const rect = { x: 10, y: 0, width: 46, height: 36 } as DOMRect
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(rect)
    const { container } = render(<CaptionButtons />)
    shell.setRects.mockClear()
    await act(async () => {
      root.setAttribute('data-fullscreen', '')
      await Promise.resolve()
    })
    expect(container.firstChild).toBeNull()
    const none = { x: 0, y: 0, width: 0, height: 0 }
    expect(shell.setRects).toHaveBeenCalledWith(none, none, none)
  })

  it('renders nothing in fullscreen or off Windows', () => {
    root.setAttribute('data-fullscreen', '')
    expect(render(<CaptionButtons />).container.firstChild).toBeNull()
    root.removeAttribute('data-fullscreen')
    root.setAttribute('data-platform', 'darwin')
    expect(render(<CaptionButtons />).container.firstChild).toBeNull()
  })
})
