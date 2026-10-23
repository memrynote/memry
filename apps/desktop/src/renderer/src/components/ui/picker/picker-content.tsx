import * as React from 'react'
import { PopoverContent } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { usePickerContext } from './types'

export interface PickerContentProps extends React.ComponentPropsWithoutRef<typeof PopoverContent> {
  width?: 'auto' | 'trigger' | number
}

/**
 * Rows a keyboard user can land on: every enabled button inside a
 * `Picker.List`, whether it came from `Picker.Item` or from a call site that
 * renders its own row (the vault switcher does). Secondary affordances inside a
 * row — the vault switcher's remove and delete controls — are
 * `span[role="button"]` and stay on the Tab path only, so Arrow keys walk rows
 * rather than stopping inside one.
 *
 * Exported so a call site that wants to open on a specific row (the vault
 * switcher opens on the active vault) picks rows the same way this file does.
 */
export const PICKER_ROW_SELECTOR = '[data-slot="picker-list"] button:not([disabled])'

/** Arrow keys belong to the caret while a text field owns them. */
function ownsArrowKeys(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

export const PickerContent = React.forwardRef<
  React.ComponentRef<typeof PopoverContent>,
  PickerContentProps
>(({ width, className, children, onKeyDown, ...props }, ref) => {
  const { contentId } = usePickerContext()
  const widthClass =
    width === 'auto'
      ? 'w-auto'
      : width === 'trigger'
        ? 'w-(--radix-popover-trigger-width)'
        : typeof width === 'number'
          ? undefined
          : 'w-72'

  // Radix focuses the first row when the popover opens and loops Tab, but
  // nothing moves focus on Arrow keys — so a picker opened from the keyboard
  // (⌘⇧O on the vault switcher) could only ever activate that first row. Roving
  // focus over the list's rows makes Up/Down walk them; Enter and Space then
  // activate the focused row natively, no extra key handling needed.
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    onKeyDown?.(event)
    if (event.defaultPrevented) return
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    if (ownsArrowKeys(event.target)) return

    const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(PICKER_ROW_SELECTOR))
    if (rows.length === 0) return
    event.preventDefault()

    const step = event.key === 'ArrowDown' ? 1 : -1
    const active = document.activeElement
    const current = active instanceof HTMLElement ? rows.indexOf(active) : -1
    const next =
      current === -1
        ? step === 1
          ? 0
          : rows.length - 1
        : (current + step + rows.length) % rows.length

    rows[next]?.focus()
  }

  return (
    <PopoverContent
      ref={ref}
      id={props.id ?? contentId}
      data-slot="picker-content"
      className={cn(
        'p-0 rounded-md overflow-clip shadow-[var(--shadow-card-hover)]',
        // Radix anchors the popover to its trigger, so a trigger low in the
        // window gets little room below it. Cap at the height Radix measured
        // and lay out as a column so the body can shrink and scroll rather than
        // be swallowed by `overflow-clip`.
        'flex flex-col max-h-(--radix-popover-content-available-height)',
        widthClass,
        className
      )}
      style={typeof width === 'number' ? { width: `${width}px` } : undefined}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={handleKeyDown}
      {...props}
    >
      <div className="flex flex-col min-h-0 text-[13px] leading-4 [font-synthesis:none]">
        {children}
      </div>
    </PopoverContent>
  )
})
PickerContent.displayName = 'PickerContent'
