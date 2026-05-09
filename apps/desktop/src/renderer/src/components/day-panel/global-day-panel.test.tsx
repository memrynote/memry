import { QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, beforeEach, vi } from 'vitest'

import { CalendarViewProvider } from '@/contexts/calendar-view-context'
import { DayPanelProvider } from '@/contexts/day-panel-context'
import { TabProvider } from '@/contexts/tabs'
import { createTestQueryClient } from '@tests/utils/render'
import { GlobalDayPanel } from './global-day-panel'

const journalPanelRenderCount = vi.hoisted(() => ({ current: 0 }))
const mockUseCalendarRange = vi.hoisted(() => vi.fn())
const mockUseJournalHeatmap = vi.hoisted(() => vi.fn())

vi.mock('@/hooks/use-calendar-range', () => ({
  useCalendarRange: mockUseCalendarRange
}))

vi.mock('@/hooks/use-journal', () => ({
  useJournalHeatmap: mockUseJournalHeatmap
}))

vi.mock('@/hooks/use-calendar-preferences', () => ({
  useCalendarPreferences: () => ({
    settings: {
      dayCellClickBehavior: 'journal',
      calendarPageClickOverride: 'calendar'
    },
    isLoading: false,
    error: null,
    updateSettings: async () => true
  }),
  resolveDayCellClickBehavior: () => 'journal'
}))

vi.mock('@/components/journal', async () => {
  const React = await vi.importActual<typeof import('react')>('react')

  return {
    JournalDayPanel: ({
      date,
      onHoverColor
    }: {
      date: string
      onHoverColor?: (color: string | null) => void
    }) => {
      journalPanelRenderCount.current += 1
      if (journalPanelRenderCount.current > 8) {
        throw new Error('JournalDayPanel rendered too many times')
      }

      React.useEffect(() => {
        onHoverColor?.(null)
      })

      return React.createElement('div', {
        'data-testid': 'journal-day-panel',
        'data-date': date
      })
    }
  }
})

function renderPanel() {
  const queryClient = createTestQueryClient()

  return render(
    <QueryClientProvider client={queryClient}>
      <TabProvider>
        <DayPanelProvider defaultOpen>
          <CalendarViewProvider>
            <GlobalDayPanel />
          </CalendarViewProvider>
        </DayPanelProvider>
      </TabProvider>
    </QueryClientProvider>
  )
}

describe('GlobalDayPanel', () => {
  beforeEach(() => {
    localStorage.clear()
    journalPanelRenderCount.current = 0
    mockUseCalendarRange.mockReturnValue({ items: [] })
    mockUseJournalHeatmap.mockReturnValue({ data: [] })
  })

  it('does not loop when the day summary clears the current hover color', () => {
    renderPanel()

    expect(screen.getByTestId('journal-day-panel')).toBeInTheDocument()
    expect(journalPanelRenderCount.current).toBeLessThanOrEqual(2)
  })
})
