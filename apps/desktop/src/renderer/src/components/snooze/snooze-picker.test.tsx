import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { renderWithProviders, userEvent } from '@tests/utils/render'
import { QuickSnoozeButton, SnoozePicker } from './snooze-picker'

let dropdownOpen = false
let setDropdownOpen: ((open: boolean) => void) | null = null

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

vi.mock('@/hooks/use-general-settings', () => ({
  useGeneralSettings: () => ({ settings: { clockFormat: '12h' } })
}))

vi.mock('@/components/tasks/date-picker-calendar', () => ({
  DatePickerCalendar: ({ onSelect }: { onSelect: (date: Date) => void }) => (
    <button type="button" onClick={() => onSelect(new Date('2026-05-11T00:00:00.000Z'))}>
      Select May 11
    </button>
  )
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({
    open,
    onOpenChange,
    children
  }: {
    open: boolean
    onOpenChange: (open: boolean) => void
    children: React.ReactNode
  }) => {
    dropdownOpen = open
    setDropdownOpen = onOpenChange
    return <div data-testid="dropdown-root">{children}</div>
  },
  DropdownMenuTrigger: ({ children }: { children: React.ReactElement }) =>
    React.cloneElement(children, {
      onClick: (event: React.MouseEvent) => {
        children.props.onClick?.(event)
        setDropdownOpen?.(!dropdownOpen)
      }
    }),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) =>
    dropdownOpen ? <div role="menu">{children}</div> : null,
  DropdownMenuItem: ({
    onClick,
    children
  }: {
    onClick?: () => void
    children: React.ReactNode
  }) => (
    <button type="button" role="menuitem" onClick={onClick}>
      {children}
    </button>
  ),
  DropdownMenuSeparator: () => <hr />
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div role="tooltip">{children}</div>
  )
}))

describe('SnoozePicker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-10T10:00:00.000Z'))
    dropdownOpen = false
    setDropdownOpen = null
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('opens preset options from the default trigger and selects a preset', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const onSnooze = vi.fn()

    renderWithProviders(<SnoozePicker onSnooze={onSnooze} size="sm" />)

    await user.click(screen.getByTitle('phaseF.componentsSnoozeSnoozePicker.snooze'))
    expect(screen.getByRole('menu')).toBeInTheDocument()

    await user.click(screen.getAllByRole('menuitem')[1])
    expect(onSnooze).toHaveBeenCalledWith(new Date(2026, 4, 11, 9, 0, 0, 0).toISOString())
  })

  it('opens the custom dialog, blocks past times, then accepts a future time', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const onSnooze = vi.fn()

    renderWithProviders(
      <SnoozePicker onSnooze={onSnooze} trigger={<button>Custom trigger</button>} />
    )

    await user.click(screen.getByRole('button', { name: 'Custom trigger' }))
    await user.click(
      screen.getByRole('menuitem', {
        name: /phaseF.componentsSnoozeSnoozePicker.pickDateTime/
      })
    )

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('Please select a future time')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'phaseF.componentsSnoozeSnoozePicker.snooze3' })
    ).toBeDisabled()

    await user.click(screen.getByRole('button', { name: 'Select May 11' }))
    fireEvent.change(screen.getByDisplayValue('09:00'), { target: { value: '10:30' } })
    await user.click(
      screen.getByRole('button', { name: 'phaseF.componentsSnoozeSnoozePicker.snooze3' })
    )

    expect(onSnooze).toHaveBeenCalledWith(new Date(2026, 4, 11, 10, 30, 0, 0).toISOString())
  })

  it('caps the custom dialog and keeps the snooze action out of the scrolling body', async () => {
    // `DialogContent` sets no height of its own, so a dialog taller than the
    // window hangs off both edges of a fixed, unscrollable box — and the snooze
    // button, being last, is the first thing to leave. jsdom computes no layout,
    // so this asserts the structure that makes an overflow survivable (a capped
    // shell, a scrolling body, the action outside it), not that any pixel is on
    // screen.
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })

    renderWithProviders(
      <SnoozePicker onSnooze={vi.fn()} trigger={<button>Custom trigger</button>} />
    )

    await user.click(screen.getByRole('button', { name: 'Custom trigger' }))
    await user.click(
      screen.getByRole('menuitem', {
        name: /phaseF.componentsSnoozeSnoozePicker.pickDateTime/
      })
    )

    const content = screen.getByRole('dialog').firstElementChild
    expect(content?.className).toContain('max-h-[85vh]')
    expect(content?.className).toContain('overflow-hidden')

    const body = content?.querySelector('.overflow-y-auto')
    const snooze = screen.getByRole('button', {
      name: 'phaseF.componentsSnoozeSnoozePicker.snooze3'
    })

    expect(body).not.toBeNull()
    expect(body?.contains(screen.getByRole('button', { name: 'Select May 11' }))).toBe(true)
    expect(body?.contains(screen.getByDisplayValue('09:00'))).toBe(true)
    expect(body?.contains(snooze)).toBe(false)
    // The error explaining the disabled button rides with the button.
    expect(body?.contains(screen.getByText('Please select a future time'))).toBe(false)
  })

  it('renders quick snooze button label and icon-only tooltip variants', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const onSnooze = vi.fn()

    const { rerender } = renderWithProviders(
      <QuickSnoozeButton onSnooze={onSnooze} label="Sleep" />
    )
    await user.click(
      screen.getByRole('button', { name: 'phaseF.componentsSnoozeSnoozePicker.snooze4' })
    )
    expect(screen.getByRole('menu')).toBeInTheDocument()

    rerender(<QuickSnoozeButton onSnooze={onSnooze} showLabel={false} />)
    expect(screen.getByRole('tooltip')).toHaveTextContent(
      'phaseF.componentsSnoozeSnoozePicker.snooze5'
    )
  })
})
