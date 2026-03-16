import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

import { DatePickerContent } from './date-picker-content'

const renderPicker = (
  overrides: Partial<{
    selected: Date | null
    onSelect: (date: Date | null) => void
    showRemoveDate: boolean
    time: string | null
    onTimeChange: (time: string | null) => void
  }> = {}
) => {
  const onSelect = overrides.onSelect ?? vi.fn()
  const onTimeChange = overrides.onTimeChange ?? vi.fn()
  return {
    onSelect,
    onTimeChange,
    ...render(
      <DatePickerContent
        selected={overrides.selected}
        onSelect={onSelect}
        showRemoveDate={overrides.showRemoveDate}
        time={overrides.time}
        onTimeChange={'onTimeChange' in overrides ? overrides.onTimeChange : undefined}
      />
    )
  }
}

describe('DatePickerContent', () => {
  let realDate: typeof Date

  beforeEach(() => {
    realDate = globalThis.Date
    const fixedNow = new Date(2026, 2, 16, 14, 30)
    vi.useFakeTimers()
    vi.setSystemTime(fixedNow)
  })

  afterEach(() => {
    vi.useRealTimers()
    globalThis.Date = realDate
  })

  describe('presets', () => {
    it('renders Today, Tomorrow, Next week presets with formatted dates', () => {
      renderPicker()
      expect(screen.getByText('Today')).toBeInTheDocument()
      expect(screen.getByText('Tomorrow')).toBeInTheDocument()
      expect(screen.getByText('Next week')).toBeInTheDocument()
      expect(screen.getByText('Mar 16')).toBeInTheDocument()
      expect(screen.getByText('Mar 17')).toBeInTheDocument()
      expect(screen.getByText('Mar 23')).toBeInTheDocument()
    })

    it('calls onSelect with today date when Today is clicked', () => {
      const onSelect = vi.fn()
      renderPicker({ onSelect })

      fireEvent.click(screen.getByText('Today'))
      expect(onSelect).toHaveBeenCalledTimes(1)
      const called = onSelect.mock.calls[0][0] as Date
      expect(called.getFullYear()).toBe(2026)
      expect(called.getMonth()).toBe(2)
      expect(called.getDate()).toBe(16)
    })

    it('calls onSelect with tomorrow date when Tomorrow is clicked', () => {
      const onSelect = vi.fn()
      renderPicker({ onSelect })

      fireEvent.click(screen.getByText('Tomorrow'))
      const called = onSelect.mock.calls[0][0] as Date
      expect(called.getDate()).toBe(17)
    })

    it('calls onSelect with next Monday when Next week is clicked', () => {
      const onSelect = vi.fn()
      renderPicker({ onSelect })

      fireEvent.click(screen.getByText('Next week'))
      const called = onSelect.mock.calls[0][0] as Date
      // March 16, 2026 is Monday, so next Monday is March 23
      expect(called.getDate()).toBe(23)
      expect(called.getDay()).toBe(1) // Monday
    })

    it('highlights active preset when selected matches', () => {
      const today = new Date(2026, 2, 16)
      today.setHours(0, 0, 0, 0)
      renderPicker({ selected: today })

      const todayBtn = screen.getByText('Today').closest('button')
      expect(todayBtn?.className).toContain('bg-accent')
    })
  })

  describe('remove date', () => {
    it('renders Remove date button by default', () => {
      renderPicker()
      expect(screen.getByText('Remove date')).toBeInTheDocument()
    })

    it('hides Remove date when showRemoveDate is false', () => {
      renderPicker({ showRemoveDate: false })
      expect(screen.queryByText('Remove date')).not.toBeInTheDocument()
    })

    it('calls onSelect with null when Remove date is clicked', () => {
      const onSelect = vi.fn()
      renderPicker({ onSelect })

      fireEvent.click(screen.getByText('Remove date'))
      expect(onSelect).toHaveBeenCalledWith(null)
    })
  })

  describe('calendar integration', () => {
    it('renders month navigation and calendar grid', () => {
      renderPicker({ selected: new Date(2026, 2, 16) })
      expect(screen.getByText('March 2026')).toBeInTheDocument()
      expect(screen.getByLabelText('Previous month')).toBeInTheDocument()
    })

    it('calls onSelect when a calendar day is clicked', () => {
      const onSelect = vi.fn()
      renderPicker({ selected: new Date(2026, 2, 16), onSelect })

      const day25 = screen
        .getAllByRole('button', { name: /\w+day,/ })
        .find((btn) => btn.getAttribute('aria-label')?.includes('March 25'))
      expect(day25).toBeTruthy()
      fireEvent.click(day25!)
      expect(onSelect).toHaveBeenCalledWith(new Date(2026, 2, 25))
    })
  })

  describe('time section', () => {
    it('does not show time section when onTimeChange is not provided', () => {
      renderPicker({ selected: new Date(2026, 2, 16) })
      expect(screen.queryByText('Add time')).not.toBeInTheDocument()
    })

    it('does not show time section when no date is selected', () => {
      renderPicker({ selected: null, onTimeChange: vi.fn() })
      expect(screen.queryByText('Add time')).not.toBeInTheDocument()
    })

    it('shows Add time button when date is selected and onTimeChange provided', () => {
      renderPicker({ selected: new Date(2026, 2, 16), onTimeChange: vi.fn() })
      expect(screen.getByText('Add time')).toBeInTheDocument()
    })

    it('sets default time to +1 hour when Add time is clicked', () => {
      const onTimeChange = vi.fn()
      renderPicker({ selected: new Date(2026, 2, 16), onTimeChange })

      fireEvent.click(screen.getByText('Add time'))
      // Current time is 14:30, so default is 15:00
      expect(onTimeChange).toHaveBeenCalledWith('15:00')
    })

    it('shows time input when time is set', () => {
      renderPicker({
        selected: new Date(2026, 2, 16),
        time: '14:30',
        onTimeChange: vi.fn()
      })

      const timeInput = screen.getByDisplayValue('14:30')
      expect(timeInput).toBeInTheDocument()
    })

    it('shows formatted time label', () => {
      renderPicker({
        selected: new Date(2026, 2, 16),
        time: '14:30',
        onTimeChange: vi.fn()
      })

      expect(screen.getByText('2:30 PM')).toBeInTheDocument()
    })

    it('calls onTimeChange with null when clear button is clicked', () => {
      const onTimeChange = vi.fn()
      renderPicker({
        selected: new Date(2026, 2, 16),
        time: '14:30',
        onTimeChange
      })

      fireEvent.click(screen.getByLabelText('Clear time'))
      expect(onTimeChange).toHaveBeenCalledWith(null)
    })

    it('updates time when input value changes', () => {
      const onTimeChange = vi.fn()
      renderPicker({
        selected: new Date(2026, 2, 16),
        time: '14:30',
        onTimeChange
      })

      const timeInput = screen.getByDisplayValue('14:30')
      fireEvent.change(timeInput, { target: { value: '09:15' } })
      expect(onTimeChange).toHaveBeenCalledWith('09:15')
    })
  })
})
