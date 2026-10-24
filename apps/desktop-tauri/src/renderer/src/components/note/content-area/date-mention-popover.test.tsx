import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DateMentionPopover, type DateMentionValue } from './date-mention-popover'
import { remindOptions } from './date-mention-options'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string) => {
      const messages: Record<string, string> = {
        'dateMention.dateInput': 'Date',
        'dateMention.time': 'Time',
        'dateMention.includeTime': 'Include time',
        'dateMention.timeFormat': 'Time format',
        'dateMention.dateFormat': 'Date format',
        'dateMention.remind': 'Remind',
        'dateMention.clear': 'Clear'
      }
      return messages[key] ?? key
    }
  })
}))

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div data-testid="popover">{children}</div> : null,
  PopoverAnchor: () => null,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

vi.mock('@/components/tasks/date-picker-calendar', () => ({
  DatePickerCalendar: ({ onSelect }: { onSelect: (date: Date) => void }) => (
    <button
      type="button"
      data-testid="calendar"
      onClick={() => onSelect(new Date(2026, 6, 15, 0, 0, 0))}
    >
      calendar
    </button>
  )
}))

// Local-time event so wall-clock assertions are timezone-independent.
const BASE_VALUE: DateMentionValue = {
  dateISO: new Date(2026, 5, 20, 9, 0, 0).toISOString(),
  hasTime: true,
  dateFormat: 'relative',
  remind: 'none',
  timeFormat: 'system'
}

function renderPopover(
  overrides: Partial<DateMentionValue> = {},
  props: Record<string, unknown> = {}
) {
  const onChange = vi.fn()
  const onClear = vi.fn()
  render(
    <DateMentionPopover
      open
      anchorId="dm_test"
      value={{ ...BASE_VALUE, ...overrides }}
      onChange={onChange}
      onClear={onClear}
      onClose={vi.fn()}
      {...props}
    />
  )
  return { onChange, onClear }
}

describe('remindOptions', () => {
  it('shows day-level offsets when there is no time', () => {
    const labels = remindOptions(false).map((o) => o.label)
    expect(labels).toContain('On day of event (09:00)')
    expect(labels).not.toContain('5 minutes before')
  })

  it('shows sub-day offsets when there is a time', () => {
    const labels = remindOptions(true).map((o) => o.label)
    expect(labels).toContain('At time of event')
    expect(labels).toContain('5 minutes before')
    expect(labels).toContain('1 week before (09:00)')
  })
})

describe('DateMentionPopover', () => {
  it('opens the Remind list and selecting an option emits the offset', () => {
    const { onChange } = renderPopover()
    fireEvent.click(screen.getByLabelText('Remind'))
    expect(screen.getByText('At time of event')).toBeInTheDocument()
    fireEvent.click(screen.getByText('1 day before (09:00)'))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ remind: '1d' }))
  })

  it('shows the day-level Remind list when time is off', () => {
    renderPopover({ hasTime: false })
    fireEvent.click(screen.getByLabelText('Remind'))
    expect(screen.getByText('On day of event (09:00)')).toBeInTheDocument()
    expect(screen.queryByText('5 minutes before')).toBeNull()
  })

  it('selecting a Date format emits dateFormat', () => {
    const { onChange } = renderPopover()
    fireEvent.click(screen.getByLabelText('Date format'))
    fireEvent.click(screen.getByText('Full date'))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ dateFormat: 'full' }))
  })

  it('toggling time off coerces a sub-day remind to "at"', () => {
    const { onChange } = renderPopover({ hasTime: true, remind: '5m' })
    fireEvent.click(screen.getByRole('switch', { name: 'Include time' }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ hasTime: false, remind: 'at' }))
  })

  it('shows the Time format caption only when time is on', () => {
    const { rerender } = (() =>
      render(
        <DateMentionPopover
          open
          anchorId="dm_test"
          value={{ ...BASE_VALUE, hasTime: false }}
          onChange={vi.fn()}
          onClear={vi.fn()}
          onClose={vi.fn()}
        />
      ))()
    expect(screen.queryByText('Time format')).toBeNull()
    rerender(
      <DateMentionPopover
        open
        anchorId="dm_test"
        value={{ ...BASE_VALUE, hasTime: true }}
        onChange={vi.fn()}
        onClear={vi.fn()}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByText('Time format')).toBeInTheDocument()
  })

  it('shows the inherited clock format on the Default time-format option', () => {
    renderPopover({ hasTime: true, timeFormat: 'system' }, { clockFormat: '24h' })
    expect(screen.getByText('Default (24 hour)')).toBeInTheDocument()
  })

  it('selecting a per-block time format emits timeFormat', () => {
    const { onChange } = renderPopover({ hasTime: true }, { clockFormat: '12h' })
    fireEvent.click(screen.getByLabelText('Time format'))
    fireEvent.click(screen.getByText('24 hour'))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ timeFormat: '24h' }))
  })

  it('changing the time emits hasTime=true with the new local time in dateISO', () => {
    const { onChange } = renderPopover()
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '14:30' } })

    expect(onChange).toHaveBeenCalledTimes(1)
    const emitted = onChange.mock.calls[0][0]
    expect(emitted.hasTime).toBe(true)
    const d = new Date(emitted.dateISO)
    expect(d.getHours()).toBe(14)
    expect(d.getMinutes()).toBe(30)
  })

  it('ignores a cleared time input instead of crashing the handler', () => {
    // Chromium's <input type="time"> reports value '' once a segment is cleared.
    // ''.split(':').map(Number) is [0], so minutes arrive as undefined and
    // new Date(y, mo, d, 0, undefined) is Invalid -> toISOString() throws.
    // React rethrows out of the event handler rather than through fireEvent, so
    // assert on the window 'error' event -- the same signal the renderer's
    // telemetry listener reports in production.
    const onWindowError = vi.fn()
    window.addEventListener('error', onWindowError)
    const { onChange } = renderPopover()

    try {
      fireEvent.change(screen.getByLabelText('Time'), { target: { value: '' } })
    } finally {
      window.removeEventListener('error', onWindowError)
    }

    expect(onWindowError).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('ignores an out-of-range natural date instead of crashing on commit', () => {
    // "in 99999999999 days" overflows Date to Invalid. tryParseDateInput read it
    // back as { y: NaN, mo: NaN, d: NaN } -- a TRUTHY object, so commitDateText's
    // `if (!parsed) return` did not stop it, and emitYMDHM's new Date(NaN).toISOString()
    // threw the same RangeError this popover exists to prevent. React rethrows out
    // of the handler, so assert on the window 'error' event (production's signal).
    const onWindowError = vi.fn()
    window.addEventListener('error', onWindowError)
    const { onChange } = renderPopover()

    try {
      const input = screen.getByLabelText('Date')
      fireEvent.change(input, { target: { value: 'in 99999999999 days' } })
      fireEvent.keyDown(input, { key: 'Enter' })
    } finally {
      window.removeEventListener('error', onWindowError)
    }

    expect(onWindowError).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('selecting a calendar date preserves the existing time-of-day', () => {
    const { onChange } = renderPopover()
    fireEvent.click(screen.getByTestId('calendar'))

    expect(onChange).toHaveBeenCalledTimes(1)
    const base = new Date(BASE_VALUE.dateISO)
    const emitted = new Date(onChange.mock.calls[0][0].dateISO)
    expect(emitted.getHours()).toBe(base.getHours())
    expect(emitted.getMinutes()).toBe(base.getMinutes())
  })

  it('Clear calls onClear', () => {
    const { onClear } = renderPopover()
    fireEvent.click(screen.getByText('Clear'))
    expect(onClear).toHaveBeenCalled()
  })
})
