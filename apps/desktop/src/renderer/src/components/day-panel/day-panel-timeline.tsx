import { useMemo } from 'react'
import { useT } from '@memry/i18n/renderer'
import { CalendarDayView } from '@/components/calendar/calendar-day-view'
import { useCalendarGridActions } from '@/hooks/use-calendar-grid-actions'
import { useCalendarRange } from '@/hooks/use-calendar-range'
import { localDayRange } from '@/lib/local-day-range'

interface DayPanelTimelineProps {
  date: string
  onOpenCalendar: (date: string) => void
}

/**
 * The selected day's time grid, under the Day Panel's day header. Tasks
 * dragged here from the panel's task list become time blocks on the same task.
 */
export function DayPanelTimeline({
  date,
  onOpenCalendar
}: DayPanelTimelineProps): React.JSX.Element {
  const { t } = useT('calendar')
  const range = useMemo(() => localDayRange(date), [date])
  const { items } = useCalendarRange(range)
  const { moveItem, quickCreate } = useCalendarGridActions()

  // An untimed task is dragged from the task list below. A second draggable
  // for the same task here would share its id in the app-wide DndContext.
  const gridItems = useMemo(
    () => items.filter((item) => !(item.sourceType === 'task' && item.isAllDay)),
    [items]
  )

  return (
    <section aria-label={t('view.day')} data-testid="day-panel-timeline">
      <CalendarDayView
        anchorDate={date}
        items={gridItems}
        selectedItemId={null}
        onSelectItem={() => onOpenCalendar(date)}
        onMoveEvent={moveItem}
        onQuickSave={quickCreate}
        density="compact"
      />
    </section>
  )
}
