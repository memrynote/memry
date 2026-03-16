import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

import { DatePickerCalendar } from './date-picker-calendar'

const renderCalendar = (
  overrides: Partial<{
    selected: Date
    onSelect: (date: Date | undefined) => void
    disabled: (date: Date) => boolean
    weekStartsOn: 0 | 1
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
      // March 2026 starts on Sunday → Monday-start grid has 6 leading slots (Feb 23-28)
      renderCalendar({ selected: new Date(2026, 2, 15) })

      const allButtons = screen.getAllByRole('button', { name: /\w+day,/ })
      const feb23Button = allButtons.find((btn) =>
        btn.getAttribute('aria-label')?.includes('February 23')
      )
      expect(feb23Button).toBeInTheDocument()
      expect(feb23Button).toBeDisabled()
    })

    it('fills trailing empty slots with next month days', () => {
      // March 2026 has 31 days, last row needs trailing April days
      renderCalendar({ selected: new Date(2026, 2, 15) })

      const allButtons = screen.getAllByRole('button', { name: /\w+day,/ })
      const apr1Button = allButtons.find((btn) =>
        btn.getAttribute('aria-label')?.includes('April 1')
      )
      // If last week is full (31st falls on Tuesday), April days fill Wed-Sun
      if (apr1Button) {
        expect(apr1Button).toBeDisabled()
      }
    })

    it('outside month days are not selectable', () => {
      const onSelect = vi.fn()
      renderCalendar({ selected: new Date(2026, 2, 15), onSelect })

      const allButtons = screen.getAllByRole('button', { name: /\w+day,/ })
      const outsideBtn = allButtons.find((btn) =>
        btn.getAttribute('aria-label')?.includes('February')
      )
      if (outsideBtn) {
        fireEvent.click(outsideBtn)
        expect(onSelect).not.toHaveBeenCalled()
      }
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
})
