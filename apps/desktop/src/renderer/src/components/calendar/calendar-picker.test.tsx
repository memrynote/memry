import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CalendarPicker } from './calendar-picker'
import type { GoogleCalendarDescriptorRecord } from '@memry/contracts/calendar-api'

const CALENDARS: GoogleCalendarDescriptorRecord[] = [
  {
    id: 'primary@example.com',
    title: 'user@example.com',
    timezone: 'UTC',
    color: '#1a73e8',
    isPrimary: true
  },
  {
    id: 'work@group.calendar.google.com',
    title: 'Work',
    timezone: 'UTC',
    color: '#0b8043',
    isPrimary: false
  }
]

describe('CalendarPicker (M2)', () => {
  it('renders the "use default" option plus every calendar, with primary annotated', () => {
    render(<CalendarPicker calendars={CALENDARS} value={null} onChange={vi.fn()} />)

    expect(screen.getByRole('option', { name: 'Use default calendar' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'user@example.com (primary)' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Work' })).toBeInTheDocument()
  })

  it('#given value=null #when rendered #then the default option is selected', () => {
    render(<CalendarPicker calendars={CALENDARS} value={null} onChange={vi.fn()} />)
    const select = screen.getByRole('combobox', { name: 'Target calendar' })
    expect((select as HTMLSelectElement).value).toBe('__default__')
  })

  it('#given a calendarId value #when rendered #then that option is selected', () => {
    render(
      <CalendarPicker
        calendars={CALENDARS}
        value="work@group.calendar.google.com"
        onChange={vi.fn()}
      />
    )
    const select = screen.getByRole('combobox', { name: 'Target calendar' })
    expect((select as HTMLSelectElement).value).toBe('work@group.calendar.google.com')
  })

  it('#given a user picks a calendar #when changed #then emits the calendar id via onChange', () => {
    const onChange = vi.fn()
    render(<CalendarPicker calendars={CALENDARS} value={null} onChange={onChange} />)

    const select = screen.getByRole('combobox', { name: 'Target calendar' })
    fireEvent.change(select, { target: { value: 'primary@example.com' } })

    expect(onChange).toHaveBeenCalledWith('primary@example.com')
  })

  it('#given a user switches to "Use default" #when changed #then emits null via onChange', () => {
    const onChange = vi.fn()
    render(
      <CalendarPicker
        calendars={CALENDARS}
        value="work@group.calendar.google.com"
        onChange={onChange}
      />
    )

    const select = screen.getByRole('combobox', { name: 'Target calendar' })
    fireEvent.change(select, { target: { value: '__default__' } })

    expect(onChange).toHaveBeenCalledWith(null)
  })

  it('#given isLoading #when rendered #then disables the select and shows loading label', () => {
    render(<CalendarPicker calendars={[]} value={null} onChange={vi.fn()} isLoading />)
    const select = screen.getByRole('combobox', { name: 'Target calendar' })
    expect(select).toBeDisabled()
    expect(screen.getByRole('option', { name: 'Loading calendars…' })).toBeInTheDocument()
  })

  it('renders a custom defaultOptionLabel when provided', () => {
    render(
      <CalendarPicker
        calendars={CALENDARS}
        value={null}
        onChange={vi.fn()}
        defaultOptionLabel="Use my default calendar"
      />
    )
    expect(screen.getByRole('option', { name: 'Use my default calendar' })).toBeInTheDocument()
  })
})
