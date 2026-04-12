import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarShell, type CalendarEventDraft, type CalendarWorkspaceView } from '@/components/calendar'
import { useCalendarRange } from '@/hooks/use-calendar-range'
import {
  calendarService,
  type CalendarProjectionItem,
  type CalendarSourceRecord
} from '@/services/calendar-service'

interface CalendarPageProps {
  className?: string
}

function getTodayDate(): string {
  return new Date().toISOString().slice(0, 10)
}

function parseUtcDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`)
}

function toIsoDate(value: Date): string {
  return value.toISOString().slice(0, 10)
}

function addDays(value: string, amount: number): string {
  const date = parseUtcDate(value)
  date.setUTCDate(date.getUTCDate() + amount)
  return toIsoDate(date)
}

function addMonths(value: string, amount: number): string {
  const date = parseUtcDate(value)
  date.setUTCMonth(date.getUTCMonth() + amount)
  return toIsoDate(date)
}

function addYears(value: string, amount: number): string {
  const date = parseUtcDate(value)
  date.setUTCFullYear(date.getUTCFullYear() + amount)
  return toIsoDate(date)
}

function toIsoStartOfDay(value: string): string {
  return parseUtcDate(value).toISOString()
}

function getRangeForView(view: CalendarWorkspaceView, anchorDate: string): {
  startAt: string
  endAt: string
} {
  if (view === 'day') {
    return {
      startAt: toIsoStartOfDay(anchorDate),
      endAt: toIsoStartOfDay(addDays(anchorDate, 1))
    }
  }

  if (view === 'week') {
    return {
      startAt: toIsoStartOfDay(anchorDate),
      endAt: toIsoStartOfDay(addDays(anchorDate, 7))
    }
  }

  if (view === 'month') {
    const date = parseUtcDate(anchorDate)
    const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1))
    const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1))
    return { startAt: start.toISOString(), endAt: end.toISOString() }
  }

  const date = parseUtcDate(anchorDate)
  const start = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  const end = new Date(Date.UTC(date.getUTCFullYear() + 1, 0, 1))
  return { startAt: start.toISOString(), endAt: end.toISOString() }
}

function getRangeLabel(view: CalendarWorkspaceView, anchorDate: string): string {
  const date = parseUtcDate(anchorDate)

  if (view === 'day') {
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric'
    }).format(date)
  }

  if (view === 'week') {
    const end = parseUtcDate(addDays(anchorDate, 6))
    const formatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
    return `${formatter.format(date)} - ${formatter.format(end)}`
  }

  if (view === 'month') {
    return new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(date)
  }

  return String(date.getUTCFullYear())
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
      ? new Date(item.startAt).toISOString().slice(0, 10)
      : new Date(item.startAt).toISOString().slice(0, 16),
    endAt: item.endAt
      ? item.isAllDay
        ? new Date(item.endAt).toISOString().slice(0, 10)
        : new Date(item.endAt).toISOString().slice(0, 16)
      : ''
  }
}

function toCreatePayload(draft: CalendarEventDraft) {
  if (draft.isAllDay) {
    return {
      title: draft.title.trim(),
      description: draft.description.trim() || null,
      location: draft.location.trim() || null,
      startAt: new Date(`${draft.startAt}T00:00:00`).toISOString(),
      endAt: draft.endAt ? new Date(`${draft.endAt}T00:00:00`).toISOString() : null,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      isAllDay: true
    }
  }

  return {
    title: draft.title.trim(),
    description: draft.description.trim() || null,
    location: draft.location.trim() || null,
    startAt: new Date(draft.startAt).toISOString(),
    endAt: draft.endAt ? new Date(draft.endAt).toISOString() : null,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    isAllDay: false
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
  const [view, setView] = useState<CalendarWorkspaceView>('month')
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
      if (view === 'day') return addDays(current, -1)
      if (view === 'week') return addDays(current, -7)
      if (view === 'month') return addMonths(current, -1)
      return addYears(current, -1)
    })
  }

  const handleNext = () => {
    setAnchorDate((current) => {
      if (view === 'day') return addDays(current, 1)
      if (view === 'week') return addDays(current, 7)
      if (view === 'month') return addMonths(current, 1)
      return addYears(current, 1)
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
        await calendarService.createEvent(toCreatePayload(editorState.draft))
      } else if (editorState.eventId) {
        await calendarService.updateEvent({
          id: editorState.eventId,
          ...toCreatePayload(editorState.draft)
        })
      }

      await queryClient.invalidateQueries({ queryKey: ['calendar', 'range'] })
      setEditorState(null)
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <CalendarShell
      view={view}
      rangeLabel={getRangeLabel(view, anchorDate)}
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
      onEditorSave={() => void handleSaveEditor()}
    />
  )
}

export default CalendarPage
