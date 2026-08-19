import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { InteractiveDueDateBadge } from './interactive-due-date-badge'

vi.mock('@/hooks/use-general-settings', () => ({
  useGeneralSettings: () => ({ settings: { clockFormat: '12h' } })
}))

/**
 * Tailwind v4 dropped v3's implicit `var()` wrapping inside square brackets, so
 * `max-h-[--x]` compiles to a bare custom-property name where a length belongs
 * and the browser drops the declaration — while tailwind-merge still counts it
 * as a `max-h` utility. Only `max-h-(--x)` and `max-h-[var(--x)]` survive.
 * Same guard as `picker-content.test.tsx`.
 */
const AVAILABLE_HEIGHT = '--radix-popover-content-available-height'

const openPopover = (): HTMLElement => {
  render(
    <InteractiveDueDateBadge
      dueDate={new Date(2026, 2, 16)}
      dueTime={null}
      onDateChange={vi.fn()}
      onTimeChange={vi.fn()}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: /Click to change/ }))
  const content = document.querySelector<HTMLElement>('[data-radix-popper-content-wrapper] > *')
  expect(content).not.toBeNull()
  return content!
}

/**
 * Structural only. jsdom computes no layout and never resolves the Radix
 * variable, so this proves the popover asks for a cap — not that the panel is
 * on screen. That still needs a short-viewport check in the running app.
 */
describe('InteractiveDueDateBadge popover height', () => {
  it('caps the panel at the height Radix measured', () => {
    // A raw `PopoverContent` has no height management of its own: the popper
    // `size` middleware only sets the variable, and `shift` runs with
    // `crossAxis: false`. This badge sits in scrolling task lists, so its
    // trigger can be anywhere in the window.
    const content = openPopover()

    expect(content.className).not.toContain(`max-h-[${AVAILABLE_HEIGHT}]`)
    expect(content.className).toMatch(
      new RegExp(`max-h-(?:\\(${AVAILABLE_HEIGHT}\\)|\\[var\\(${AVAILABLE_HEIGHT}\\)\\])`)
    )
  })

  it('lays out as a column so the cap reaches the scrolling body', () => {
    // The cap alone would just clip: this content also carries `overflow-clip`,
    // so the panel has to be a shrinkable flex child to scroll instead.
    const content = openPopover()

    expect(content.className).toContain('flex')
    expect(content.className).toContain('flex-col')
  })
})
