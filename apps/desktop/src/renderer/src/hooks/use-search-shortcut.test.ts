import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isMac } from './use-keyboard-shortcuts-base'
import { LOCAL_COMMAND_MENU_ATTR, useSearchShortcut } from './use-search-shortcut'

function press(key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key,
    metaKey: isMac,
    ctrlKey: !isMac,
    bubbles: true,
    cancelable: true
  })
  window.dispatchEvent(event)
  return event
}

describe('useSearchShortcut', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('opens search on the primary chord and on the P alias', () => {
    const onToggle = vi.fn()
    renderHook(() => useSearchShortcut(onToggle))
    press('k')
    press('p')
    expect(onToggle).toHaveBeenCalledTimes(2)
  })

  it('leaves the primary chord to a focused surface with its own command menu', () => {
    const onToggle = vi.fn()
    renderHook(() => useSearchShortcut(onToggle))
    const surface = document.createElement('div')
    surface.setAttribute(LOCAL_COMMAND_MENU_ATTR, '')
    surface.tabIndex = 0
    document.body.append(surface)
    surface.focus()

    const event = press('k')
    expect(onToggle).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)

    press('p')
    expect(onToggle).toHaveBeenCalledTimes(1)
  })
})
