import { lazy, Suspense, useCallback, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { SidebarTabs } from '@/agent-chat/sidebar-tabs'
import { TabBarAction } from '@/components/tabs/tab-bar-action'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  useDayPanel,
  DAY_PANEL_WIDTH_DEFAULT_PX,
  DAY_PANEL_WIDTH_MIN_PX,
  DAY_PANEL_WIDTH_MAX_PX
} from '@/contexts/day-panel-context'
import { PanelRightIcon } from '@/lib/icons'
import { useTabs, useActiveTab } from '@/contexts/tabs'
import { useCalendarView } from '@/contexts/calendar-view-context'
import { DatePickerCalendar } from '@/components/tasks/date-picker-calendar'
import { JournalDayPanel } from '@/components/journal'
import { useJournalHeatmap } from '@/hooks/use-journal'
import { useCalendarRange } from '@/hooks/use-calendar-range'
import { useToday } from '@/hooks/use-today'
import {
  useCalendarPreferences,
  resolveDayCellClickBehavior,
  weekStartsOnFromSettings
} from '@/hooks/use-calendar-preferences'
import {
  addLocalDays,
  getMonthGridDays,
  toStartOfLocalDayIso
} from '@/components/calendar/date-utils'
import { buildDayDots } from '@/components/calendar/day-dots'
import { buildDaySummaries } from '@/components/calendar/day-summary'
import { formatDateToISO, parseISODate, getTodayString } from '@/lib/journal-utils'
import { useT } from '@memry/i18n/renderer'
import { useFeatureFlags } from '@/hooks/use-feature-flags'

interface GlobalDayPanelProps {
  className?: string
}

const LazyAgentPane = lazy(async () => ({
  default: (await import('@/agent-chat/agent-pane')).AgentPane
}))

function DayPanelResizeRail() {
  const { t: tPhaseF } = useT('common')
  const { width, setWidth, setIsResizing } = useDayPanel()
  const startXRef = useRef(0)
  const startWidthRef = useRef(0)
  const hasDraggedRef = useRef(false)

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      startXRef.current = e.clientX
      startWidthRef.current = width
      hasDraggedRef.current = false
      setIsResizing(true)

      const onMouseMove = (moveEvent: MouseEvent): void => {
        const delta = moveEvent.clientX - startXRef.current
        if (Math.abs(delta) > 2) hasDraggedRef.current = true
        const maxWidth = Math.min(DAY_PANEL_WIDTH_MAX_PX, window.innerWidth * 0.5)
        const newWidth = Math.min(
          maxWidth,
          Math.max(DAY_PANEL_WIDTH_MIN_PX, startWidthRef.current - delta)
        )
        setWidth(newWidth)
      }

      const onMouseUp = (): void => {
        setIsResizing(false)
        document.removeEventListener('mousemove', onMouseMove)
        document.removeEventListener('mouseup', onMouseUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }

      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      document.addEventListener('mousemove', onMouseMove)
      document.addEventListener('mouseup', onMouseUp)
    },
    [width, setWidth, setIsResizing]
  )

  const handleDoubleClick = useCallback(() => {
    setWidth(DAY_PANEL_WIDTH_DEFAULT_PX)
  }, [setWidth])

  return (
    <button
      type="button"
      aria-label={tPhaseF('phaseF.componentsDayPanelGlobalDayPanel.resizeDayPanel')}
      tabIndex={-1}
      onMouseDown={handleMouseDown}
      onDoubleClick={handleDoubleClick}
      title={tPhaseF('phaseF.componentsDayPanelGlobalDayPanel.dragToResizeDoubleClickToReset')}
      className="absolute inset-y-0 start-0 z-20 w-4 -translate-x-1/2 cursor-col-resize after:absolute after:inset-y-0 after:start-1/2 after:w-[2px] hover:after:bg-sidebar-border"
    />
  )
}

export function GlobalDayPanel({ className }: GlobalDayPanelProps) {
  const { isOpen, width, isResizing } = useDayPanel()

  return (
    <div
      data-slot="day-panel-container"
      style={{ width: isOpen ? `${width}px` : 0 }}
      className={cn(
        'fixed top-0 bottom-0 end-0 z-10',
        !isResizing && 'transition-[width] duration-200 ease-linear',
        'flex flex-col border-s border-border bg-background',
        className
      )}
    >
      {isOpen && <GlobalDayPanelContent width={width} />}
    </div>
  )
}

function GlobalDayPanelContent({ width }: { width: number }): React.JSX.Element {
  const { t, i18n } = useT('journal')
  const { t: tCommon } = useT('common')
  const { selectedDate, setDate, toggle } = useDayPanel()
  const { openTab } = useTabs()
  const activeTab = useActiveTab()
  const { setAnchorDate } = useCalendarView()
  const { settings: calendarPrefs } = useCalendarPreferences()
  const { isEnabled } = useFeatureFlags()
  const isCalendarTabActive = activeTab?.type === 'calendar'

  const [hoveredEvent, setHoveredEvent] = useState<{ date: string; color: string | null }>({
    date: selectedDate,
    color: null
  })
  const hoveredEventColor = hoveredEvent.date === selectedDate ? hoveredEvent.color : null

  const handleHoverColor = useCallback(
    (color: string | null) => {
      setHoveredEvent((prev) => {
        if (prev.date === selectedDate && prev.color === color) return prev
        return { date: selectedDate, color }
      })
    },
    [selectedDate]
  )

  const today = useToday()
  const selectedDateObj = parseISODate(selectedDate)
  const dayPanelLabel =
    selectedDate === today
      ? t('date.relative.today')
      : selectedDateObj.toLocaleDateString(i18n.language, { month: 'short', day: 'numeric' })
  const currentYear = selectedDateObj.getFullYear()
  const { data: heatmapData } = useJournalHeatmap(currentYear)

  const monthRangeInput = useMemo(() => {
    const gridDays = getMonthGridDays(selectedDate)
    const first = gridDays[0]
    const last = gridDays[gridDays.length - 1]
    return {
      startAt: toStartOfLocalDayIso(first),
      endAt: toStartOfLocalDayIso(addLocalDays(last, 1)),
      includeUnselectedSources: true
    }
  }, [selectedDate])

  const { items: eventItems } = useCalendarRange(monthRangeInput)

  const journalActivityData = useMemo(() => {
    const map: Record<string, number> = {}
    for (const entry of heatmapData) {
      map[entry.date] = entry.level
    }
    return map
  }, [heatmapData])

  const dayDotsData = useMemo(
    () => (isEnabled('calendar') ? buildDayDots(eventItems) : {}),
    [isEnabled, eventItems]
  )

  // On non-calendar tabs (e.g. Journal) the calendar shows journal-activity dots.
  // Also surface a notes dot there so days with notes are visible alongside activity.
  const noteDayDotsData = useMemo(
    () =>
      isEnabled('calendar')
        ? buildDayDots(
            eventItems.filter(
              (item) => item.visualType === 'note' || item.visualType === 'note_date'
            )
          )
        : {},
    [isEnabled, eventItems]
  )

  // Per-day rollup for the day-cell hover summary (notes/journal/tasks/events/reminders).
  const daySummaryData = useMemo(
    () => (isEnabled('calendar') ? buildDaySummaries(eventItems, journalActivityData) : {}),
    [isEnabled, eventItems, journalActivityData]
  )

  const navigateToJournal = useCallback(
    (date: string) => {
      openTab({
        type: 'journal',
        title: 'Journal',
        icon: 'book-open',
        path: '/journal',
        isPinned: false,
        isModified: false,
        isPreview: false,
        isDeleted: false,
        viewState: { date }
      })
    },
    [openTab]
  )

  const navigateToCalendar = useCallback(
    (date: string) => {
      setAnchorDate(date)
      if (isCalendarTabActive) return
      openTab({
        type: 'calendar',
        title: 'Calendar',
        icon: 'calendar',
        path: '/calendar',
        isPinned: false,
        isModified: false,
        isPreview: false,
        isDeleted: false
      })
    },
    [isCalendarTabActive, openTab, setAnchorDate]
  )

  const handleDateSelect = useCallback(
    (date: Date | undefined) => {
      if (!date) return
      const iso = formatDateToISO(date)
      setDate(iso)
      const target = resolveDayCellClickBehavior(calendarPrefs, isCalendarTabActive)
      if (target === 'calendar') {
        navigateToCalendar(iso)
        return
      }
      navigateToJournal(iso)
    },
    [calendarPrefs, isCalendarTabActive, setDate, navigateToCalendar, navigateToJournal]
  )

  const handleTodayClick = useCallback(() => {
    const today = getTodayString()
    setDate(today)
    const target = resolveDayCellClickBehavior(calendarPrefs, isCalendarTabActive)
    if (target === 'calendar') {
      navigateToCalendar(today)
      return
    }
    navigateToJournal(today)
  }, [calendarPrefs, isCalendarTabActive, setDate, navigateToCalendar, navigateToJournal])

  const endAccessory = useMemo(
    () => (
      <TooltipProvider delayDuration={300}>
        <TabBarAction
          icon={<PanelRightIcon className="w-4 h-4 text-tint transition-colors duration-150" />}
          tooltip={tCommon('phaseF.componentsTabsTabBarWithDrag.dayPanel')}
          onClick={toggle}
          isActive
        />
      </TooltipProvider>
    ),
    [tCommon, toggle]
  )

  return (
    <div
      data-slot="day-panel-inner"
      style={{ width: `${width}px` }}
      className={cn('relative flex h-full flex-col', 'transition-opacity duration-200 opacity-100')}
    >
      <DayPanelResizeRail />

      <SidebarTabs dayLabel={dayPanelLabel} endAccessory={endAccessory}>
        {{
          day: (
            <div className="h-full overflow-y-auto pt-3">
              <div className="px-4 pb-3">
                <DatePickerCalendar
                  selected={selectedDateObj}
                  onSelect={handleDateSelect}
                  activityData={isCalendarTabActive ? undefined : journalActivityData}
                  dayDots={isCalendarTabActive ? dayDotsData : noteDayDotsData}
                  daySummary={daySummaryData}
                  hoveredEventColor={hoveredEventColor}
                  className="w-full"
                  showWeekNumbers
                  weekStartsOn={weekStartsOnFromSettings(calendarPrefs)}
                  onTodayClick={handleTodayClick}
                />
              </div>
              <div className="h-px mx-4 bg-border/30" />
              <div className="p-4">
                <JournalDayPanel date={selectedDate} onHoverColor={handleHoverColor} />
              </div>
            </div>
          ),
          agent: (
            <Suspense fallback={null}>
              <LazyAgentPane />
            </Suspense>
          )
        }}
      </SidebarTabs>
    </div>
  )
}

export default GlobalDayPanel
