import { useCallback, useMemo, useRef } from 'react'
import { cn } from '@/lib/utils'
import {
  useDayPanel,
  DAY_PANEL_WIDTH_DEFAULT_PX,
  DAY_PANEL_WIDTH_MIN_PX,
  DAY_PANEL_WIDTH_MAX_PX
} from '@/contexts/day-panel-context'
import { useTabs } from '@/contexts/tabs'
import { DatePickerCalendar } from '@/components/tasks/date-picker-calendar'
import { JournalDayPanel } from '@/components/journal'
import { useJournalHeatmap } from '@/hooks/use-journal'
import { formatDateToISO, parseISODate, getTodayString } from '@/lib/journal-utils'

interface GlobalDayPanelProps {
  className?: string
}

function DayPanelResizeRail() {
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
      aria-label="Resize Day Panel"
      tabIndex={-1}
      onMouseDown={handleMouseDown}
      onDoubleClick={handleDoubleClick}
      title="Drag to resize · Double-click to reset"
      className="absolute inset-y-0 left-0 z-20 w-4 -translate-x-1/2 cursor-col-resize after:absolute after:inset-y-0 after:left-1/2 after:w-[2px] hover:after:bg-sidebar-border"
    />
  )
}

export function GlobalDayPanel({ className }: GlobalDayPanelProps) {
  const { isOpen, selectedDate, width, isResizing, setDate } = useDayPanel()
  const { openTab } = useTabs()

  const selectedDateObj = parseISODate(selectedDate)
  const currentYear = selectedDateObj.getFullYear()
  const { data: heatmapData } = useJournalHeatmap(currentYear)

  const calendarActivityData = useMemo(() => {
    const map: Record<string, number> = {}
    for (const entry of heatmapData) {
      map[entry.date] = entry.level
    }
    return map
  }, [heatmapData])

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

  const handleDateSelect = useCallback(
    (date: Date | undefined) => {
      if (!date) return
      const iso = formatDateToISO(date)
      setDate(iso)
      navigateToJournal(iso)
    },
    [setDate, navigateToJournal]
  )

  const handleTodayClick = useCallback(() => {
    const today = getTodayString()
    setDate(today)
    navigateToJournal(today)
  }, [setDate, navigateToJournal])

  return (
    <div
      data-slot="day-panel-container"
      style={{ width: isOpen ? `${width}px` : 0 }}
      className={cn(
        'fixed top-[37px] bottom-0 right-0 z-10',
        !isResizing && 'transition-[width] duration-200 ease-linear',
        'flex flex-col bg-sidebar border-l border-sidebar-border',
        className
      )}
    >
      <div
        data-slot="day-panel-inner"
        style={{ width: `${width}px` }}
        className={cn(
          'relative flex h-full flex-col',
          'transition-opacity duration-200',
          isOpen ? 'opacity-100' : 'opacity-0'
        )}
      >
        {isOpen && <DayPanelResizeRail />}

        <div className="flex-1 overflow-y-auto pt-3">
          <div className="px-4 pb-3">
            <DatePickerCalendar
              selected={selectedDateObj}
              onSelect={handleDateSelect}
              activityData={calendarActivityData}
              className="w-full"
              showWeekNumbers
              onTodayClick={handleTodayClick}
            />
          </div>
          <div className="h-px mx-4 bg-border/30" />
          <div className="p-4">
            <JournalDayPanel date={selectedDate} />
          </div>
        </div>
      </div>
    </div>
  )
}

export default GlobalDayPanel
