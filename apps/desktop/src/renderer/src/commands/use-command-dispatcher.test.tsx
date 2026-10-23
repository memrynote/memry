import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerCommands, resetCommandStoreForTests } from './store'
import { useCommandDispatcher } from './use-command-dispatcher'

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() })
}))

const navBack = vi.fn()
const zoomIn = vi.fn()

// Off macOS `meta` is Ctrl, so ⌘[ is Ctrl+[ here.
const press = (target: Element, init: KeyboardEventInit): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ctrlKey: true,
    ...init
  })
  target.dispatchEvent(event)
  return event
}

/** A widget that handles every key itself, as Excalidraw's canvas does for ⌘[ and ⌘]. */
function swallowingWidget(): HTMLElement {
  const widget = document.createElement('div')
  widget.addEventListener('keydown', (event) => {
    event.stopPropagation()
  })
  document.body.append(widget)
  return widget
}

beforeEach(() => {
  resetCommandStoreForTests()
  vi.clearAllMocks()
  renderHook(useCommandDispatcher)
  registerCommands('tabs', 'tabs', () => ({ 'tabs.navBack': { run: navBack } }))
  registerCommands('zoom', 'zoom', () => ({ 'view.zoomIn': { run: zoomIn } }))
})

afterEach(() => {
  document.body.replaceChildren()
})

describe('the command dispatcher and a focused widget that handles the key', () => {
  it('leaves a bubble-phase chord to the widget that stops it', () => {
    const event = press(swallowingWidget(), { key: '[' })

    expect(navBack).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it('runs the same chord when nothing in between stops it', () => {
    const plain = document.createElement('div')
    document.body.append(plain)

    const event = press(plain, { key: '[' })

    expect(navBack).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
  })

  it('runs a capture-phase chord even when the widget would stop it', () => {
    const event = press(swallowingWidget(), { key: '=' })

    expect(zoomIn).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
  })
})
