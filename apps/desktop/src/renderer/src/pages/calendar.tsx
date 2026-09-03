import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  CalendarShell,
  type AnchorRect,
  type CalendarEventDraft,
  type CalendarWorkspaceView
} from '@/components/calendar'
import { VISUAL_TYPE_ORDER } from '@/components/calendar/visual-type-meta'
import { AgentAccessConsentDialog } from '@/components/calendar/agent-access-consent-dialog'
import { PromoteExternalDialog } from '@/components/calendar/promote-external-dialog'
import { CalendarTaskPopover } from '@/components/calendar/calendar-task-popover'
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
import { useWeekStartsOn } from '@/hooks/use-calendar-preferences'
import { useDeleteCalendarEvent } from '@/hooks/use-calendar-mutations'
import { useUndoTracker } from '@/hooks/use-undo'
import {
  calendarService,
  promoteExternalCalendarEvent,
  updateGoogleCalendarSourceSelection,
  type CalendarProjectionItem,
  type CalendarProjectionVisualType
} from '@/services/calendar-service'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import { formatDateKey } from '@/lib/task-utils'
import { tasksService } from '@/services/tasks-service'
import { useDayPanel } from '@/contexts/day-panel-context'
import { useCalendarView } from '@/contexts/calendar-view-context'
import { useActiveTab, useTabActions } from '@/contexts/tabs'
import { useTabIdentity } from '@/contexts/tabs/tab-identity'
import { useTabViewState } from '@/hooks/use-tab-view-state'
import {
  CALENDAR_VIEW_STATE_KEYS,
  parseAnchorDate,
  parseCalendarBoolean,
  parseCalendarView,
  parseImportedSourceIds,
  parseVisualTypes,
  readGlobalCalendarView,
  resolveAnchorSync,
  resolveSelectedSourceIds,
  resolveSourceToggle,
  writeGlobalCalendarView
} from './calendar-view-state'
import { DeleteCalendarEventDialog } from '@/components/calendar/delete-calendar-event-dialog'
import { GoogleCalendarConnectPrompt } from '@/components/calendar/google-calendar-connect-prompt'
import { AddEventToProjectDialog } from '@/components/tasks/projects/add-event-to-project-dialog'
import { inboxService } from '@/services/inbox-service'
import { getI18n } from 'react-i18next'

const log = createLogger('CalendarPage')

interface CalendarPageProps {
  className?: string
}

function getTodayDate(): string {
  return toLocalDateString(new Date())
}

function getRangeForView(
  view: CalendarWorkspaceView,
  anchorDate: string,
  weekStartsOn: 0 | 1
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
    const weekStart = getStartOfWeek(anchorDate, weekStartsOn)
    return {
      startAt: toStartOfLocalDayIso(addLocalDays(weekStart, -7)),
      endAt: toStartOfLocalDayIso(addLocalDays(weekStart, 14))
    }
  }

  if (view === 'month') {
    const gridDays = getMonthGridDays(anchorDate, weekStartsOn)
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
    isAllDay: false,
    startAt: `${anchorDate}T09:00`,
    endAt: `${anchorDate}T10:00`,
    targetCalendarId: null,
    projectId: null
  }
}

function createDraftFromItem(item: CalendarProjectionItem): CalendarEventDraft {
  return {
    title: item.title,
    description: item.descriptionPreview ?? '',
    isAllDay: item.isAllDay,
    startAt: item.isAllDay
      ? toLocalDateInputValue(item.startAt)
      : toLocalDateTimeInputValue(item.startAt),
    endAt: item.endAt
      ? item.isAllDay
        ? toLocalDateInputValue(item.endAt)
        : toLocalDateTimeInputValue(item.endAt)
      : '',
    targetCalendarId: item.binding?.remoteCalendarId ?? null,
    projectId: null
  }
}

function toCreatePayload(draft: CalendarEventDraft) {
  return {
    title: draft.title.trim(),
    description: draft.description.trim() || null,
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

function dueDateTimeFromDate(date: Date): { dueDate: string; dueTime: string } {
  return {
    dueDate: formatDateKey(date),
    dueTime: `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  }
}

export function CalendarPage({ className: _className }: CalendarPageProps): React.JSX.Element {
  const queryClient = useQueryClient()
  // A NEW calendar tab opens on the view last used anywhere (the pre-existing
  // global key), then keeps its own from that point on.
  const [globalViewFallback] = useState(readGlobalCalendarView)
  const [view, setViewState] = useTabViewState<CalendarWorkspaceView>({
    key: CALENDAR_VIEW_STATE_KEYS.view,
    defaultValue: globalViewFallback,
    parse: parseCalendarView
  })
  const setView = useCallback(
    (next: CalendarWorkspaceView) => {
      setViewState(next)
      // Still written: it is what an older build reads, and what the next new
      // tab opens on.
      writeGlobalCalendarView(next)
    },
    [setViewState]
  )
  const { anchorDate, setAnchorDate } = useCalendarView()
  const [storedAnchor, setStoredAnchor] = useTabViewState<string | null>({
    key: CALENDAR_VIEW_STATE_KEYS.anchorDate,
    defaultValue: null,
    parse: parseAnchorDate
  })
  const weekStartsOn = useWeekStartsOn()
  const [todayRequestKey, setTodayRequestKey] = useState(0)
  const [showMemryItems, setShowMemryItems] = useTabViewState<boolean>({
    key: CALENDAR_VIEW_STATE_KEYS.showMemryItems,
    defaultValue: true,
    parse: parseCalendarBoolean
  })
  const [showImportedCalendars, setShowImportedCalendars] = useTabViewState<boolean>({
    key: CALENDAR_VIEW_STATE_KEYS.showImportedCalendars,
    defaultValue: true,
    parse: parseCalendarBoolean
  })
  // `null` is "the user has not picked a subset". The effective selection is
  // derived from the sources query below, so there is no seeding effect to
  // fight and no pre-selection of a source connected after they chose.
  const [chosenImportedSourceIds, setChosenImportedSourceIds] = useTabViewState<string[] | null>({
    key: CALENDAR_VIEW_STATE_KEYS.importedSourceIds,
    defaultValue: null,
    parse: parseImportedSourceIds
  })
  const [selectedVisualTypes, setSelectedVisualTypes] = useTabViewState<
    CalendarProjectionVisualType[]
  >({
    key: CALENDAR_VIEW_STATE_KEYS.visualTypes,
    defaultValue: VISUAL_TYPE_ORDER,
    parse: parseVisualTypes
  })
  const [popoverState, setPopoverState] = useState<{
    mode: 'create' | 'edit'
    eventId: string | null
    draft: CalendarEventDraft
    anchorRect: AnchorRect
    readOnlyMetadata?: import('@/components/calendar/calendar-event-popover').CalendarEventReadOnlyMetadata
  } | null>(null)
  const [inboxSnoozePopoverState, setInboxSnoozePopoverState] = useState<{
    item: CalendarProjectionItem
    anchorRect: AnchorRect
  } | null>(null)
  const [taskPopoverState, setTaskPopoverState] = useState<{
    item: CalendarProjectionItem
    anchorRect: AnchorRect
  } | null>(null)
  const [notePopoverState, setNotePopoverState] = useState<{
    item: CalendarProjectionItem
    anchorRect: AnchorRect
  } | null>(null)
  const { openTab } = useTabActions()
  const activeTab = useActiveTab()
  const calendarFocusEventId =
    typeof activeTab?.viewState?.focusCalendarEventId === 'string'
      ? activeTab.viewState.focusCalendarEventId
      : null
  const calendarFocusDate =
    typeof activeTab?.viewState?.focusDate === 'string' ? activeTab.viewState.focusDate : null
  const calendarFocusToken =
    typeof activeTab?.viewState?.focusedAt === 'number' ? activeTab.viewState.focusedAt : null
  const calendarCreateEventToken =
    typeof activeTab?.viewState?.createEventAt === 'number'
      ? activeTab.viewState.createEventAt
      : null
  const consumedCalendarNavigationRef = useRef<number | null>(null)
  const openedCalendarFocusRef = useRef<number | null>(null)
  const consumedCreateEventRef = useRef<number | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [pendingPromote, setPendingPromote] = useState<{
    item: CalendarProjectionItem
    anchorRect: AnchorRect
    agentAccessOff: boolean
  } | null>(null)
  const [isPromoting, setIsPromoting] = useState(false)
  const [promoteError, setPromoteError] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<CalendarProjectionItem | null>(null)
  const [addToProjectEventId, setAddToProjectEventId] = useState<string | null>(null)
  const deleteMutation = useDeleteCalendarEvent()
  const { registerUndo } = useUndoTracker()

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
    if (view !== 'day') return () => {}
    setDayPanelDate(anchorDate)
    return () => {}
  }, [view, anchorDate, setDayPanelDate])

  // ---------------------------------------------------------------------------
  // Anchor date: LIVE in the shared context, DURABLE in the tab.
  //
  // The context stays the single live value because the day panel — which is
  // not in a tab — writes it, and Day view reads it back. The tab is where that
  // value survives a restart, so this page seeds the context from the tab once
  // and mirrors every later change back. `resolveAnchorSync` owns the ordering:
  // both effects run in the same commit, so without it the mirror would see the
  // context still holding today and write today over the anchor being restored.
  // ---------------------------------------------------------------------------
  const identity = useTabIdentity()
  const identityKey = identity ? `${identity.groupId}:${identity.tabId}` : ''
  const seededForRef = useRef<string | null>(null)
  const awaitingSeedRef = useRef<string | null>(null)
  const storedAnchorRef = useRef(storedAnchor)
  const anchorDateRef = useRef(anchorDate)
  useLayoutEffect(() => {
    storedAnchorRef.current = storedAnchor
    anchorDateRef.current = anchorDate
  })

  useEffect(() => {
    if (seededForRef.current === identityKey) return
    seededForRef.current = identityKey
    const stored = storedAnchorRef.current
    if (stored === null || stored === anchorDateRef.current) return
    awaitingSeedRef.current = stored
    setAnchorDate(stored)
  }, [identityKey, setAnchorDate])

  useEffect(() => {
    const decision = resolveAnchorSync({
      awaitingSeed: awaitingSeedRef.current,
      anchorDate,
      storedAnchor
    })
    if (decision.clearAwaiting) awaitingSeedRef.current = null
    if (decision.write !== null) setStoredAnchor(decision.write)
  }, [anchorDate, storedAnchor, setStoredAnchor])

  const rangeInput = useMemo(
    () => ({
      ...getRangeForView(view, anchorDate, weekStartsOn),
      includeUnselectedSources: true
    }),
    [view, anchorDate, weekStartsOn]
  )

  const rangeQuery = useCalendarRange(rangeInput)

  const { data: sourcesData, isLoading: sourcesIsLoading } = useQuery({
    queryKey: ['calendar', 'sources'],
    queryFn: () => calendarService.listSources({})
  })

  const importedSources = useMemo(
    () =>
      (sourcesData?.sources ?? []).filter(
        (source) => source.kind === 'calendar' && !source.isMemryManaged
      ),
    [sourcesData?.sources]
  )

  const selectedImportedSourceIds = useMemo(
    () => resolveSelectedSourceIds(chosenImportedSourceIds, importedSources),
    [chosenImportedSourceIds, importedSources]
  )

  // Ticking a calendar the sweep never polls has to subscribe it. Filtering a
  // set of events that were never fetched is what made this checkbox look dead.
  const enableSourceMutation = useMutation({
    mutationFn: (sourceId: string) =>
      updateGoogleCalendarSourceSelection({ id: sourceId, isSelected: true }),
    onSuccess: async (result) => {
      const tCalendar = getI18n().getFixedT(null, 'calendar')
      if (!result.success) {
        toast.error(result.error ?? tCalendar('filter.enable-source-failed'))
        return
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['calendar', 'sources'] }),
        queryClient.invalidateQueries({ queryKey: ['calendar', 'range'] })
      ])
    },
    onError: (err) => {
      log.error('Failed to enable calendar source', err)
      const tCalendar = getI18n().getFixedT(null, 'calendar')
      toast.error(extractErrorMessage(err, tCalendar('filter.enable-source-failed')))
    }
  })

  // Toggling records an EXPLICIT selection: the first toggle turns the derived
  // "every synced source" into a real list minus the one just switched off.
  const handleToggleImportedSource = useCallback(
    (sourceId: string) => {
      const { nextSelectedIds, subscribeSourceId } = resolveSourceToggle(
        sourceId,
        selectedImportedSourceIds,
        importedSources
      )
      if (subscribeSourceId) enableSourceMutation.mutate(subscribeSourceId)
      setChosenImportedSourceIds(nextSelectedIds)
    },
    [selectedImportedSourceIds, setChosenImportedSourceIds, importedSources, enableSourceMutation]
  )

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

  // Agent Chat links arrive as tab view state; bridge that external navigation signal
  // into Calendar's local view and popover state.
  /* eslint-disable react-you-might-not-need-an-effect/no-derived-state, react-you-might-not-need-an-effect/no-event-handler, react-you-might-not-need-an-effect/no-chain-state-updates */
  useEffect(() => {
    if (!calendarFocusEventId || !calendarFocusDate || calendarFocusToken === null) return
    if (consumedCalendarNavigationRef.current === calendarFocusToken) return

    consumedCalendarNavigationRef.current = calendarFocusToken
    setView('day')
    setAnchorDate(calendarFocusDate)
    setShowMemryItems(true)
  }, [
    calendarFocusDate,
    calendarFocusEventId,
    calendarFocusToken,
    setAnchorDate,
    setShowMemryItems,
    setView
  ])

  useEffect(() => {
    if (!calendarFocusEventId || calendarFocusToken === null) return
    if (openedCalendarFocusRef.current === calendarFocusToken || rangeQuery.isLoading) return

    const item = filteredItems.find(
      (candidate) => candidate.sourceType === 'event' && candidate.sourceId === calendarFocusEventId
    )
    if (!item) return

    openedCalendarFocusRef.current = calendarFocusToken
    setTaskPopoverState(null)
    setInboxSnoozePopoverState(null)
    setPopoverState({
      mode: 'edit',
      eventId: item.sourceId,
      draft: createDraftFromItem(item),
      anchorRect: {
        x: window.innerWidth / 2,
        y: Math.max(120, window.innerHeight / 3),
        width: 1,
        height: 1
      }
    })
  }, [calendarFocusEventId, calendarFocusToken, filteredItems, rangeQuery.isLoading])
  /* eslint-enable react-you-might-not-need-an-effect/no-derived-state, react-you-might-not-need-an-effect/no-event-handler, react-you-might-not-need-an-effect/no-chain-state-updates */

  // Sidebar "Calendar" click asks for the new-event popover (same as the toolbar +).
  // The nonce re-fires this on every click, even when the tab is already open.
  useEffect(() => {
    if (calendarCreateEventToken === null) return
    if (consumedCreateEventRef.current === calendarCreateEventToken) return

    consumedCreateEventRef.current = calendarCreateEventToken
    setPopoverState({
      mode: 'create',
      eventId: null,
      draft: createDraftFromAnchor(anchorDate),
      anchorRect: {
        x: window.innerWidth / 2,
        y: Math.max(120, window.innerHeight / 3),
        width: 1,
        height: 1
      }
    })
  }, [anchorDate, calendarCreateEventToken])

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

  const handleToday = () => {
    setAnchorDate(getTodayDate())
    setTodayRequestKey((current) => current + 1)
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
          isAllDay: record.isAllDay,
          startAt: record.isAllDay
            ? toLocalDateInputValue(record.startAt)
            : toLocalDateTimeInputValue(record.startAt),
          endAt: record.endAt
            ? record.isAllDay
              ? toLocalDateInputValue(record.endAt)
              : toLocalDateTimeInputValue(record.endAt)
            : '',
          targetCalendarId: record.targetCalendarId,
          projectId: null
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
    target: { item: CalendarProjectionItem; anchorRect: AnchorRect },
    options: { dontAskAgain: boolean }
  ): Promise<void> {
    setIsPromoting(true)
    setPromoteError(null)
    try {
      const result = await promoteExternalCalendarEvent({ externalEventId: target.item.sourceId })
      if (!result.success || !result.eventId) {
        throw new Error(result.error ?? 'Could not edit this event.')
      }
      if (options.dontAskAgain) {
        await window.api.settings.setCalendarGoogleSettings({ promoteConfirmDismissed: true })
      }
      await queryClient.invalidateQueries({ queryKey: ['calendar', 'range'] })
      await openEditPopoverAfterPromote(result.eventId, target.item, target.anchorRect)
      setPendingPromote(null)
    } catch (err) {
      setPromoteError(
        extractErrorMessage(
          err,
          getI18n().getFixedT(null, 'calendar')('phaseI.errors.couldNotEditThisEventTryAgain')
        )
      )
    } finally {
      setIsPromoting(false)
    }
  }

  const handleSelectItem = async (item: CalendarProjectionItem, rect: AnchorRect) => {
    if (item.sourceType === 'task') {
      setPopoverState(null)
      setInboxSnoozePopoverState(null)
      setNotePopoverState(null)
      setTaskPopoverState({ item, anchorRect: rect })
      return
    }

    if (item.sourceType === 'event') {
      setTaskPopoverState(null)
      setInboxSnoozePopoverState(null)
      setNotePopoverState(null)
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

    if (item.sourceType === 'inbox_snooze') {
      setPopoverState(null)
      setTaskPopoverState(null)
      setNotePopoverState(null)
      setInboxSnoozePopoverState({ item, anchorRect: rect })
      return
    }

    if (item.sourceType === 'note' || item.sourceType === 'note_date') {
      setPopoverState(null)
      setTaskPopoverState(null)
      setInboxSnoozePopoverState(null)
      setNotePopoverState({ item, anchorRect: rect })
      return
    }

    if (item.sourceType !== 'external_event') return

    setNotePopoverState(null)
    const settings = await window.api.settings.getCalendarGoogleSettings()
    // Promotion copies the event into native storage, where the agent can read it
    // regardless of the Google-events consent gate. While that consent is anything but
    // a stored `true`, confirm every time — "don't ask again" must not silently widen
    // what the agent can see.
    const agentAccessOff = settings.agentReadEventsConsent !== true
    if (settings.promoteConfirmDismissed && !agentAccessOff) {
      await runPromote({ item, anchorRect: rect }, { dontAskAgain: false })
      return
    }

    setPendingPromote({ item, anchorRect: rect, agentAccessOff })
  }

  // Search jump: focus the item's day, then open its popover. The item is already
  // in hand from search, so selection happens immediately without waiting for the
  // range refetch (mirrors the Agent-Chat calendar focus flow).
  const handleSearchJump = (item: CalendarProjectionItem) => {
    setView('day')
    setAnchorDate(toLocalDateString(new Date(item.startAt)))
    void handleSelectItem(item, {
      x: window.innerWidth / 2,
      y: Math.max(120, window.innerHeight / 3),
      width: 1,
      height: 1
    })
  }

  const handleNoteOpen = (noteId: string, anchorId?: string | null) => {
    const tCalendar = getI18n().getFixedT(null, 'calendar')
    setNotePopoverState(null)
    void window.api.notes
      .get(noteId)
      .then((note) => {
        if (!note) return
        openTab({
          type: 'note',
          title: note.title ?? note.path,
          icon: 'FileText',
          path: note.path,
          entityId: note.id,
          isPinned: false,
          isModified: false,
          isPreview: false,
          isDeleted: false,
          ...(anchorId ? { viewState: { anchorId } } : {})
        })
      })
      .catch((err: unknown) => {
        log.error('Failed to open note from calendar', {
          noteId,
          error: extractErrorMessage(err, tCalendar('notePopover.couldNotOpen'))
        })
      })
  }

  const handleInboxSnoozeOpenInInbox = (itemId: string) => {
    setInboxSnoozePopoverState(null)
    openTab({
      type: 'inbox',
      title: 'Inbox',
      icon: 'inbox',
      path: '/inbox',
      isPinned: false,
      isModified: false,
      isPreview: false,
      isDeleted: false,
      viewState: { focusInboxItemId: itemId, focusedAt: Date.now() }
    })
  }

  const handleInboxSnoozeUnsnooze = async (itemId: string) => {
    const tCalendar = getI18n().getFixedT(null, 'calendar')
    try {
      const result = await inboxService.unsnooze(itemId)
      if (!result.success) {
        throw new Error(result.error ?? tCalendar('phaseI.errors.couldNotUnsnoozeInboxItem'))
      }
      await queryClient.invalidateQueries({ queryKey: ['calendar', 'range'] })
      setInboxSnoozePopoverState(null)
    } catch (err) {
      log.error('Failed to unsnooze inbox item', {
        itemId,
        error: extractErrorMessage(err, tCalendar('phaseI.errors.couldNotUnsnoozeInboxItem'))
      })
    }
  }

  const handleInboxSnoozeReschedule = async (itemId: string, snoozeUntil: string) => {
    const tCalendar = getI18n().getFixedT(null, 'calendar')
    try {
      const result = await inboxService.snooze({ itemId, snoozeUntil })
      if (!result.success) {
        throw new Error(result.error ?? tCalendar('phaseI.errors.couldNotRescheduleInboxItem'))
      }
      await queryClient.invalidateQueries({ queryKey: ['calendar', 'range'] })
      setInboxSnoozePopoverState(null)
    } catch (err) {
      log.error('Failed to reschedule inbox item', {
        itemId,
        error: extractErrorMessage(err, tCalendar('phaseI.errors.couldNotRescheduleInboxItem'))
      })
    }
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
        const createdId = result.event?.id
        const projectId = popoverState.draft.projectId
        // The link needs an event id, which only exists after the create. A
        // failed link must not discard a successfully created event.
        if (createdId && projectId) {
          try {
            const linked = await tasksService.linkProjectItem({
              projectId,
              itemType: 'calendar_event',
              itemId: createdId
            })
            if (!linked.success) throw new Error(linked.error)
          } catch (error) {
            const tCalendar = getI18n().getFixedT(null, 'calendar')
            log.error('Failed to link created event to project', {
              eventId: createdId,
              projectId,
              error: extractErrorMessage(error)
            })
            toast.error(extractErrorMessage(error, tCalendar('form.project-update-failed')))
          }
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
        error: extractErrorMessage(
          err,
          getI18n().getFixedT(null, 'calendar')('phaseI.errors.failedToDeleteEvent')
        )
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

  const commitEventTimes = async (id: string, startAt: string, endAt: string | null) => {
    const result = await calendarService.updateEvent({
      id,
      startAt,
      endAt,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      isAllDay: false
    })
    if (!result.success) {
      throw new Error(result.error ?? 'Could not update event.')
    }
    await queryClient.invalidateQueries({ queryKey: ['calendar', 'range'] })
  }

  const commitTaskSchedule = async (id: string, dueDate: string, dueTime: string) => {
    const result = await tasksService.update({ id, dueDate, dueTime })
    if (!result.success) {
      throw new Error(result.error ?? 'Could not update task.')
    }
    await queryClient.invalidateQueries({ queryKey: ['calendar', 'range'] })
  }

  const handleMoveEvent = async (item: CalendarProjectionItem, startAt: string, endAt: string) => {
    if (item.sourceType === 'task') {
      const previousStartAt = item.startAt
      const { dueDate, dueTime } = dueDateTimeFromDate(new Date(startAt))
      try {
        await commitTaskSchedule(item.sourceId, dueDate, dueTime)
        registerUndo(getI18n().getFixedT(null, 'calendar')('undo.moveTask'), () => {
          const previous = dueDateTimeFromDate(new Date(previousStartAt))
          void commitTaskSchedule(item.sourceId, previous.dueDate, previous.dueTime).catch(
            (err) => {
              log.error('Failed to undo task reschedule', {
                taskId: item.sourceId,
                error: extractErrorMessage(err)
              })
            }
          )
        })
      } catch (err) {
        log.error('Failed to reschedule task', {
          taskId: item.sourceId,
          error: extractErrorMessage(err)
        })
      }
      return
    }

    const previousStartAt = item.startAt
    const previousEndAt = item.endAt
    try {
      await commitEventTimes(item.sourceId, startAt, endAt)
      // Register undo so Cmd+Z restores the previous time (handled globally in App.tsx).
      registerUndo(getI18n().getFixedT(null, 'calendar')('undo.moveEvent'), () => {
        void commitEventTimes(item.sourceId, previousStartAt, previousEndAt).catch((err) => {
          log.error('Failed to undo calendar event move', {
            eventId: item.sourceId,
            error: extractErrorMessage(err)
          })
        })
      })
    } catch (err) {
      log.error('Failed to move calendar event', {
        eventId: item.sourceId,
        error: extractErrorMessage(err)
      })
    }
  }

  const selectedItemId =
    popoverState?.eventId ??
    taskPopoverState?.item.sourceId ??
    inboxSnoozePopoverState?.item.sourceId ??
    null

  return (
    <>
      <AgentAccessConsentDialog hasImportedSources={importedSources.length > 0} />

      <PromoteExternalDialog
        open={pendingPromote !== null}
        isWorking={isPromoting}
        errorMessage={promoteError}
        agentAccessOff={pendingPromote?.agentAccessOff ?? false}
        onOpenChange={(open) => {
          if (open) return
          setPendingPromote(null)
          setPromoteError(null)
        }}
        onConfirm={(dontAskAgain) => {
          if (!pendingPromote) return
          void runPromote(pendingPromote, { dontAskAgain })
        }}
      />
      <CalendarShell
        view={view}
        anchorDate={anchorDate}
        items={filteredItems}
        importedSources={importedSources}
        isLoading={rangeQuery.isLoading || sourcesIsLoading}
        showMemryItems={showMemryItems}
        showImportedCalendars={showImportedCalendars}
        selectedImportedSourceIds={selectedImportedSourceIds}
        selectedVisualTypes={selectedVisualTypes}
        selectedItemId={selectedItemId}
        popoverState={
          popoverState
            ? {
                mode: popoverState.mode,
                eventId: popoverState.eventId,
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
        onToday={handleToday}
        onSearchJump={handleSearchJump}
        todayRequestKey={todayRequestKey}
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
        onToggleImportedSource={(sourceId) => handleToggleImportedSource(sourceId)}
        onToggleVisualType={(visualType) =>
          setSelectedVisualTypes((current) =>
            current.includes(visualType)
              ? current.filter((type) => type !== visualType)
              : [...current, visualType]
          )
        }
        onSelectItem={(...args) => void handleSelectItem(...args)}
        onDeleteItem={handleDeleteItem}
        onAddToProject={setAddToProjectEventId}
        onMoveEvent={handleMoveEvent}
        inboxSnoozePopoverState={inboxSnoozePopoverState}
        onInboxSnoozeOpenInInbox={handleInboxSnoozeOpenInInbox}
        onInboxSnoozeUnsnooze={handleInboxSnoozeUnsnooze}
        onInboxSnoozeReschedule={handleInboxSnoozeReschedule}
        onInboxSnoozePopoverDismiss={() => setInboxSnoozePopoverState(null)}
        notePopoverState={notePopoverState}
        onNoteOpen={handleNoteOpen}
        onNotePopoverDismiss={() => setNotePopoverState(null)}
        onPopoverDismiss={() => setPopoverState(null)}
        onPopoverDraftChange={(draft) =>
          setPopoverState((current) => (current ? { ...current, draft } : current))
        }
        onAnchorChange={(date) => setAnchorDate(date)}
        onWeekVisibleRangeChange={(startDate) => setAnchorDate(startDate)}
        onPopoverSave={() => void handlePopoverSave()}
        onQuickSave={handleQuickSave}
        googleConnectAction={<GoogleCalendarConnectPrompt />}
      />
      {taskPopoverState && (
        <CalendarTaskPopover
          item={taskPopoverState.item}
          anchorRect={taskPopoverState.anchorRect}
          onDismiss={() => setTaskPopoverState(null)}
        />
      )}
      <DeleteCalendarEventDialog
        open={pendingDelete !== null}
        title={pendingDelete?.title ?? ''}
        hasGoogleBinding={pendingDelete?.binding !== null && pendingDelete?.binding !== undefined}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => void handleConfirmDelete()}
      />
      <AddEventToProjectDialog
        open={addToProjectEventId != null}
        eventId={addToProjectEventId ?? ''}
        onOpenChange={(open) => {
          if (!open) setAddToProjectEventId(null)
        }}
      />
    </>
  )
}

export default CalendarPage
