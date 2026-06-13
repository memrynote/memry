import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DateMentionPopover, type DateMentionValue } from './date-mention-popover'

// Radix Popover renders into a Portal and gates content behind floating-ui
// measurements that don't resolve in jsdom. Mock it to render content inline
// whenever `open` is true (the established convention for Radix popovers under
// jsdom). PopoverAnchor renders nothing; PopoverContent shows its children.
vi.mock('@/components/ui/popover', () => ({
  Popover: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div data-testid="popover">{children}</div> : null,
  PopoverAnchor: () => null,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

// DatePickerCalendar pulls i18n + icon deps and isn't under test here. Expose
// onSelect via a button so date-selection logic (time-of-day preservation) can
// be exercised without rendering the real calendar.
vi.mock('@/components/tasks/date-picker-calendar', () => ({
  DatePickerCalendar: ({ onSelect }: { onSelect: (date: Date) => void }) => (
    <button
      type="button"
      data-testid="calendar"
      onClick={() => onSelect(new Date('2026-07-15T00:00:00.000Z'))}
    >
      calendar
    </button>
  )
}))

const BASE_VALUE: DateMentionValue = {
  dateISO: '2026-06-20T09:00:00.000Z',
  hasTime: true,
  remind: false,
  lead: 'at'
}

describe('DateMentionPopover', () => {
  it('renders reminder controls and toggling the switch emits remind=true', () => {
    const onChange = vi.fn()
    render(
      <DateMentionPopover
        open
        anchorId="dm_test"
        value={BASE_VALUE}
        onChange={onChange}
        onClose={vi.fn()}
      />
    )

    // The "Remind me" label is present.
    expect(screen.getByText('Remind me')).toBeInTheDocument()

    // The lead Select trigger is disabled while remind is off.
    expect(screen.getByLabelText('Reminder lead time')).toBeDisabled()

    // Toggling the Switch emits the value with remind flipped on.
    fireEvent.click(screen.getByRole('switch'))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ remind: true }))
  })

  it('enables the lead Select once remind is on', () => {
    render(
      <DateMentionPopover
        open
        anchorId="dm_test"
        value={{ ...BASE_VALUE, remind: true }}
        onChange={vi.fn()}
        onClose={vi.fn()}
      />
    )

    expect(screen.getByLabelText('Reminder lead time')).not.toBeDisabled()
  })

  it('changing the time emits hasTime=true with the new time reflected in dateISO', () => {
    const onChange = vi.fn()
    render(
      <DateMentionPopover
        open
        anchorId="dm_test"
        value={BASE_VALUE}
        onChange={onChange}
        onClose={vi.fn()}
      />
    )

    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '14:30' } })

    expect(onChange).toHaveBeenCalledTimes(1)
    const emitted = onChange.mock.calls[0][0]
    expect(emitted.hasTime).toBe(true)
    // The local time-of-day round-trips through the emitted ISO (TZ-agnostic).
    const emittedDate = new Date(emitted.dateISO)
    expect(emittedDate.getHours()).toBe(14)
    expect(emittedDate.getMinutes()).toBe(30)
    // The calendar day is preserved (only the time changed).
    const baseDate = new Date(BASE_VALUE.dateISO)
    expect(emittedDate.getFullYear()).toBe(baseDate.getFullYear())
    expect(emittedDate.getMonth()).toBe(baseDate.getMonth())
    expect(emittedDate.getDate()).toBe(baseDate.getDate())
  })

  it('selecting a calendar date preserves the existing time-of-day', () => {
    const onChange = vi.fn()
    render(
      <DateMentionPopover
        open
        anchorId="dm_test"
        value={BASE_VALUE}
        onChange={onChange}
        onClose={vi.fn()}
      />
    )

    // BASE_VALUE's local time-of-day must survive a date change.
    const baseDate = new Date(BASE_VALUE.dateISO)
    fireEvent.click(screen.getByTestId('calendar'))

    expect(onChange).toHaveBeenCalledTimes(1)
    const emitted = new Date(onChange.mock.calls[0][0].dateISO)
    expect(emitted.getHours()).toBe(baseDate.getHours())
    expect(emitted.getMinutes()).toBe(baseDate.getMinutes())
  })
})
