import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Picker } from './index'

/**
 * Tailwind v4 removed v3's implicit `var()` wrapping inside square-bracket
 * arbitrary values. Compiled against this workspace's tailwindcss 4.1.18,
 * `w-[--radix-popover-trigger-width]` emits
 * `width: --radix-popover-trigger-width` — a bare custom-property name where a
 * length belongs, which is invalid CSS and gets dropped by the browser. Only
 * `w-(--x)` and `w-[var(--x)]` compile to a real `var()`.
 *
 * The bare-dashed form is worse than a no-op here: tailwind-merge still parses
 * it as a `w-*` utility, so it wins the conflict against `PopoverContent`'s own
 * `w-72` and strips it. The element is then left with the fallback width gone
 * AND the replacement dropped as invalid — no width rule at all, so a
 * `width="trigger"` picker collapses to its content instead of matching the
 * trigger. Accept exactly the two compiling forms and reject the bare-dashed
 * one outright.
 */
const expectResolvesCssVar = (element: HTMLElement, utility: string, cssVar: string): void => {
  expect(element.className).not.toContain(`${utility}-[${cssVar}]`)
  expect(element.className).toMatch(
    new RegExp(`${utility}-(?:\\(${cssVar}\\)|\\[var\\(${cssVar}\\)\\])`)
  )
}

const TRIGGER_WIDTH = '--radix-popover-trigger-width'
const AVAILABLE_HEIGHT = '--radix-popover-content-available-height'

const renderPicker = (width?: 'auto' | 'trigger' | number): HTMLElement => {
  render(
    <Picker defaultOpen>
      <Picker.Trigger>trigger</Picker.Trigger>
      <Picker.Content width={width} data-testid="content">
        <Picker.List>
          <Picker.Item value="one">one</Picker.Item>
        </Picker.List>
      </Picker.Content>
    </Picker>
  )
  return screen.getByTestId('content')
}

describe('PickerContent', () => {
  it('matches the trigger width with a class that survives Tailwind compilation', () => {
    const content = renderPicker('trigger')

    expectResolvesCssVar(content, 'w', TRIGGER_WIDTH)
  })

  it('constrains its height to the room Radix measured', () => {
    // Every picker anchors to its trigger, so a trigger low in the window gets
    // very little room below it. Without this cap a long list runs off the
    // bottom of the screen, and `overflow-clip` on this same element makes the
    // overflow unreachable — no scrollbar, no keyboard path.
    const content = renderPicker()

    expectResolvesCssVar(content, 'max-h', AVAILABLE_HEIGHT)
  })

  it('lays out as a column so the cap reaches the body instead of clipping it', () => {
    // A max-height only bounds descendants that can actually shrink: the body
    // has to be a flex item with `min-h-0`, otherwise it keeps its content
    // height and `overflow-clip` swallows the tail.
    const content = renderPicker()

    expect(content.className).toContain('flex')
    expect(content.className).toContain('flex-col')

    const body = content.firstElementChild
    expect(body).not.toBeNull()
    expect(body?.className).toContain('min-h-0')
  })
})

describe('PickerFooter', () => {
  it('holds its height so the cap eats the scrolling body instead of the footer', () => {
    // The footer carries the confirm action. Left shrinkable, a popover anchored
    // low in the window squeezes it away along with the only way to commit —
    // which is how the reminder picker lost its "Set reminder" button.
    render(
      <Picker defaultOpen>
        <Picker.Trigger>trigger</Picker.Trigger>
        <Picker.Content>
          <Picker.Footer>footer</Picker.Footer>
        </Picker.Content>
      </Picker>
    )

    const footer = document.querySelector('[data-slot="picker-footer"]')
    expect(footer).not.toBeNull()
    expect(footer?.className).toContain('shrink-0')
  })
})

describe('PickerList', () => {
  it('scrolls instead of clipping when the list outgrows the popover', () => {
    renderPicker()

    const list = screen.getByRole('listbox')
    expect(list.className).toContain('overflow-y-auto')
    expect(list.className).toContain('min-h-0')
  })
})
