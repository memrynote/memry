import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { DayPanelDayHeader } from './day-panel-day-header'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } })
}))

describe('DayPanelDayHeader', () => {
  it('names today as Today with its short date beside it', () => {
    render(<DayPanelDayHeader date="2026-09-23" isToday />)

    expect(screen.getByRole('heading')).toHaveTextContent('date.relative.todayWed, Sep 23')
  })

  it('names another day by its weekday with the month and day beside it', () => {
    render(<DayPanelDayHeader date="2026-09-24" isToday={false} />)

    expect(screen.getByRole('heading')).toHaveTextContent('ThursdaySep 24')
  })

  it('opens the day in the Calendar, and hides that action without a handler', async () => {
    const onOpenCalendar = vi.fn()
    const { rerender } = render(
      <DayPanelDayHeader date="2026-09-24" isToday={false} onOpenCalendar={onOpenCalendar} />
    )

    await userEvent.click(screen.getByRole('button', { name: 'dayPanel.openInCalendar' }))
    expect(onOpenCalendar).toHaveBeenCalledWith('2026-09-24')

    rerender(<DayPanelDayHeader date="2026-09-24" isToday={false} />)
    expect(screen.queryByRole('button')).toBeNull()
  })
})
