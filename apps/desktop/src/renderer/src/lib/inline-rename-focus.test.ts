import { describe, expect, it, vi } from 'vitest'
import type { FocusEvent, KeyboardEvent } from 'react'

import { isMenuFocusSteal, stopInlineRenameKeyPropagation } from './inline-rename-focus'

/** A blur event carrying `relatedTarget`, which is all the helper reads. */
function blurTo(relatedTarget: EventTarget | null): FocusEvent<HTMLElement> {
  return { relatedTarget } as unknown as FocusEvent<HTMLElement>
}

function menuItemInside(state: 'open' | 'closed'): HTMLElement {
  const content = document.createElement('div')
  content.setAttribute('role', 'menu')
  content.dataset.state = state
  const item = document.createElement('div')
  item.setAttribute('role', 'menuitem')
  content.appendChild(item)
  document.body.appendChild(content)
  return item
}

describe('isMenuFocusSteal', () => {
  it('claims a blur handed to an item of a menu that is animating out', () => {
    expect(isMenuFocusSteal(blurTo(menuItemInside('closed')))).toBe(true)
  })

  it('claims a blur handed to the closing menu content itself', () => {
    const item = menuItemInside('closed')
    expect(isMenuFocusSteal(blurTo(item.parentElement))).toBe(true)
  })

  it('leaves a menu the user is deliberately opening alone', () => {
    // Taking focus back here would fight the open menu's own focus trap.
    expect(isMenuFocusSteal(blurTo(menuItemInside('open')))).toBe(false)
  })

  it('leaves an ordinary blur alone, so it still commits', () => {
    const row = document.createElement('div')
    document.body.appendChild(row)
    expect(isMenuFocusSteal(blurTo(row))).toBe(false)
  })

  it('treats a blur with no related target as an ordinary commit', () => {
    expect(isMenuFocusSteal(blurTo(null))).toBe(false)
  })
})

describe('stopInlineRenameKeyPropagation', () => {
  const press = (init: { key: string; metaKey?: boolean; ctrlKey?: boolean }) => {
    const stopPropagation = vi.fn()
    stopInlineRenameKeyPropagation({
      metaKey: false,
      ctrlKey: false,
      ...init,
      stopPropagation
    } as unknown as KeyboardEvent<HTMLInputElement>)
    return stopPropagation
  }

  it('keeps typing, Enter, Escape and Space inside the field', () => {
    for (const key of ['a', 'Enter', 'Escape', ' ', 'ArrowDown']) {
      expect(press({ key })).toHaveBeenCalled()
    }
    expect(press({ key: 'Enter', metaKey: true })).toHaveBeenCalled()
  })

  it('lets app chords reach the window shortcut listeners', () => {
    expect(press({ key: 'w', metaKey: true })).not.toHaveBeenCalled()
    expect(press({ key: 'n', ctrlKey: true })).not.toHaveBeenCalled()
  })
})
