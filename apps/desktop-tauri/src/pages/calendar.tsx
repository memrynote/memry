import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CalendarShell,
  type AnchorRect,
  type CalendarEventDraft,
  type CalendarWorkspaceView
} from '@/components/calendar'
import { VISUAL_TYPE_ORDER } from '@/components/calendar/visual-type-meta'
import { PromoteExternalDialog } from '@/components/calendar/promote-external-dialog'
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
import { useDeleteCalendarEvent } from '@/hooks/use-calendar-mutations'
import {
  calendarService,
  promoteExternalCalendarEvent,
  type CalendarProjectionItem,
  type CalendarProjectionVisualType,
  type CalendarSourceRecord
} from '@/services/calendar-service'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import { useDayPanel } from '@/contexts/day-panel-context'
import { useCalendarView } from '@/contexts/calendar-view-context'
import { DeleteCalendarEventDialog } from '@/components/calendar/delete-calendar-event-dialog'

const log = createLogger('CalendarPage')

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
    endAt: `${anchorDate}T10:00`,
    targetCalendarId: null
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
      : '',
    targetCalendarId: item.binding?.remoteCalendarId ?? null
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
    isAllDay: draft.isAllDay,
    targetCalendarId: draft.targetCalendarId
  }
}

function filterItems(
  items: CalendarProjectionItem[],
  options: {
    showMemryItems: boolean
    showImportedCalendars: boolean
    selectedImportedSourceIds: string[]
    selectedVisualTypes: CalendarProjectionVisualType[]
  }
): CalendarProjectionItem[] {
  return items.filter((item) => {
    if (!options.selectedVisualTypes.includes(item.visualType)) return false

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
  const { anchorDate, setAnchorDate } = useCalendarView()
  const [showMemryItems, setShowMemryItems] = useState(true)
  const [showImportedCalendars, setShowImportedCalendars] = useState(true)
  const [selectedImportedSourceIds, setSelectedImportedSourceIds] = useState<string[]>([])
  const [selectedVisualTypes, setSelectedVisualTypes] =
    useState<CalendarProjectionVisualType[]>(VISUAL_TYPE_ORDER)
  const importedSourcesInitializedRef = useRef(false)
  const [popoverState, setPopoverState] = useState<{
    mode: 'create' | 'edit'
    eventId: string | null
    draft: CalendarEventDraft
    anchorRect: AnchorRect
    readOnlyMetadata?: import('@/components/calendar/calendar-event-popover').CalendarEventReadOnlyMetadata
  } | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [pendingPromote, setPendingPromote] = useState<{
    item: CalendarProjectionItem
    anchorRect: AnchorRect
  } | null>(null)
  const [isPromoting, setIsPromoting] = useState(false)
  const [promoteError, setPromoteError] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<CalendarProjectionItem | null>(null)
  const deleteMutation = useDeleteCalendarEvent()

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
        selectedImportedSourceIds,
        selectedVisualTypes
      }),
    [
      rangeQuery.items,
      selectedImportedSourceIds,
      selectedVisualTypes,
      showImportedCalendars,
      showMemryItems
    ]
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

  async function openEditPopoverAfterPromote(
    eventId: string,
    source: CalendarProjectionItem,
    rect: AnchorRect
  ): Promise<void> {
    const record = await calendarService.getEvent(eventId)
    const draft = record
      ? ({
          title: record.title,
          description: record.description ?? '',
          location: record.location ?? '',
          isAllDay: record.isAllDay,
          startAt: record.isAllDay
            ? toLocalDateInputValue(record.startAt)
            : toLocalDateTimeInputValue(record.startAt),
          endAt: record.endAt
            ? record.isAllDay
              ? toLocalDateInputValue(record.endAt)
              : toLocalDateTimeInputValue(record.endAt)
            : '',
          targetCalendarId: record.targetCalendarId
        } satisfies CalendarEventDraft)
      : createDraftFromItem(source)

    setPopoverState({
      mode: 'edit',
      eventId,
      draft,
      anchorRect: rect,
      readOnlyMetadata: record
        ? {
            attendees: record.attendees,
            reminders: record.reminders,
            visibility: record.visibility,
            conferenceData: record.conferenceData
          }
        : undefined
    })
  }

  async function runPromote(
    item: CalendarProjectionItem,
    rect: AnchorRect,
    options: { dontAskAgain: boolean }
  ): Promise<void> {
    setIsPromoting(true)
    setPromoteError(null)
    try {
      const result = await promoteExternalCalendarEvent({ externalEventId: item.sourceId })
      if (!result.success || !result.eventId) {
        throw new Error(result.error ?? 'Could not edit this event.')
      }
      if (options.dontAskAgain) {
        await window.api.settings.setCalendarGoogleSettings({ promoteConfirmDismissed: true })
      }
      await queryClient.invalidateQueries({ queryKey: ['calendar', 'range'] })
      await openEditPopoverAfterPromote(result.eventId, item, rect)
      setPendingPromote(null)
    } catch (err) {
      setPromoteError(extractErrorMessage(err, 'Could not edit this event. Try again.'))
    } finally {
      setIsPromoting(false)
    }
  }

  const handleSelectItem = async (item: CalendarProjectionItem, rect: AnchorRect) => {
    if (item.sourceType === 'event') {
      const record = await calendarService.getEvent(item.sourceId).catch(() => null)
      setPopoverState({
        mode: 'edit',
        eventId: item.sourceId,
        draft: createDraftFromItem(item),
        anchorRect: rect,
        readOnlyMetadata: record
          ? {
              attendees: record.attendees,
              reminders: record.reminders,
              visibility: record.visibility,
              conferenceData: record.conferenceData
            }
          : undefined
      })
      return
    }

    if (item.sourceType !== 'external_event') return

    const settings = await window.api.settings.getCalendarGoogleSettings()
    if (settings.promoteConfirmDismissed) {
      await runPromote(item, rect, { dontAskAgain: false })
      return
    }

    setPendingPromote({ item, anchorRect: rect })
  }

  const handlePopoverSave = async () => {
    if (!popoverState) return

    setIsSaving(true)
    try {
      if (popoverState.mode === 'create') {
        const result = await calendarService.createEvent(toCreatePayload(popoverState.draft))
        if (!result.success) {
          throw new Error(result.error ?? 'Could not create event.')
        }
      } else if (popoverState.eventId) {
        const result = await calendarService.updateEvent({
          id: popoverState.eventId,
          ...toCreatePayload(popoverState.draft)
        })
        if (!result.success) {
          throw new Error(result.error ?? 'Could not update event.')
        }
      }

      await queryClient.invalidateQueries({ queryKey: ['calendar', 'range'] })
      setPopoverState(null)
    } finally {
      setIsSaving(false)
    }
  }

  const handleDeleteItem = (item: CalendarProjectionItem) => {
    setPendingDelete(item)
  }

  const handleConfirmDelete = async () => {
    if (!pendingDelete) return
    const target = pendingDelete
    try {
      const result = await deleteMutation.mutateAsync(target.sourceId)
      if (!result.success) {
        throw new Error(result.error ?? 'Could not delete event.')
      }
      if (popoverState?.eventId === target.sourceId) {
        setPopoverState(null)
      }
      setPendingDelete(null)
    } catch (err) {
      log.error('Failed to delete calendar event', {
        eventId: target.sourceId,
        error: extractErrorMessage(err, 'Failed to delete event')
      })
      setPendingDelete(null)
    }
  }

  const handleQuickSave = async (draft: CalendarEventDraft) => {
    const result = await calendarService.createEvent(toCreatePayload(draft))
    if (!result.success) {
      throw new Error(result.error ?? 'Could not create event.')
    }
    await queryClient.invalidateQueries({ queryKey: ['calendar', 'range'] })
  }

  const handleCreateEventWithRange = (
    startAt: string,
    endAt: string,
    isAllDay: boolean,
    anchorRect: AnchorRect
  ) => {
    setPopoverState({
      mode: 'create',
      eventId: null,
      draft: {
        title: '',
        description: '',
        location: '',
        isAllDay,
        startAt,
        endAt,
        targetCalendarId: null
      },
      anchorRect
    })
  }

  const selectedItemId = popoverState?.eventId ?? null

  return (
    <>
      <PromoteExternalDialog
        open={pendingPromote !== null}
        isWorking={isPromoting}
        errorMessage={promoteError}
        onOpenChange={(open) => {
          if (!open) {
            setPendingPromote(null)
            setPromoteError(null)
          }
        }}
        onConfirm={(dontAskAgain) => {
          if (pendingPromote) {
            void runPromote(pendingPromote.item, pendingPromote.anchorRect, { dontAskAgain })
          }
        }}
      />
      <CalendarShell
        view={view}
        anchorDate={anchorDate}
        items={filteredItems}
        importedSources={importedSources as CalendarSourceRecord[]}
        isLoading={rangeQuery.isLoading || sourcesQuery.isLoading}
        showMemryItems={showMemryItems}
        showImportedCalendars={showImportedCalendars}
        selectedImportedSourceIds={selectedImportedSourceIds}
        selectedVisualTypes={selectedVisualTypes}
        selectedItemId={selectedItemId}
        popoverState={
          popoverState
            ? {
                mode: popoverState.mode,
                draft: popoverState.draft,
                anchorRect: popoverState.anchorRect,
                readOnlyMetadata: popoverState.readOnlyMetadata
              }
            : null
        }
        isSaving={isSaving}
        onViewChange={setView}
        onPrevious={handlePrevious}
        onNext={handleNext}
        onToday={() => setAnchorDate(getTodayDate())}
        onCreateEvent={(anchorRect) =>
          setPopoverState({
            mode: 'create',
            eventId: null,
            draft: createDraftFromAnchor(anchorDate),
            anchorRect
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
        onToggleVisualType={(visualType) =>
          setSelectedVisualTypes((current) =>
            current.includes(visualType)
              ? current.filter((type) => type !== visualType)
              : [...current, visualType]
          )
        }
        onSelectItem={handleSelectItem}
        onDeleteItem={handleDeleteItem}
        onPopoverDismiss={() => setPopoverState(null)}
        onPopoverDraftChange={(draft) =>
          setPopoverState((current) => (current ? { ...current, draft } : current))
        }
        onAnchorChange={(date) => setAnchorDate(date)}
        onWeekVisibleRangeChange={(startDate) => setAnchorDate(startDate)}
        onPopoverSave={() => void handlePopoverSave()}
        onQuickSave={handleQuickSave}
        onCreateEventWithRange={handleCreateEventWithRange}
      />
      <DeleteCalendarEventDialog
        open={pendingDelete !== null}
        title={pendingDelete?.title ?? ''}
        hasGoogleBinding={pendingDelete?.binding !== null && pendingDelete?.binding !== undefined}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => void handleConfirmDelete()}
      />
    </>
  )
}

export default CalendarPage
