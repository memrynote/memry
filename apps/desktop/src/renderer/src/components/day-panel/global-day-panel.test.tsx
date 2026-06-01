import { QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, beforeEach, vi } from 'vitest'

import { CalendarViewProvider } from '@/contexts/calendar-view-context'
import { AISettingsProvider } from '@/contexts/ai-settings-context'
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

vi.mock('@/agent-chat/agent-pane', () => ({
  AgentPane: () => <div>Agent chat</div>
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

function renderPanelWithAISettings(aiEnabled: boolean) {
  const queryClient = createTestQueryClient()
  const api = window.api as typeof window.api
  vi.mocked(api.settings.getAISettings).mockResolvedValue({ enabled: aiEnabled })

  return render(
    <QueryClientProvider client={queryClient}>
      <AISettingsProvider>
        <TabProvider>
          <DayPanelProvider defaultOpen>
            <CalendarViewProvider>
              <GlobalDayPanel />
            </CalendarViewProvider>
          </DayPanelProvider>
        </TabProvider>
      </AISettingsProvider>
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

  it('switches between day and agent sidebar tabs', async () => {
    const user = userEvent.setup()
    renderPanel()

    expect(screen.getByRole('tab', { name: /Day/ })).toHaveAttribute('aria-selected', 'true')

    await user.click(screen.getByRole('tab', { name: /Agent/ }))

    expect(await screen.findByText('Agent chat')).toBeInTheDocument()
    expect(screen.queryByTestId('journal-day-panel')).not.toBeInTheDocument()
  })

  it('covers the tab bar instead of starting below it', () => {
    renderPanel()

    const container = document.querySelector('[data-slot="day-panel-container"]')

    expect(container).toHaveClass('top-0')
    expect(container).not.toHaveClass('top-[37px]')
  })

  it('renders with only a left border edge', () => {
    renderPanel()

    const container = document.querySelector('[data-slot="day-panel-container"]')

    expect(container).toHaveClass('bg-background')
    expect(container).not.toHaveClass('bg-sidebar')
    expect(container).toHaveClass('border-s')
    expect(container).toHaveClass('border-border')
    expect(container).not.toHaveClass('border-b')
  })

  it('keeps the day panel toggle at the far edge when open', () => {
    renderPanel()

    const headerActions = document.querySelector('[data-slot="day-panel-header-actions"]')
    const toggleSlot = document.querySelector('[data-slot="day-panel-toggle-slot"]')

    expect(headerActions).toBeInTheDocument()
    expect(headerActions).toHaveClass('ms-auto')
    expect(toggleSlot).toBeInTheDocument()
    expect(toggleSlot).toHaveClass('pe-[13px]')
  })

  it('hides the agent sidebar tab when AI is disabled', async () => {
    renderPanelWithAISettings(false)

    expect(await screen.findByRole('tab', { name: /Day/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('tab', { name: /Agent/ })).not.toBeInTheDocument()
    expect(screen.getByTestId('journal-day-panel')).toBeInTheDocument()
  })
})
