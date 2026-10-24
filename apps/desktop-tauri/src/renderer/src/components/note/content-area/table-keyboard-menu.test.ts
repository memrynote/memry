import { describe, it, expect } from 'vitest'

import { isTableMenuShortcut } from './table-keyboard-menu'

/**
 * The predicate is asserted on its own because the thing it guards is a
 * capture-phase listener inside a live editor: a combination that also reaches
 * ProseMirror splits the cell under the caret, and a combination that is never
 * matched leaves the row and column actions mouse-only (#1661).
 */
const press = (init: Partial<KeyboardEventInit> & { key: string }): KeyboardEvent =>
  new KeyboardEvent('keydown', init)

describe('isTableMenuShortcut', () => {
  it('takes the three keys that open a context menu', () => {
    expect(isTableMenuShortcut(press({ key: 'ContextMenu' }))).toBe(true)
    expect(isTableMenuShortcut(press({ key: 'F10', shiftKey: true }))).toBe(true)
    // The one a MacBook can actually send: its F10 is a media key.
    expect(isTableMenuShortcut(press({ key: 'Enter', shiftKey: true, metaKey: true }))).toBe(true)
    expect(isTableMenuShortcut(press({ key: 'Enter', shiftKey: true, ctrlKey: true }))).toBe(true)
  })

  it('leaves the keys the editor itself owns alone', () => {
    // A plain Enter in a cell, and Shift+Enter, are ProseMirror's.
    expect(isTableMenuShortcut(press({ key: 'Enter' }))).toBe(false)
    expect(isTableMenuShortcut(press({ key: 'Enter', shiftKey: true }))).toBe(false)
    // Mod+Enter is BlockNote's, and Mod+Enter without Shift must stay so.
    expect(isTableMenuShortcut(press({ key: 'Enter', metaKey: true }))).toBe(false)
    expect(isTableMenuShortcut(press({ key: 'F10' }))).toBe(false)
    expect(isTableMenuShortcut(press({ key: 'a', shiftKey: true, metaKey: true }))).toBe(false)
  })

  it('ignores anything carrying Alt, which is a different keystroke', () => {
    expect(
      isTableMenuShortcut(press({ key: 'Enter', shiftKey: true, metaKey: true, altKey: true }))
    ).toBe(false)
    expect(isTableMenuShortcut(press({ key: 'F10', shiftKey: true, altKey: true }))).toBe(false)
    expect(isTableMenuShortcut(press({ key: 'ContextMenu', altKey: true }))).toBe(false)
  })
})
