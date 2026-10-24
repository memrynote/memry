import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

import { DueDatePicker } from './due-date-picker'

// `prefix` stands in for the active language: react-i18next hands the component
// a fresh `t` on `languageChanged`, so flipping this and re-rendering models a
// mid-session language switch.
const i18nState = vi.hoisted(() => ({ prefix: '' }))

// Keys resolve against the real English bundle (and throw when they don't), so
// the assertions below check user-visible copy and a mistyped key fails here
// instead of shipping a raw key path to the user.
vi.mock('@memry/i18n/renderer', async () => {
  const { EN_BUNDLE } = await import('@memry/i18n/locales/en-bundle')

  return {
    useT: (namespace: keyof typeof EN_BUNDLE) => ({
      t: (key: string) => {
        const value = key
          .split('.')
          .reduce<unknown>(
            (node, part) =>
              typeof node === 'object' && node !== null
                ? (node as Record<string, unknown>)[part]
                : undefined,
            EN_BUNDLE[namespace]
          )

        if (typeof value !== 'string') {
          throw new Error(`missing English translation for ${namespace}:${key}`)
        }

        return `${i18nState.prefix}${value}`
      }
    })
  }
})

vi.mock('@/components/ui/popover', () => ({
  Popover: ({
    open,
    onOpenChange,
    children
  }: {
    open: boolean
    onOpenChange: (open: boolean) => void
    children: ReactNode
  }) => (
    <div>
      <button type="button" onClick={() => onOpenChange(!open)}>
        toggle due popover
      </button>
      {children}
    </div>
  ),
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

vi.mock('@/components/ui/separator', () => ({
  Separator: () => <hr />
}))

vi.mock('./date-picker-calendar', () => ({
  DatePickerCalendar: ({ onSelect }: { onSelect: (date: Date | undefined) => void }) => (
    <button type="button" onClick={() => onSelect(new Date(2026, 4, 20))}>
      select calendar date
    </button>
  )
}))

vi.mock('./time-picker', () => ({
  TimePicker: ({
    value,
    onChange
  }: {
    value: string | null
    onChange: (time: string | null) => void
  }) => (
    <div>
      <input
        aria-label="time input"
        value={value ?? ''}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      <button type="button" onClick={() => onChange(null)}>
        clear mocked time
      </button>
    </div>
  )
}))

vi.mock('./natural-date-input', () => ({
  NaturalDateInput: ({
    onSelect,
    onInputChange
  }: {
    onSelect: (result: { date: Date; time?: string }) => void
    onInputChange: (value: string) => void
  }) => (
    <div>
      <input
        aria-label="natural date"
        onChange={(event) => onInputChange(event.currentTarget.value)}
      />
      <button
        type="button"
        onClick={() => onSelect({ date: new Date(2026, 4, 14), time: '14:30' })}
      >
        select natural date
      </button>
    </div>
  )
}))

describe('DueDatePicker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 4, 11, 9, 0, 0))
    i18nState.prefix = ''
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('formats trigger text for empty, relative, overdue, upcoming, and later dates', () => {
    const onDateChange = vi.fn()
    const onTimeChange = vi.fn()
    const { rerender } = render(
      <DueDatePicker
        date={null}
        time={null}
        onDateChange={onDateChange}
        onTimeChange={onTimeChange}
      />
    )

    expect(screen.getByRole('combobox', { name: 'Select due date' })).toHaveTextContent(
      'Set due date'
    )

    rerender(
      <DueDatePicker
        date={new Date(2026, 4, 11)}
        time="09:15"
        onDateChange={onDateChange}
        onTimeChange={onTimeChange}
      />
    )
    expect(screen.getByRole('combobox', { name: 'Select due date' })).toHaveTextContent('Today')
    expect(screen.getByRole('combobox', { name: 'Select due date' })).toHaveTextContent('9:15 AM')

    rerender(
      <DueDatePicker
        date={new Date(2026, 4, 12)}
        time={null}
        onDateChange={onDateChange}
        onTimeChange={onTimeChange}
      />
    )
    expect(screen.getByRole('combobox', { name: 'Select due date' })).toHaveTextContent('Tomorrow')

    rerender(
      <DueDatePicker
        date={new Date(2026, 4, 14)}
        time={null}
        onDateChange={onDateChange}
        onTimeChange={onTimeChange}
      />
    )
    expect(screen.getByRole('combobox', { name: 'Select due date' })).toHaveTextContent('Thursday')

    rerender(
      <DueDatePicker
        date={new Date(2026, 4, 1)}
        time={null}
        onDateChange={onDateChange}
        onTimeChange={onTimeChange}
      />
    )
    expect(screen.getByRole('combobox', { name: 'Select due date' })).toHaveTextContent('Overdue')

    rerender(
      <DueDatePicker
        date={new Date(2026, 5, 11)}
        time={null}
        onDateChange={onDateChange}
        onTimeChange={onTimeChange}
      />
    )
    expect(screen.getByRole('combobox', { name: 'Select due date' })).toHaveTextContent('Jun 11')
  })

  it('selects quick dates, natural dates, calendar dates, and clears selected dates', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const onDateChange = vi.fn()
    const onTimeChange = vi.fn()

    render(
      <DueDatePicker
        date={new Date(2026, 4, 1)}
        time={null}
        onDateChange={onDateChange}
        onTimeChange={onTimeChange}
      />
    )

    await user.click(screen.getByRole('button', { name: 'This WeekendSat, May 163' }))
    expect(onDateChange.mock.calls.at(-1)?.[0].toDateString()).toBe('Sat May 16 2026')

    await user.click(screen.getByRole('button', { name: 'Add time' }))
    expect(onTimeChange).toHaveBeenCalledWith('09:00')

    await user.click(screen.getByRole('button', { name: 'Clear date0' }))
    expect(onDateChange).toHaveBeenLastCalledWith(null)
    expect(onTimeChange).toHaveBeenLastCalledWith(null)

    await user.click(screen.getByRole('button', { name: 'Pick a date...' }))
    expect(screen.getByRole('button', { name: /Back to options/ })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'select calendar date' }))
    expect(onDateChange.mock.calls.at(-1)?.[0].toDateString()).toBe('Wed May 20 2026')

    await user.click(screen.getByRole('button', { name: 'select natural date' }))
    expect(onDateChange.mock.calls.at(-1)?.[0].toDateString()).toBe('Thu May 14 2026')
    expect(onTimeChange).toHaveBeenLastCalledWith('14:30')
  })

  it('re-resolves quick options and the trigger label after a mid-session language switch', () => {
    const onDateChange = vi.fn()
    const onTimeChange = vi.fn()
    const props = {
      date: new Date(2026, 4, 11),
      time: null,
      onDateChange,
      onTimeChange
    }

    const { rerender } = render(<DueDatePicker {...props} />)

    expect(screen.getByRole('combobox', { name: 'Select due date' })).toHaveTextContent('Today')
    expect(screen.getByRole('button', { name: /^This Weekend/ })).toBeInTheDocument()

    i18nState.prefix = 'xx:'
    rerender(<DueDatePicker {...props} />)

    expect(screen.getByRole('combobox', { name: 'xx:Select due date' })).toHaveTextContent(
      'xx:Today'
    )
    expect(screen.getByRole('button', { name: /^xx:This Weekend/ })).toBeInTheDocument()
  })

  it('handles open-state keyboard shortcuts and hides number hints while typing', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const onDateChange = vi.fn()
    const onTimeChange = vi.fn()

    render(
      <DueDatePicker
        date={null}
        time={null}
        onDateChange={onDateChange}
        onTimeChange={onTimeChange}
      />
    )

    await user.click(screen.getByRole('button', { name: 'toggle due popover' }))
    expect(screen.getByRole('combobox', { name: 'Select due date' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )

    fireEvent.keyDown(document, { key: '2' })
    expect(onDateChange.mock.calls.at(-1)?.[0].toDateString()).toBe('Tue May 12 2026')

    await user.click(screen.getByRole('button', { name: 'toggle due popover' }))
    await user.type(screen.getByRole('textbox', { name: 'natural date' }), 'next')
    const beforeTypingShortcutCount = onDateChange.mock.calls.length
    fireEvent.keyDown(document, { key: '1' })
    expect(onDateChange).toHaveBeenCalledTimes(beforeTypingShortcutCount)

    fireEvent.keyDown(document, { key: 'Backspace', metaKey: true })
    expect(onDateChange).toHaveBeenLastCalledWith(null)
    expect(onTimeChange).toHaveBeenLastCalledWith(null)

    await user.click(screen.getByRole('button', { name: 'toggle due popover' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByRole('combobox', { name: 'Select due date' })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
  })
})
