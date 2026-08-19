/**
 * Shared stand-in for the `@/components/ui/picker` primitive.
 *
 * Radix's picker never opens in jsdom, so a test that has to reach the items
 * inside a picker stubs the primitive. This is the only piece reminder tests
 * are allowed to stub: the components built on top of it — `ReminderPicker`
 * and its consumers — always render for real, so their callback contracts are
 * read from the source instead of being re-declared per test file.
 *
 * That distinction is the point. Hand-written `ReminderPicker` stubs are what
 * let the argument-order bug in #1527 live behind green tests: each stub called
 * `onSelect` the way its consumer misread it, so the tests agreed with the bug
 * for as long as the bug existed.
 *
 * Only the subset `ReminderPicker` uses is stubbed (`Trigger`, `Content`,
 * `List`, `Item`, `Section`, `Separator`, `Footer`); a component that reaches
 * for `Search`, `Empty` or `Panel` needs them added here.
 *
 * @module tests/utils/picker-stub
 */

import * as React from 'react'

interface PickerRootProps {
  children: React.ReactNode
  onValueChange?: (value: string) => void
  onOpenChange?: (open: boolean) => void
}

interface ChildrenProps {
  children: React.ReactNode
}

interface PickerSectionProps {
  label: string
  children: React.ReactNode
}

interface PickerItemProps {
  value: string
  label?: string
  icon?: React.ReactNode
  trailing?: React.ReactNode
}

/**
 * Build the module replacement for `vi.mock('@/components/ui/picker', ...)`.
 *
 * Each item renders as a button carrying both its label and a
 * `preset-<value>` test id, so a test can click by whichever it cares about.
 *
 * @example
 * vi.mock('@/components/ui/picker', async () => {
 *   const { createPickerStub } = await import('@tests/utils/picker-stub')
 *   return createPickerStub()
 * })
 */
export function createPickerStub() {
  const handlers: {
    onValueChange: ((value: string) => void) | null
    onOpenChange: ((open: boolean) => void) | null
  } = { onValueChange: null, onOpenChange: null }

  const PickerRoot = ({
    children,
    onValueChange,
    onOpenChange
  }: PickerRootProps): React.ReactElement => {
    handlers.onValueChange = onValueChange ?? null
    handlers.onOpenChange = onOpenChange ?? null
    return <div>{children}</div>
  }

  return {
    Picker: Object.assign(PickerRoot, {
      Trigger: ({ children }: ChildrenProps) => (
        <div onClick={() => handlers.onOpenChange?.(true)}>{children}</div>
      ),
      Content: ({ children }: ChildrenProps) => <div>{children}</div>,
      List: ({ children }: ChildrenProps) => <div>{children}</div>,
      Footer: ({ children, className }: ChildrenProps & { className?: string }) => (
        <div data-slot="picker-footer" className={className}>
          {children}
        </div>
      ),
      Section: ({ label, children }: PickerSectionProps) => (
        <section aria-label={label}>
          <h3>{label}</h3>
          {children}
        </section>
      ),
      Separator: () => <hr />,
      Item: ({ value, label, icon, trailing }: PickerItemProps) => (
        <button
          type="button"
          data-testid={`preset-${value}`}
          onClick={() => handlers.onValueChange?.(value)}
        >
          {icon}
          <span>{label}</span>
          {trailing}
        </button>
      )
    })
  }
}
