import { describe, expect, it } from 'vitest'
import type { FocusEvent } from 'react'

import { isMenuFocusSteal } from './inline-rename-focus'

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
