import { useState } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { IconPickerButton } from './icon-picker-button'

vi.mock('@/components/note/note-title/EmojiPicker', () => ({
  EmojiPicker: () => <div role="dialog" aria-label="Emoji and icon picker" />
}))

/**
 * Right-click a sidebar row, choose Set Icon: the picker must stay open (#2340).
 *
 * Choosing the item closes the menu, but Radix keeps it mounted for its exit
 * animation and its items still answer the pointer. Any pointer event reaching
 * the closing menu moves focus back into it: a move over an item focuses the
 * item, a leave focuses the menu. The picker's popover reads that focus as an
 * outside interaction and closes. Windows delivers a trailing `pointermove`
 * right after the click even when the mouse did not move, so there it happens
 * on nearly every open. Elsewhere it takes a mouse move during the fade.
 */
const EXIT_ANIMATION = `
  [data-slot='context-menu-content'][data-state='open'] { animation-name: menu-in; }
  [data-slot='context-menu-content'][data-state='closed'] { animation-name: menu-out; }
`

function Row() {
  const [pickerOpen, setPickerOpen] = useState(false)
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div data-testid="row">
          <IconPickerButton
            hasIcon={false}
            onIconChange={() => {}}
            ariaLabel="Set Icon"
            pickerOpen={pickerOpen}
            onPickerOpenChange={setPickerOpen}
          >
            *
          </IconPickerButton>
          Note
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem>Rename</ContextMenuItem>
        <ContextMenuItem onClick={() => setPickerOpen(true)}>Set Icon</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

const mouse = { pointerType: 'mouse', pointerId: 1 } as const

/** Windows order: `contextmenu` follows the right button's release. */
function rightClickRowWindowsOrder(): void {
  const row = screen.getByTestId('row')
  fireEvent.pointerDown(row, { ...mouse, button: 2 })
  fireEvent.pointerUp(row, { ...mouse, button: 2 })
  fireEvent.contextMenu(row, { button: 2 })
}

function clickMenuItem(name: string): HTMLElement {
  const item = screen.getByRole('menuitem', { name })
  fireEvent.pointerMove(item, mouse)
  fireEvent.pointerDown(item, { ...mouse, button: 0 })
  fireEvent.pointerUp(item, { ...mouse, button: 0 })
  fireEvent.click(item, { button: 0 })
  return item
}

describe('IconPickerButton opened from a row context menu', () => {
  let style: HTMLStyleElement

  beforeEach(() => {
    style = document.createElement('style')
    style.textContent = EXIT_ANIMATION
    document.head.appendChild(style)
  })

  afterEach(() => {
    style.remove()
  })

  it.each([
    [
      'a trailing pointermove on the chosen item (Windows)',
      (item: HTMLElement) => fireEvent.pointerMove(item, mouse)
    ],
    [
      'the pointer leaving the chosen item during the fade',
      (item: HTMLElement) => fireEvent.pointerOut(item, { ...mouse, relatedTarget: document.body })
    ]
  ])('stays open after %s', async (_name, afterClick) => {
    render(<Row />)
    rightClickRowWindowsOrder()
    const item = clickMenuItem('Set Icon')

    expect(await screen.findByRole('dialog', { name: 'Emoji and icon picker' })).toBeTruthy()
    expect(screen.getByRole('menu', { hidden: true }).getAttribute('data-state')).toBe('closed')

    act(() => afterClick(item))

    expect(screen.queryByRole('dialog', { name: 'Emoji and icon picker' })).not.toBeNull()
  })

  it('still moves focus to the item under the pointer while the menu is open', () => {
    render(<Row />)
    rightClickRowWindowsOrder()

    const item = screen.getByRole('menuitem', { name: 'Rename' })
    fireEvent.pointerMove(item, mouse)

    expect(document.activeElement).toBe(item)
  })
})
