import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CalendarSidebar } from './calendar-sidebar'
import { CalendarToolbar, getSubLabel } from './calendar-toolbar'
import { GlobalDayPanel } from '@/components/day-panel/global-day-panel'

const dayPanel = vi.hoisted(() => ({
  isOpen: true,
  selectedDate: '2026-05-10',
  width: 360,
  isResizing: false,
  setDate: vi.fn(),
  setWidth: vi.fn(),
  setIsResizing: vi.fn()
}))

const tabs = vi.hoisted(() => ({
  activeTab: { type: 'journal' } as Record<string, unknown> | null,
  openTab: vi.fn()
}))

const calendarView = vi.hoisted(() => ({
  setAnchorDate: vi.fn()
}))

const calendarPreferences = vi.hoisted(() => ({
  settings: { dayCellClickBehavior: 'journal' } as Record<string, unknown>
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string) => key,
    i18n: { language: 'en-US' }
  })
}))

vi.mock('@/contexts/day-panel-context', () => ({
  DAY_PANEL_WIDTH_DEFAULT_PX: 360,
  DAY_PANEL_WIDTH_MIN_PX: 280,
  DAY_PANEL_WIDTH_MAX_PX: 560,
  useDayPanel: () => dayPanel
}))

vi.mock('@/contexts/tabs', () => ({
  useTabs: () => ({ openTab: tabs.openTab }),
  useActiveTab: () => tabs.activeTab
}))

vi.mock('@/contexts/calendar-view-context', () => ({
  useCalendarView: () => calendarView
}))

vi.mock('@/hooks/use-calendar-preferences', () => ({
  useCalendarPreferences: () => calendarPreferences,
  resolveDayCellClickBehavior: (settings: Record<string, unknown>, isCalendarTabActive: boolean) =>
    settings.dayCellClickBehavior ?? (isCalendarTabActive ? 'calendar' : 'journal')
}))

vi.mock('@/hooks/use-journal', () => ({
  useJournalHeatmap: () => ({
    data: [{ date: '2026-05-10', level: 3 }]
  })
}))

vi.mock('@/hooks/use-calendar-range', () => ({
  useCalendarRange: () => ({
    items: [{ id: 'event-1', startsAt: '2026-05-10T09:00:00.000Z', color: '#3366ff' }]
  })
}))

vi.mock('@/components/calendar/day-dots', () => ({
  buildDayDots: () => [{ date: '2026-05-10', color: '#3366ff' }]
}))

vi.mock('@/components/tasks/date-picker-calendar', () => ({
  DatePickerCalendar: ({
    onSelect,
    onTodayClick,
    activityData,
    dayDots,
    hoveredEventColor
  }: {
    onSelect: (date: Date | undefined) => void
    onTodayClick: () => void
    activityData?: Record<string, number>
    dayDots?: Array<unknown>
    hoveredEventColor?: string | null
  }) => (
    <div data-testid="day-panel-calendar">
      <span>activity:{activityData ? 'yes' : 'no'}</span>
      <span>dots:{dayDots ? dayDots.length : 0}</span>
      <span>hover:{hoveredEventColor ?? 'none'}</span>
      <button type="button" onClick={() => onSelect(new Date(2026, 4, 11))}>
        select panel date
      </button>
      <button type="button" onClick={() => onSelect(undefined)}>
        clear panel date
      </button>
      <button type="button" onClick={onTodayClick}>
        panel today
      </button>
    </div>
  )
}))

vi.mock('@/components/journal', () => ({
  JournalDayPanel: ({
    date,
    onHoverColor
  }: {
    date: string
    onHoverColor: (color: string | null) => void
  }) => (
    <div data-testid="journal-day-panel">
      {date}
      <button type="button" onClick={() => onHoverColor('#ff0000')}>
        hover event
      </button>
    </div>
  )
}))

describe('calendar lightweight surfaces', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    dayPanel.isOpen = true
    dayPanel.selectedDate = '2026-05-10'
    dayPanel.width = 360
    dayPanel.isResizing = false
    tabs.activeTab = { type: 'journal' }
    calendarPreferences.settings = { dayCellClickBehavior: 'journal' }
  })

  it('toggles calendar sidebar filters and imported source rows', async () => {
    const user = userEvent.setup()
    const onToggleMemryItems = vi.fn()
    const onToggleImportedCalendars = vi.fn()
    const onToggleImportedSource = vi.fn()

    const { rerender } = render(
      <CalendarSidebar
        showMemryItems
        showImportedCalendars={false}
        importedSources={
          [
            { id: 'google-work', title: 'Work Calendar' },
            { id: 'google-home', title: 'Home Calendar' }
          ] as never
        }
        selectedImportedSourceIds={['google-work']}
        onToggleMemryItems={onToggleMemryItems}
        onToggleImportedCalendars={onToggleImportedCalendars}
        onToggleImportedSource={onToggleImportedSource}
      />
    )

    await user.click(screen.getByRole('checkbox', { name: 'filter.memry-items' }))
    await user.click(screen.getByRole('checkbox', { name: 'filter.imported-calendars' }))
    expect(onToggleMemryItems).toHaveBeenCalledTimes(1)
    expect(onToggleImportedCalendars).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('checkbox', { name: 'Work Calendar' })).toBeDisabled()

    rerender(
      <CalendarSidebar
        showMemryItems
        showImportedCalendars
        importedSources={[{ id: 'google-home', title: 'Home Calendar' }] as never}
        selectedImportedSourceIds={[]}
        onToggleMemryItems={onToggleMemryItems}
        onToggleImportedCalendars={onToggleImportedCalendars}
        onToggleImportedSource={onToggleImportedSource}
      />
    )
    await user.click(screen.getByRole('checkbox', { name: 'Home Calendar' }))
    expect(onToggleImportedSource).toHaveBeenCalledWith('google-home')

    rerender(
      <CalendarSidebar
        showMemryItems
        showImportedCalendars
        importedSources={[]}
        selectedImportedSourceIds={[]}
        onToggleMemryItems={onToggleMemryItems}
        onToggleImportedCalendars={onToggleImportedCalendars}
        onToggleImportedSource={onToggleImportedSource}
      />
    )
    expect(screen.getByText('empty.no-imported-calendars-yet')).toBeInTheDocument()
  })

  it('drives toolbar actions and sublabels for all views', async () => {
    const user = userEvent.setup()
    const onViewChange = vi.fn()
    const onPrevious = vi.fn()
    const onNext = vi.fn()
    const onToday = vi.fn()
    const onCreateEvent = vi.fn()

    render(
      <CalendarToolbar
        view="week"
        anchorDate="2026-05-10"
        onViewChange={onViewChange}
        onPrevious={onPrevious}
        onNext={onNext}
        onToday={onToday}
        onCreateEvent={onCreateEvent}
        extraActions={<button type="button">extra action</button>}
      />
    )

    await user.click(screen.getByRole('button', { name: 'toolbar.create-event' }))
    expect(onCreateEvent).toHaveBeenCalledWith({ x: 0, y: 0, width: 0, height: 0 })

    for (const label of ['view.day', 'view.month', 'view.year']) {
      await user.click(screen.getByRole('button', { name: label }))
    }
    expect(onViewChange).toHaveBeenCalledWith('day')
    expect(onViewChange).toHaveBeenCalledWith('month')
    expect(onViewChange).toHaveBeenCalledWith('year')

    await user.click(screen.getByRole('button', { name: 'toolbar.previous-period' }))
    await user.click(screen.getByRole('button', { name: 'toolbar.today' }))
    await user.click(screen.getByRole('button', { name: 'toolbar.next-period' }))
    expect(onPrevious).toHaveBeenCalledTimes(1)
    expect(onToday).toHaveBeenCalledTimes(1)
    expect(onNext).toHaveBeenCalledTimes(1)

    expect(getSubLabel('day', '2026-05-10', 'en-US')).toBe('Sunday')
    expect(getSubLabel('week', '2026-05-10', 'en-US')).toContain('May')
    expect(getSubLabel('month', '2026-05-10', 'en-US')).toContain('May')
    expect(getSubLabel('year', '2026-05-10', 'en-US')).toBe('2026')
  })

  it('routes global day panel date picks and resizes the panel rail', async () => {
    const user = userEvent.setup()

    render(<GlobalDayPanel />)

    expect(screen.getByTestId('day-panel-calendar')).toHaveTextContent('activity:yes')
    await user.click(screen.getByRole('button', { name: 'select panel date' }))
    expect(dayPanel.setDate).toHaveBeenCalledWith('2026-05-11')
    expect(tabs.openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'journal', viewState: { date: '2026-05-11' } })
    )

    await user.click(screen.getByRole('button', { name: 'hover event' }))
    expect(screen.getByTestId('day-panel-calendar')).toHaveTextContent('hover:#ff0000')

    calendarPreferences.settings.dayCellClickBehavior = 'calendar'
    await user.click(screen.getByRole('button', { name: 'panel today' }))
    expect(calendarView.setAnchorDate).toHaveBeenCalled()
    expect(tabs.openTab).toHaveBeenCalledWith(expect.objectContaining({ type: 'calendar' }))

    const rail = screen.getByRole('button', {
      name: 'phaseF.componentsDayPanelGlobalDayPanel.resizeDayPanel'
    })
    fireEvent.mouseDown(rail, { clientX: 500 })
    fireEvent.mouseMove(document, { clientX: 450 })
    expect(dayPanel.setIsResizing).toHaveBeenCalledWith(true)
    expect(dayPanel.setWidth).toHaveBeenCalledWith(410)
    fireEvent.mouseUp(document)
    expect(dayPanel.setIsResizing).toHaveBeenCalledWith(false)
    fireEvent.doubleClick(rail)
    expect(dayPanel.setWidth).toHaveBeenCalledWith(360)
  })

  it('keeps calendar-tab day panel navigation inside the active calendar tab', async () => {
    const user = userEvent.setup()
    tabs.activeTab = { type: 'calendar' }
    calendarPreferences.settings = { dayCellClickBehavior: 'calendar' }

    render(<GlobalDayPanel />)

    expect(screen.getByTestId('day-panel-calendar')).toHaveTextContent('dots:1')
    await user.click(screen.getByRole('button', { name: 'select panel date' }))

    expect(calendarView.setAnchorDate).toHaveBeenCalledWith('2026-05-11')
    expect(tabs.openTab).not.toHaveBeenCalled()
  })
})
