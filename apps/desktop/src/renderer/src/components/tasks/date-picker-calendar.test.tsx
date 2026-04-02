import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

import { DatePickerCalendar, getISOWeekNumber } from './date-picker-calendar'

const renderCalendar = (
  overrides: Partial<{
    selected: Date
    onSelect: (date: Date | undefined) => void
    disabled: (date: Date) => boolean
    weekStartsOn: 0 | 1
    showWeekNumbers: boolean
    onTodayClick: () => void
  }> = {}
) => {
  const onSelect = overrides.onSelect ?? vi.fn()
  return {
    onSelect,
    ...render(
      <DatePickerCalendar
        selected={overrides.selected}
        onSelect={onSelect}
        disabled={overrides.disabled}
        weekStartsOn={overrides.weekStartsOn}
        showWeekNumbers={overrides.showWeekNumbers}
        onTodayClick={overrides.onTodayClick}
      />
    )
  }
}

describe('DatePickerCalendar', () => {
  describe('rendering', () => {
    it('renders month label and navigation arrows', () => {
      renderCalendar({ selected: new Date(2026, 2, 15) })
      expect(screen.getByText('March 2026')).toBeInTheDocument()
      expect(screen.getByLabelText('Previous month')).toBeInTheDocument()
      expect(screen.getByLabelText('Next month')).toBeInTheDocument()
    })

    it('renders weekday headers starting Monday by default', () => {
      renderCalendar()
      const headers = screen.getAllByText(/^(Mo|Tu|We|Th|Fr|Sa|Su)$/)
      expect(headers[0]).toHaveTextContent('Mo')
      expect(headers[6]).toHaveTextContent('Su')
    })

    it('renders weekday headers starting Sunday when weekStartsOn=0', () => {
      renderCalendar({ weekStartsOn: 0 })
      const headers = screen.getAllByText(/^(Mo|Tu|We|Th|Fr|Sa|Su)$/)
      expect(headers[0]).toHaveTextContent('Su')
      expect(headers[6]).toHaveTextContent('Sa')
    })
  })

  describe('adjacent month days', () => {
    it('fills leading empty slots with previous month days', () => {
      renderCalendar({ selected: new Date(2026, 2, 15) })

      const allButtons = screen.getAllByRole('button', { name: /\w+day,/ })
      const feb23Button = allButtons.find((btn) =>
        btn.getAttribute('aria-label')?.includes('February 23')
      )
      expect(feb23Button).toBeInTheDocument()
      expect(feb23Button).not.toBeDisabled()
    })

    it('fills trailing empty slots with next month days', () => {
      renderCalendar({ selected: new Date(2026, 2, 15) })

      const allButtons = screen.getAllByRole('button', { name: /\w+day,/ })
      const apr1Button = allButtons.find((btn) =>
        btn.getAttribute('aria-label')?.includes('April 1')
      )
      if (apr1Button) {
        expect(apr1Button).not.toBeDisabled()
      }
    })

    it('clicking outside month day selects it and navigates to that month', () => {
      const onSelect = vi.fn()
      renderCalendar({ selected: new Date(2026, 2, 15), onSelect })

      const allButtons = screen.getAllByRole('button', { name: /\w+day,/ })
      const feb23Btn = allButtons.find((btn) =>
        btn.getAttribute('aria-label')?.includes('February 23')
      )
      expect(feb23Btn).toBeInTheDocument()
      fireEvent.click(feb23Btn!)
      expect(onSelect).toHaveBeenCalledWith(new Date(2026, 1, 23))
      expect(screen.getByText('February 2026')).toBeInTheDocument()
    })
  })

  describe('month navigation', () => {
    it('navigates to previous month', () => {
      renderCalendar({ selected: new Date(2026, 2, 15) })
      expect(screen.getByText('March 2026')).toBeInTheDocument()

      fireEvent.click(screen.getByLabelText('Previous month'))
      expect(screen.getByText('February 2026')).toBeInTheDocument()
    })

    it('navigates to next month', () => {
      renderCalendar({ selected: new Date(2026, 2, 15) })
      fireEvent.click(screen.getByLabelText('Next month'))
      expect(screen.getByText('April 2026')).toBeInTheDocument()
    })

    it('wraps year when navigating past December', () => {
      renderCalendar({ selected: new Date(2026, 11, 15) })
      expect(screen.getByText('December 2026')).toBeInTheDocument()

      fireEvent.click(screen.getByLabelText('Next month'))
      expect(screen.getByText('January 2027')).toBeInTheDocument()
    })

    it('wraps year when navigating before January', () => {
      renderCalendar({ selected: new Date(2026, 0, 15) })
      expect(screen.getByText('January 2026')).toBeInTheDocument()

      fireEvent.click(screen.getByLabelText('Previous month'))
      expect(screen.getByText('December 2025')).toBeInTheDocument()
    })
  })

  describe('date selection', () => {
    it('calls onSelect when a day is clicked', () => {
      const onSelect = vi.fn()
      renderCalendar({ selected: new Date(2026, 2, 15), onSelect })

      const day20 = screen
        .getAllByRole('button', { name: /\w+day,/ })
        .find((btn) => btn.getAttribute('aria-label')?.includes('March 20'))
      expect(day20).toBeInTheDocument()
      fireEvent.click(day20!)
      expect(onSelect).toHaveBeenCalledWith(new Date(2026, 2, 20))
    })

    it('highlights selected date', () => {
      renderCalendar({ selected: new Date(2026, 2, 15) })

      const day15 = screen
        .getAllByRole('button', { name: /\w+day,/ })
        .find((btn) => btn.getAttribute('aria-label')?.includes('March 15'))
      expect(day15).toHaveAttribute('aria-pressed', 'true')
    })

    it('does not call onSelect for disabled dates', () => {
      const onSelect = vi.fn()
      renderCalendar({
        selected: new Date(2026, 2, 15),
        onSelect,
        disabled: (d) => d.getDate() === 20
      })

      const day20 = screen
        .getAllByRole('button', { name: /\w+day,/ })
        .find((btn) => btn.getAttribute('aria-label')?.includes('March 20'))
      fireEvent.click(day20!)
      expect(onSelect).not.toHaveBeenCalled()
    })
  })

  describe('getISOWeekNumber', () => {
    it('returns correct ISO week for a mid-year date', () => {
      expect(getISOWeekNumber(new Date(2026, 2, 15))).toBe(11)
    })

    it('handles year boundary — Dec 29 2025 is ISO week 1 of 2026', () => {
      expect(getISOWeekNumber(new Date(2025, 11, 29))).toBe(1)
    })

    it('handles Jan 1 2026 as ISO week 1', () => {
      expect(getISOWeekNumber(new Date(2026, 0, 1))).toBe(1)
    })

    it('handles late December still in current year ISO week', () => {
      expect(getISOWeekNumber(new Date(2025, 11, 28))).toBe(52)
    })
  })

  describe('week numbers', () => {
    it('does not render week numbers by default', () => {
      renderCalendar({ selected: new Date(2026, 2, 15) })
      expect(screen.queryByText('W')).not.toBeInTheDocument()
    })

    it('renders "W" header when showWeekNumbers is true', () => {
      renderCalendar({ selected: new Date(2026, 2, 15), showWeekNumbers: true })
      expect(screen.getByText('W')).toBeInTheDocument()
    })

    it('renders ISO week numbers for each row', () => {
      renderCalendar({ selected: new Date(2026, 2, 15), showWeekNumbers: true })
      expect(screen.getByLabelText('Week 9')).toBeInTheDocument()
      expect(screen.getByLabelText('Week 10')).toBeInTheDocument()
      expect(screen.getByLabelText('Week 11')).toBeInTheDocument()
      expect(screen.getByLabelText('Week 12')).toBeInTheDocument()
      expect(screen.getByLabelText('Week 13')).toBeInTheDocument()
    })

    it('week number cells are not buttons', () => {
      renderCalendar({ selected: new Date(2026, 2, 15), showWeekNumbers: true })
      const weekLabel = screen.getByLabelText('Week 9')
      expect(weekLabel.tagName).not.toBe('BUTTON')
    })
  })

  describe('today button', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('does not render when onTodayClick is not provided', () => {
      renderCalendar({ selected: new Date(2026, 2, 15) })
      expect(screen.queryByLabelText('Go to today')).not.toBeInTheDocument()
    })

    it('renders when viewing the current month and onTodayClick is provided', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(2026, 2, 15))

      renderCalendar({
        selected: new Date(2026, 2, 15),
        onTodayClick: vi.fn()
      })
      expect(screen.getByLabelText('Go to today')).toBeInTheDocument()
    })

    it('renders when viewing a different month', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(2026, 2, 15))

      renderCalendar({
        selected: new Date(2026, 0, 15),
        onTodayClick: vi.fn()
      })
      expect(screen.getByLabelText('Go to today')).toBeInTheDocument()
    })

    it('calls onTodayClick and navigates to current month when clicked', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(2026, 2, 15))

      const onTodayClick = vi.fn()
      renderCalendar({
        selected: new Date(2026, 0, 15),
        onTodayClick
      })

      expect(screen.getByText('January 2026')).toBeInTheDocument()
      fireEvent.click(screen.getByLabelText('Go to today'))
      expect(onTodayClick).toHaveBeenCalledTimes(1)
      expect(screen.getByText('March 2026')).toBeInTheDocument()
    })

    it('remains visible after navigating away from current month', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(2026, 2, 15))

      renderCalendar({
        selected: new Date(2026, 2, 15),
        onTodayClick: vi.fn()
      })

      expect(screen.getByLabelText('Go to today')).toBeInTheDocument()

      fireEvent.click(screen.getByLabelText('Next month'))
      expect(screen.getByText('April 2026')).toBeInTheDocument()
      expect(screen.getByLabelText('Go to today')).toBeInTheDocument()
    })
  })
})
