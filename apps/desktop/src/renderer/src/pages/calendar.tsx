import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CalendarShell,
  type CalendarEventDraft,
  type CalendarWorkspaceView
} from '@/components/calendar'
import {
  addLocalDays,
  addLocalMonths,
  addLocalYears,
  getMonthGridDays,
  getStartOfWeek,
  localInputToIso,
  parseLocalDate,
  toLocalDateInputValue,
  toLocalDateString,
  toLocalDateTimeInputValue,
  toStartOfLocalDayIso
} from '@/components/calendar/date-utils'
import { useCalendarRange } from '@/hooks/use-calendar-range'
import {
  calendarService,
  type CalendarProjectionItem,
  type CalendarSourceRecord
} from '@/services/calendar-service'
import { useDayPanel } from '@/contexts/day-panel-context'

interface CalendarPageProps {
  className?: string
}

const CALENDAR_VIEW_KEY = 'calendar-view'
const VALID_VIEWS: CalendarWorkspaceView[] = ['day', 'week', 'month', 'year']

function getPersistedView(): CalendarWorkspaceView {
  try {
    const stored = localStorage.getItem(CALENDAR_VIEW_KEY)
    if (stored && VALID_VIEWS.includes(stored as CalendarWorkspaceView)) {
      return stored as CalendarWorkspaceView
    }
  } catch {
    /* localStorage unavailable */
  }
  return 'month'
}

function getTodayDate(): string {
  return toLocalDateString(new Date())
}

function getRangeForView(
  view: CalendarWorkspaceView,
  anchorDate: string
): {
  startAt: string
  endAt: string
} {
  if (view === 'day') {
    return {
      startAt: toStartOfLocalDayIso(anchorDate),
      endAt: toStartOfLocalDayIso(addLocalDays(anchorDate, 1))
    }
  }

  if (view === 'week') {
    const weekStart = getStartOfWeek(anchorDate)
    return {
      startAt: toStartOfLocalDayIso(addLocalDays(weekStart, -7)),
      endAt: toStartOfLocalDayIso(addLocalDays(weekStart, 14))
    }
  }

  if (view === 'month') {
    const gridDays = getMonthGridDays(anchorDate)
    return {
      startAt: toStartOfLocalDayIso(gridDays[0]),
      endAt: toStartOfLocalDayIso(addLocalDays(gridDays[gridDays.length - 1], 1))
    }
  }

  const date = parseLocalDate(anchorDate)
  const start = new Date(date.getFullYear(), 0, 1)
  const end = new Date(date.getFullYear() + 1, 0, 1)
  return { startAt: start.toISOString(), endAt: end.toISOString() }
}

function createDraftFromAnchor(anchorDate: string): CalendarEventDraft {
  return {
    title: '',
    description: '',
    location: '',
    isAllDay: false,
    startAt: `${anchorDate}T09:00`,
    endAt: `${anchorDate}T10:00`
  }
}

function createDraftFromItem(item: CalendarProjectionItem): CalendarEventDraft {
  return {
    title: item.title,
    description: item.descriptionPreview ?? '',
    location: '',
    isAllDay: item.isAllDay,
    startAt: item.isAllDay
      ? toLocalDateInputValue(item.startAt)
      : toLocalDateTimeInputValue(item.startAt),
    endAt: item.endAt
      ? item.isAllDay
        ? toLocalDateInputValue(item.endAt)
        : toLocalDateTimeInputValue(item.endAt)
      : ''
  }
}

function toCreatePayload(draft: CalendarEventDraft) {
  return {
    title: draft.title.trim(),
    description: draft.description.trim() || null,
    location: draft.location.trim() || null,
    startAt: localInputToIso(draft.startAt, draft.isAllDay),
    endAt: draft.endAt ? localInputToIso(draft.endAt, draft.isAllDay) : null,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    isAllDay: draft.isAllDay
  }
}

function filterItems(
  items: CalendarProjectionItem[],
  options: {
    showMemryItems: boolean
    showImportedCalendars: boolean
    selectedImportedSourceIds: string[]
  }
): CalendarProjectionItem[] {
  return items.filter((item) => {
    const isImported = item.source.provider !== null && !item.source.isMemryManaged

    if (isImported) {
      if (!options.showImportedCalendars) return false
      return item.source.calendarSourceId
        ? options.selectedImportedSourceIds.includes(item.source.calendarSourceId)
        : true
    }

    return options.showMemryItems
  })
}

export function CalendarPage({ className: _className }: CalendarPageProps): React.JSX.Element {
  const queryClient = useQueryClient()
  const [view, setViewRaw] = useState<CalendarWorkspaceView>(getPersistedView)
  const setView = (next: CalendarWorkspaceView) => {
    setViewRaw(next)
    try {
      localStorage.setItem(CALENDAR_VIEW_KEY, next)
    } catch {
      /* localStorage unavailable */
    }
  }
  const [anchorDate, setAnchorDate] = useState(getTodayDate)
  const [showMemryItems, setShowMemryItems] = useState(true)
  const [showImportedCalendars, setShowImportedCalendars] = useState(true)
  const [selectedImportedSourceIds, setSelectedImportedSourceIds] = useState<string[]>([])
  const importedSourcesInitializedRef = useRef(false)
  const [editorState, setEditorState] = useState<{
    mode: 'create' | 'edit'
    eventId: string | null
    draft: CalendarEventDraft
  } | null>(null)
  const [isSaving, setIsSaving] = useState(false)

  const { openForDayView, closeForDayView, setDate: setDayPanelDate } = useDayPanel()

  useEffect(() => {
    if (view === 'day') {
      openForDayView(anchorDate)
    } else {
      closeForDayView()
    }
    // anchorDate intentionally excluded: entering Day view seeds the date once; the
    // sync effect below keeps it in step while Day view is active.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, openForDayView, closeForDayView])

  useEffect(() => {
    if (view === 'day') {
      setDayPanelDate(anchorDate)
    }
  }, [view, anchorDate, setDayPanelDate])

  const rangeInput = useMemo(
    () => ({
      ...getRangeForView(view, anchorDate),
      includeUnselectedSources: true
    }),
    [view, anchorDate]
  )

  const rangeQuery = useCalendarRange(rangeInput)

  const sourcesQuery = useQuery({
    queryKey: ['calendar', 'sources'],
    queryFn: () => calendarService.listSources({})
  })

  const sources = sourcesQuery.data?.sources ?? []
  const importedSources = useMemo(
    () => sources.filter((source) => source.kind === 'calendar' && !source.isMemryManaged),
    [sources]
  )

  useEffect(() => {
    if (importedSourcesInitializedRef.current) {
      setSelectedImportedSourceIds((current) =>
        current.filter((sourceId) => importedSources.some((source) => source.id === sourceId))
      )
      return
    }

    if (importedSources.length === 0) return

    importedSourcesInitializedRef.current = true
    setSelectedImportedSourceIds(importedSources.map((source) => source.id))
  }, [importedSources])

  const filteredItems = useMemo(
    () =>
      filterItems(rangeQuery.items, {
        showMemryItems,
        showImportedCalendars,
        selectedImportedSourceIds
      }),
    [rangeQuery.items, selectedImportedSourceIds, showImportedCalendars, showMemryItems]
  )

  const handlePrevious = () => {
    setAnchorDate((current) => {
      if (view === 'day') return addLocalDays(current, -1)
      if (view === 'week') return addLocalDays(current, -7)
      if (view === 'month') return addLocalMonths(current, -1)
      return addLocalYears(current, -1)
    })
  }

  const handleNext = () => {
    setAnchorDate((current) => {
      if (view === 'day') return addLocalDays(current, 1)
      if (view === 'week') return addLocalDays(current, 7)
      if (view === 'month') return addLocalMonths(current, 1)
      return addLocalYears(current, 1)
    })
  }

  const handleSelectItem = (item: CalendarProjectionItem) => {
    if (item.sourceType !== 'event') return

    setEditorState({
      mode: 'edit',
      eventId: item.sourceId,
      draft: createDraftFromItem(item)
    })
  }

  const handleSaveEditor = async () => {
    if (!editorState) return

    setIsSaving(true)
    try {
      if (editorState.mode === 'create') {
        const result = await calendarService.createEvent(toCreatePayload(editorState.draft))
        if (!result.success) {
          throw new Error(result.error ?? 'Could not create event.')
        }
      } else if (editorState.eventId) {
        const result = await calendarService.updateEvent({
          id: editorState.eventId,
          ...toCreatePayload(editorState.draft)
        })
        if (!result.success) {
          throw new Error(result.error ?? 'Could not update event.')
        }
      }

      await queryClient.invalidateQueries({ queryKey: ['calendar', 'range'] })
      setEditorState(null)
    } finally {
      setIsSaving(false)
    }
  }

  const handleQuickSave = async (draft: CalendarEventDraft) => {
    const result = await calendarService.createEvent(toCreatePayload(draft))
    if (!result.success) {
      throw new Error(result.error ?? 'Could not create event.')
    }
    await queryClient.invalidateQueries({ queryKey: ['calendar', 'range'] })
  }

  const handleCreateEventWithRange = (startAt: string, endAt: string, isAllDay: boolean) => {
    setEditorState({
      mode: 'create',
      eventId: null,
      draft: { title: '', description: '', location: '', isAllDay, startAt, endAt }
    })
  }

  return (
    <CalendarShell
      view={view}
      anchorDate={anchorDate}
      items={filteredItems}
      importedSources={importedSources as CalendarSourceRecord[]}
      isLoading={rangeQuery.isLoading || sourcesQuery.isLoading}
      showMemryItems={showMemryItems}
      showImportedCalendars={showImportedCalendars}
      selectedImportedSourceIds={selectedImportedSourceIds}
      editorState={
        editorState
          ? {
              mode: editorState.mode,
              draft: editorState.draft
            }
          : null
      }
      isSaving={isSaving}
      onViewChange={setView}
      onPrevious={handlePrevious}
      onNext={handleNext}
      onToday={() => setAnchorDate(getTodayDate())}
      onCreateEvent={() =>
        setEditorState({
          mode: 'create',
          eventId: null,
          draft: createDraftFromAnchor(anchorDate)
        })
      }
      onToggleMemryItems={() => setShowMemryItems((current) => !current)}
      onToggleImportedCalendars={() => setShowImportedCalendars((current) => !current)}
      onToggleImportedSource={(sourceId) =>
        setSelectedImportedSourceIds((current) =>
          current.includes(sourceId)
            ? current.filter((id) => id !== sourceId)
            : [...current, sourceId]
        )
      }
      onSelectItem={handleSelectItem}
      onEditorClose={() => setEditorState(null)}
      onEditorDraftChange={(draft) =>
        setEditorState((current) => (current ? { ...current, draft } : current))
      }
      onAnchorChange={(date) => setAnchorDate(date)}
      onWeekVisibleRangeChange={(startDate) => setAnchorDate(startDate)}
      onEditorSave={() => void handleSaveEditor()}
      onQuickSave={handleQuickSave}
      onCreateEventWithRange={handleCreateEventWithRange}
    />
  )
}

export default CalendarPage
