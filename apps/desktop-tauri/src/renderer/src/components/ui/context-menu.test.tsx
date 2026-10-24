import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger
} from './context-menu'

/**
 * Long menus must scroll rather than clip.
 *
 * A context menu is positioned against the pointer, so near the bottom of the
 * window Radix hands it very little room. Without a max-height it overflows the
 * viewport, and with `overflow-hidden` the options past the fold become
 * unreachable — no scrollbar, no keyboard path, just missing actions. The
 * available-height custom property is the budget Radix measured for that
 * placement, so pairing it with `overflow-y-auto` is what turns a clipped menu
 * into a scrolling one.
 */

const openRootMenu = (): HTMLElement => {
  fireEvent.contextMenu(screen.getByText('trigger'))
  return screen.getByTestId('content')
}

describe('ContextMenuContent', () => {
  // Regression guard: this one is already correct. It is the menu behind the
  // notes tree, tags and projects rows, so a stray `overflow-hidden` here would
  // silently swallow options on those surfaces.
  it('constrains its height and scrolls instead of clipping', () => {
    render(
      <ContextMenu>
        <ContextMenuTrigger>trigger</ContextMenuTrigger>
        <ContextMenuContent data-testid="content">
          <ContextMenuItem>one</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    )

    const content = openRootMenu()
    expect(content.className).toContain('max-h-(--radix-context-menu-content-available-height)')
    expect(content.className).toContain('overflow-y-auto')
    expect(content.className).not.toContain('overflow-hidden')
  })
})

describe('ContextMenuSubContent', () => {
  it('constrains its height and scrolls instead of clipping', () => {
    render(
      <ContextMenu>
        <ContextMenuTrigger>trigger</ContextMenuTrigger>
        <ContextMenuContent data-testid="content">
          <ContextMenuSub>
            <ContextMenuSubTrigger>more</ContextMenuSubTrigger>
            <ContextMenuSubContent data-testid="sub-content">
              <ContextMenuItem>one</ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
        </ContextMenuContent>
      </ContextMenu>
    )

    openRootMenu()
    fireEvent.click(screen.getByText('more'))

    const subContent = screen.getByTestId('sub-content')
    expect(subContent.className).toContain('max-h-(--radix-context-menu-content-available-height)')
    expect(subContent.className).toContain('overflow-y-auto')
    expect(subContent.className).not.toContain('overflow-hidden')
  })
})
