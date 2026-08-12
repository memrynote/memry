import { fireEvent, render, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select'

/**
 * Long selects must scroll rather than run off the screen.
 *
 * `SelectContent` already asks to scroll (`overflow-y-auto`), but scrolling is
 * only meaningful once something bounds the height. Radix publishes that bound
 * as `--radix-select-content-available-height` — the room it measured for the
 * chosen placement — and the class that consumes it has to survive Tailwind
 * compilation for the bound to exist at all.
 *
 * Tailwind v4 removed v3's implicit `var()` wrapping inside square-bracket
 * arbitrary values. Compiled against the workspace's tailwindcss 4.1.18,
 * `max-h-[--radix-select-content-available-height]` emits
 * `max-height: --radix-select-content-available-height` — a bare custom-property
 * name where a length belongs, which is invalid CSS, so the browser drops the
 * declaration and the select grows unbounded. Only `max-h-(--x)` and
 * `max-h-[var(--x)]` compile to a real `var()`, so accept exactly those and
 * reject the bare-dashed form outright.
 */
const expectHeightCappedBy = (element: HTMLElement, cssVar: string): void => {
  expect(element.className).not.toContain(`max-h-[${cssVar}]`)
  expect(element.className).toMatch(
    new RegExp(`max-h-(?:\\(${cssVar}\\)|\\[var\\(${cssVar}\\)\\])`)
  )
}

const AVAILABLE_HEIGHT = '--radix-select-content-available-height'

// Radix Select drives its trigger through the Pointer Capture API and scrolls
// the checked item into view on open; jsdom implements neither.
beforeAll(() => {
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.setPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
  Element.prototype.scrollIntoView = vi.fn()
})

describe('SelectContent', () => {
  it('constrains its height and scrolls instead of overflowing the viewport', () => {
    render(
      <Select>
        <SelectTrigger>
          <SelectValue placeholder="pick" />
        </SelectTrigger>
        <SelectContent data-testid="content">
          <SelectItem value="one">one</SelectItem>
        </SelectContent>
      </Select>
    )

    fireEvent.pointerDown(screen.getByRole('combobox'), {
      button: 0,
      ctrlKey: false,
      pointerType: 'mouse'
    })

    const content = screen.getByTestId('content')
    expectHeightCappedBy(content, AVAILABLE_HEIGHT)
    expect(content.className).toContain('overflow-y-auto')
  })
})
