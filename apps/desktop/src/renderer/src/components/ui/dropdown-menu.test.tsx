import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from './dropdown-menu'

/**
 * Long menus must scroll rather than clip.
 *
 * Radix anchors a dropdown to its trigger, so a trigger low in the window gets
 * very little room below it. Without a max-height the menu overflows the
 * viewport, and with `overflow-hidden` everything past the fold becomes
 * unreachable — no scrollbar, no keyboard path, just missing actions. The
 * available-height custom property is the budget Radix measured for that
 * placement, so pairing it with `overflow-y-auto` is what turns a clipped menu
 * into a scrolling one.
 *
 * The submenu is the sharp edge here: `move-menu.tsx` renders one
 * `DropdownMenuSubContent` per project the user owns, and
 * `tag-overflow-menu.tsx` renders one row per tag, so both grow without bound
 * with real data.
 */

/**
 * Tailwind v4 removed v3's implicit `var()` wrapping inside square-bracket
 * arbitrary values, so `max-h-[--x]` compiles to the invalid
 * `max-height: --x` and the browser discards the declaration — a cap that reads
 * correctly in the source but caps nothing at runtime. Only `max-h-(--x)` and
 * `max-h-[var(--x)]` survive compilation, so accept exactly those and reject
 * the bare-dashed form outright.
 */
const expectHeightCappedBy = (element: HTMLElement, cssVar: string): void => {
  expect(element.className).not.toContain(`max-h-[${cssVar}]`)
  expect(element.className).toMatch(
    new RegExp(`max-h-(?:\\(${cssVar}\\)|\\[var\\(${cssVar}\\)\\])`)
  )
}

const AVAILABLE_HEIGHT = '--radix-dropdown-menu-content-available-height'

const openRootMenu = (): HTMLElement => {
  fireEvent.pointerDown(screen.getByText('trigger'), { button: 0, ctrlKey: false })
  return screen.getByTestId('content')
}

describe('DropdownMenuContent', () => {
  // Regression guard: this one is already correct. It is the menu behind the
  // task row overflow, tab bar and note actions, so losing the cap here would
  // silently swallow options on all of them.
  it('constrains its height and scrolls instead of clipping', () => {
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>trigger</DropdownMenuTrigger>
        <DropdownMenuContent data-testid="content">
          <DropdownMenuItem>one</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    )

    const content = openRootMenu()
    expectHeightCappedBy(content, AVAILABLE_HEIGHT)
    expect(content.className).toContain('overflow-y-auto')
    expect(content.className).not.toContain('overflow-hidden')
  })
})

describe('DropdownMenuSubContent', () => {
  it('constrains its height and scrolls instead of clipping', () => {
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>trigger</DropdownMenuTrigger>
        <DropdownMenuContent data-testid="content">
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>more</DropdownMenuSubTrigger>
            <DropdownMenuSubContent data-testid="sub-content">
              <DropdownMenuItem>one</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>
    )

    openRootMenu()
    fireEvent.click(screen.getByText('more'))

    const subContent = screen.getByTestId('sub-content')
    expectHeightCappedBy(subContent, AVAILABLE_HEIGHT)
    expect(subContent.className).toContain('overflow-y-auto')
    expect(subContent.className).not.toContain('overflow-hidden')
  })
})
