import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CalendarPage } from './calendar'
import type { CalendarProjectionItem, CalendarSourceRecord } from '@/services/calendar-service'

const rect = { top: 10, left: 20, width: 120, height: 40 }

const source = (id: string, title: string): CalendarSourceRecord => ({
  id,
  provider: 'google',
  kind: 'calendar',
  accountId: 'account-1',
  remoteId: id,
  title,
  timezone: 'UTC',
  color: '#2563eb',
  isPrimary: false,
  isSelected: true,
  isMemryManaged: false,
  syncCursor: null,
  syncStatus: 'ok',
  lastSyncedAt: null,
  metadata: null,
  archivedAt: null,
  syncedAt: null,
  createdAt: '2026-05-10T00:00:00.000Z',
  modifiedAt: '2026-05-10T00:00:00.000Z'
})

const item = (
  sourceType: CalendarProjectionItem['sourceType'],
  sourceId: string,
  title: string,
  overrides: Partial<CalendarProjectionItem> = {}
): CalendarProjectionItem => ({
  projectionId: `${sourceType}:${sourceId}`,
  sourceType,
  sourceId,
  title,
  descriptionPreview: null,
  startAt: '2026-05-10T09:00:00.000Z',
  endAt: '2026-05-10T10:00:00.000Z',
  isAllDay: false,
  timezone: 'UTC',
  visualType:
    sourceType === 'external_event'
      ? 'external_event'
      : sourceType === 'task'
        ? 'task'
        : sourceType === 'inbox_snooze'
          ? 'snooze'
          : 'event',
  editability: { canMove: true, canResize: true, canEditText: true, canDelete: true },
  source: {
    provider: null,
    calendarSourceId: null,
    title: 'memrynote',
    color: null,
    kind: null,
    isMemryManaged: true
  },
  binding: null,
  ...overrides
})

const mocks = vi.hoisted(() => ({
  anchorDate: '2026-05-10',
  calendarItems: [] as CalendarProjectionItem[],
  calendarSources: [] as CalendarSourceRecord[],
  createEvent: vi.fn(),
  deleteMutateAsync: vi.fn(),
  getEvent: vi.fn(),
  getSettings: vi.fn(),
  invalidateQueries: vi.fn(),
  lastShellProps: null as null | Record<string, any>,
  logError: vi.fn(),
  openForDayView: vi.fn(),
  openTab: vi.fn(),
  promoteExternal: vi.fn(),
  setCalendarGoogleSettings: vi.fn(),
  taskUpdate: vi.fn(),
  setDayPanelDate: vi.fn(),
  setAnchorDate: vi.fn((next: string | ((current: string) => string)) => {
    mocks.anchorDate = typeof next === 'function' ? next(mocks.anchorDate) : next
  }),
  closeForDayView: vi.fn(),
  snooze: vi.fn(),
  unsnooze: vi.fn(),
  updateEvent: vi.fn()
}))

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: { sources: mocks.calendarSources }, isLoading: false }),
  useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries })
}))

vi.mock('@/components/calendar', () => ({
  CalendarShell: (props: Record<string, any>) => {
    mocks.lastShellProps = props
    const draft = {
      title: 'Draft title',
      description: 'Description',
      isAllDay: false,
      startAt: '2026-05-10T09:00',
      endAt: '2026-05-10T10:00',
      targetCalendarId: 'google-work',
      projectId: null
    }
    return (
      <div>
        <div data-testid="calendar-view">{props.view}</div>
        <div data-testid="calendar-items">
          {props.items.map((entry: any) => entry.title).join('|')}
        </div>
        <button type="button" onClick={() => props.onViewChange('day')}>
          view day
        </button>
        <button type="button" onClick={() => props.onViewChange('week')}>
          view week
        </button>
        <button type="button" onClick={() => props.onViewChange('month')}>
          view month
        </button>
        <button type="button" onClick={() => props.onViewChange('year')}>
          view year
        </button>
        <button type="button" onClick={props.onPrevious}>
          previous
        </button>
        <button type="button" onClick={props.onNext}>
          next
        </button>
        <button type="button" onClick={props.onToday}>
          today
        </button>
        <button type="button" onClick={props.onToggleMemryItems}>
          toggle memry
        </button>
        <button type="button" onClick={props.onToggleImportedCalendars}>
          toggle imported
        </button>
        <button type="button" onClick={() => props.onToggleImportedSource('google-home')}>
          toggle source
        </button>
        <button type="button" onClick={() => props.onToggleVisualType('task')}>
          toggle task visual
        </button>
        <button type="button" onClick={() => props.onAnchorChange('2026-05-12')}>
          anchor change
        </button>
        <button type="button" onClick={() => props.onWeekVisibleRangeChange('2026-05-03')}>
          week range
        </button>
        <button type="button" onClick={() => props.onCreateEvent(rect)}>
          create event
        </button>
        <button type="button" onClick={() => props.onPopoverDraftChange(draft)}>
          draft change
        </button>
        <button type="button" onClick={props.onPopoverSave}>
          save popover
        </button>
        <button type="button" onClick={() => props.onQuickSave(draft)}>
          quick save
        </button>
        <button
          type="button"
          onClick={() =>
            props.onSelectItem(
              mocks.calendarItems.find((entry) => entry.sourceType === 'task'),
              rect
            )
          }
        >
          select task
        </button>
        <button
          type="button"
          onClick={() =>
            props.onSelectItem(
              mocks.calendarItems.find((entry) => entry.sourceType === 'event'),
              rect
            )
          }
        >
          select event
        </button>
        <button
          type="button"
          onClick={() =>
            props.onSelectItem(
              mocks.calendarItems.find((entry) => entry.sourceType === 'inbox_snooze'),
              rect
            )
          }
        >
          select inbox
        </button>
        <button
          type="button"
          onClick={() =>
            props.onSelectItem(
              mocks.calendarItems.find((entry) => entry.sourceType === 'external_event'),
              rect
            )
          }
        >
          select external
        </button>
        <button
          type="button"
          onClick={() =>
            props.onDeleteItem(mocks.calendarItems.find((entry) => entry.sourceType === 'event'))
          }
        >
          delete event
        </button>
        <button type="button" onClick={props.onPopoverDismiss}>
          dismiss popover
        </button>
        <button
          type="button"
          onClick={() =>
            props.onMoveEvent(
              mocks.calendarItems.find((entry) => entry.sourceType === 'task'),
              '2026-05-11T14:30:00.000Z',
              '2026-05-11T15:30:00.000Z'
            )
          }
        >
          move task
        </button>
        <button
          type="button"
          onClick={() =>
            props.onMoveEvent(
              mocks.calendarItems.find((entry) => entry.sourceType === 'event'),
              '2026-05-11T14:30:00.000Z',
              '2026-05-11T15:30:00.000Z'
            )
          }
        >
          move event
        </button>
        {props.popoverState && <div data-testid="popover-mode">{props.popoverState.mode}</div>}
        {props.inboxSnoozePopoverState && (
          <div>
            <button type="button" onClick={() => props.onInboxSnoozeOpenInInbox('snooze-1')}>
              open inbox item
            </button>
            <button type="button" onClick={() => props.onInboxSnoozeUnsnooze('snooze-1')}>
              unsnooze item
            </button>
            <button
              type="button"
              onClick={() => props.onInboxSnoozeReschedule('snooze-1', '2026-05-12T09:00:00.000Z')}
            >
              reschedule item
            </button>
            <button type="button" onClick={props.onInboxSnoozePopoverDismiss}>
              dismiss inbox
            </button>
          </div>
        )}
      </div>
    )
  }
}))

vi.mock('@/hooks/use-calendar-range', () => ({
  useCalendarRange: () => ({ items: mocks.calendarItems, isLoading: false })
}))

vi.mock('@/hooks/use-calendar-mutations', () => ({
  useDeleteCalendarEvent: () => ({ mutateAsync: mocks.deleteMutateAsync })
}))

vi.mock('@/components/calendar/promote-external-dialog', () => ({
  PromoteExternalDialog: ({
    open,
    errorMessage,
    agentAccessOff,
    onConfirm,
    onOpenChange
  }: {
    open: boolean
    errorMessage: string | null
    agentAccessOff?: boolean
    onConfirm: (dontAskAgain: boolean) => void
    onOpenChange: (open: boolean) => void
  }) =>
    open ? (
      <div>
        {errorMessage && <div role="alert">{errorMessage}</div>}
        {agentAccessOff && <div>promote agent warning</div>}
        <button type="button" onClick={() => onConfirm(false)}>
          promote once
        </button>
        <button type="button" onClick={() => onConfirm(true)}>
          promote remember
        </button>
        <button type="button" onClick={() => onOpenChange(false)}>
          close promote
        </button>
      </div>
    ) : null
}))

vi.mock('@/components/calendar/calendar-task-popover', () => ({
  CalendarTaskPopover: ({
    item,
    onDismiss
  }: {
    item: CalendarProjectionItem
    onDismiss: () => void
  }) => (
    <div>
      <span>task popover:{item.title}</span>
      <button type="button" onClick={onDismiss}>
        dismiss task
      </button>
    </div>
  )
}))

vi.mock('@/components/calendar/delete-calendar-event-dialog', () => ({
  DeleteCalendarEventDialog: ({
    open,
    title,
    onCancel,
    onConfirm
  }: {
    open: boolean
    title: string
    onCancel: () => void
    onConfirm: () => void
  }) =>
    open ? (
      <div>
        <span>delete:{title}</span>
        <button type="button" onClick={onCancel}>
          cancel delete
        </button>
        <button type="button" onClick={onConfirm}>
          confirm delete
        </button>
      </div>
    ) : null
}))

vi.mock('@/contexts/calendar-view-context', () => ({
  useCalendarView: () => ({
    anchorDate: mocks.anchorDate,
    setAnchorDate: mocks.setAnchorDate
  })
}))

vi.mock('@/contexts/day-panel-context', () => ({
  useDayPanel: () => ({
    closeForDayView: mocks.closeForDayView,
    openForDayView: mocks.openForDayView,
    setDate: mocks.setDayPanelDate
  })
}))

vi.mock('@/contexts/tabs', () => ({
  useActiveTab: () => null,
  useTabActions: () => ({ openTab: mocks.openTab }),
  // Rendered outside a tab: view, anchor and filters fall back to plain state.
  useTabActionsOptional: () => null
}))

vi.mock('@/services/calendar-service', () => ({
  calendarService: {
    createEvent: mocks.createEvent,
    getEvent: mocks.getEvent,
    listSources: vi.fn(),
    updateEvent: mocks.updateEvent
  },
  promoteExternalCalendarEvent: mocks.promoteExternal
}))

vi.mock('@/services/inbox-service', () => ({
  inboxService: {
    snooze: mocks.snooze,
    unsnooze: mocks.unsnooze
  }
}))

vi.mock('@/services/tasks-service', () => ({
  tasksService: {
    update: mocks.taskUpdate
  }
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: mocks.logError })
}))

vi.mock('react-i18next', () => ({
  getI18n: () => ({
    getFixedT: () => (key: string) => key
  }),
  useTranslation: () => ({ t: (key: string) => key })
}))

function renderPage(): ReturnType<typeof render> {
  return render(<CalendarPage />)
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  mocks.anchorDate = '2026-05-10'
  mocks.calendarSources = [source('google-work', 'Work'), source('google-home', 'Home')]
  mocks.calendarItems = [
    item('event', 'event-1', 'memrynote event'),
    item('task', 'task-1', 'Task due'),
    item('inbox_snooze', 'snooze-1', 'Inbox snooze'),
    item('external_event', 'external-1', 'External meeting', {
      source: {
        provider: 'google',
        calendarSourceId: 'google-work',
        title: 'Work',
        color: '#2563eb',
        kind: 'calendar',
        isMemryManaged: false
      }
    }),
    item('external_event', 'external-2', 'Hidden source meeting', {
      source: {
        provider: 'google',
        calendarSourceId: 'google-home',
        title: 'Home',
        color: '#16a34a',
        kind: 'calendar',
        isMemryManaged: false
      }
    })
  ]
  mocks.getSettings.mockResolvedValue({ promoteConfirmDismissed: false })
  mocks.createEvent.mockResolvedValue({ success: true, eventId: 'created-1' })
  mocks.updateEvent.mockResolvedValue({ success: true })
  mocks.taskUpdate.mockResolvedValue({ success: true, task: null })
  mocks.deleteMutateAsync.mockResolvedValue({ success: true })
  mocks.snooze.mockResolvedValue({ success: true })
  mocks.unsnooze.mockResolvedValue({ success: true })
  mocks.promoteExternal.mockResolvedValue({ success: true, eventId: 'promoted-1' })
  mocks.getEvent.mockResolvedValue({
    id: 'event-1',
    title: 'Loaded event',
    description: 'Loaded description',
    location: 'Loaded room',
    isAllDay: false,
    startAt: '2026-05-10T09:00:00.000Z',
    endAt: '2026-05-10T10:00:00.000Z',
    targetCalendarId: 'google-work',
    attendees: [],
    reminders: [],
    visibility: 'default',
    conferenceData: null
  })
  window.api = {
    ...window.api,
    settings: {
      ...window.api.settings,
      getCalendarGoogleSettings: mocks.getSettings,
      setCalendarGoogleSettings: mocks.setCalendarGoogleSettings
    }
  }
})

describe('CalendarPage callback coverage', () => {
  it('drives view navigation, filters, source cleanup, and anchor callbacks', async () => {
    const { rerender } = renderPage()

    await waitFor(() =>
      expect(mocks.lastShellProps?.selectedImportedSourceIds).toEqual([
        'google-work',
        'google-home'
      ])
    )
    expect(screen.getByTestId('calendar-items')).toHaveTextContent('External meeting')
    expect(screen.getByTestId('calendar-items')).toHaveTextContent('Hidden source meeting')

    fireEvent.click(screen.getByText('toggle source'))
    expect(screen.getByTestId('calendar-items')).not.toHaveTextContent('Hidden source meeting')

    fireEvent.click(screen.getByText('toggle imported'))
    expect(screen.getByTestId('calendar-items')).not.toHaveTextContent('External meeting')
    fireEvent.click(screen.getByText('toggle imported'))

    fireEvent.click(screen.getByText('toggle memry'))
    expect(screen.getByTestId('calendar-items')).not.toHaveTextContent('memrynote event')
    fireEvent.click(screen.getByText('toggle memry'))

    fireEvent.click(screen.getByText('toggle task visual'))
    expect(screen.getByTestId('calendar-items')).not.toHaveTextContent('Task due')

    for (const view of ['day', 'week', 'month', 'year']) {
      fireEvent.click(screen.getByText(`view ${view}`))
      fireEvent.click(screen.getByText('previous'))
      fireEvent.click(screen.getByText('next'))
    }
    fireEvent.click(screen.getByText('today'))
    fireEvent.click(screen.getByText('anchor change'))
    fireEvent.click(screen.getByText('week range'))

    expect(mocks.setAnchorDate).toHaveBeenCalled()
    expect(mocks.openForDayView).toHaveBeenCalled()
    expect(mocks.closeForDayView).toHaveBeenCalled()

    mocks.calendarSources = [source('google-work', 'Work')]
    rerender(<CalendarPage />)
    await waitFor(() =>
      expect(mocks.lastShellProps?.selectedImportedSourceIds).toEqual(['google-work'])
    )
  })

  it('creates, updates, quick-saves, promotes, and dismisses popovers', async () => {
    renderPage()

    fireEvent.click(screen.getByText('create event'))
    expect(screen.getByTestId('popover-mode')).toHaveTextContent('create')
    fireEvent.click(screen.getByText('draft change'))
    fireEvent.click(screen.getByText('save popover'))
    await waitFor(() =>
      expect(mocks.createEvent).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Draft title' })
      )
    )

    fireEvent.click(screen.getByText('select event'))
    await waitFor(() => expect(screen.getByTestId('popover-mode')).toHaveTextContent('edit'))
    fireEvent.click(screen.getByText('draft change'))
    fireEvent.click(screen.getByText('save popover'))
    await waitFor(() =>
      expect(mocks.updateEvent).toHaveBeenCalledWith(expect.objectContaining({ id: 'event-1' }))
    )

    fireEvent.click(screen.getByText('quick save'))
    await waitFor(() => expect(mocks.createEvent).toHaveBeenCalledTimes(2))

    fireEvent.click(screen.getByText('select task'))
    expect(screen.getByText('task popover:Task due')).toBeInTheDocument()
    fireEvent.click(screen.getByText('dismiss task'))
    expect(screen.queryByText('task popover:Task due')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('select external'))
    fireEvent.click(await screen.findByText('promote remember'))
    await waitFor(() =>
      expect(mocks.setCalendarGoogleSettings).toHaveBeenCalledWith({
        promoteConfirmDismissed: true
      })
    )
    expect(mocks.promoteExternal).toHaveBeenCalledWith({ externalEventId: 'external-1' })

    mocks.promoteExternal.mockResolvedValueOnce({ success: false, error: 'Promote denied' })
    fireEvent.click(screen.getByText('select external'))
    fireEvent.click(await screen.findByText('promote once'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Promote denied')
    fireEvent.click(screen.getByText('close promote'))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  // Promotion copies a Google event into native storage, which makes it agent-readable
  // regardless of the Google-events consent gate. "Don't ask again" must not be allowed
  // to make that happen silently while the user has AI access switched off.
  it.each([
    ['explicitly denied', false],
    ['never answered', null]
  ])(
    'given "don\'t ask again" and agent access %s, still confirms before promoting',
    async (_label, agentReadEventsConsent) => {
      mocks.getSettings.mockResolvedValue({
        promoteConfirmDismissed: true,
        agentReadEventsConsent
      })
      renderPage()

      fireEvent.click(screen.getByText('select external'))

      expect(await screen.findByText('promote agent warning')).toBeInTheDocument()
      expect(mocks.promoteExternal).not.toHaveBeenCalled()

      fireEvent.click(screen.getByText('promote once'))
      await waitFor(() =>
        expect(mocks.promoteExternal).toHaveBeenCalledWith({ externalEventId: 'external-1' })
      )
    }
  )

  it('given "don\'t ask again" and agent access granted, promotes without the dialog', async () => {
    mocks.getSettings.mockResolvedValue({
      promoteConfirmDismissed: true,
      agentReadEventsConsent: true
    })
    renderPage()

    fireEvent.click(screen.getByText('select external'))

    await waitFor(() =>
      expect(mocks.promoteExternal).toHaveBeenCalledWith({ externalEventId: 'external-1' })
    )
    expect(screen.queryByText('promote agent warning')).not.toBeInTheDocument()
  })

  it('routes a dragged task chip through tasksService.update, not calendarService.updateEvent', async () => {
    renderPage()

    const nextStart = new Date('2026-05-11T14:30:00.000Z')
    const expectedDueDate = `${nextStart.getFullYear()}-${String(nextStart.getMonth() + 1).padStart(2, '0')}-${String(nextStart.getDate()).padStart(2, '0')}`
    const expectedDueTime = `${String(nextStart.getHours()).padStart(2, '0')}:${String(nextStart.getMinutes()).padStart(2, '0')}`

    fireEvent.click(screen.getByText('move task'))
    await waitFor(() => expect(mocks.taskUpdate).toHaveBeenCalledTimes(1))
    expect(mocks.taskUpdate).toHaveBeenCalledWith({
      id: 'task-1',
      dueDate: expectedDueDate,
      dueTime: expectedDueTime
    })
    expect(mocks.updateEvent).not.toHaveBeenCalled()
  })

  it('still routes a dragged event chip through calendarService.updateEvent', async () => {
    renderPage()

    fireEvent.click(screen.getByText('move event'))
    await waitFor(() => expect(mocks.updateEvent).toHaveBeenCalledTimes(1))
    expect(mocks.updateEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'event-1',
        startAt: '2026-05-11T14:30:00.000Z',
        endAt: '2026-05-11T15:30:00.000Z'
      })
    )
    expect(mocks.taskUpdate).not.toHaveBeenCalled()
  })

  it('opens inbox snoozes, records snooze errors, and handles delete success and failure', async () => {
    renderPage()

    fireEvent.click(screen.getByText('select inbox'))
    fireEvent.click(await screen.findByText('open inbox item'))
    expect(mocks.openTab).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'inbox',
        viewState: expect.objectContaining({ focusInboxItemId: 'snooze-1' })
      })
    )

    fireEvent.click(screen.getByText('select inbox'))
    fireEvent.click(await screen.findByText('unsnooze item'))
    await waitFor(() => expect(mocks.unsnooze).toHaveBeenCalledWith('snooze-1'))

    mocks.snooze.mockResolvedValueOnce({ success: false, error: 'Snooze denied' })
    fireEvent.click(screen.getByText('select inbox'))
    fireEvent.click(await screen.findByText('reschedule item'))
    await waitFor(() =>
      expect(mocks.logError).toHaveBeenCalledWith(
        'Failed to reschedule inbox item',
        expect.objectContaining({ itemId: 'snooze-1', error: 'Snooze denied' })
      )
    )
    fireEvent.click(screen.getByText('dismiss inbox'))

    fireEvent.click(screen.getByText('delete event'))
    fireEvent.click(await screen.findByText('cancel delete'))
    expect(screen.queryByText('delete:memrynote event')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('delete event'))
    fireEvent.click(await screen.findByText('confirm delete'))
    await waitFor(() => expect(mocks.deleteMutateAsync).toHaveBeenCalledWith('event-1'))

    mocks.deleteMutateAsync.mockResolvedValueOnce({ success: false, error: 'Delete denied' })
    fireEvent.click(screen.getByText('delete event'))
    fireEvent.click(await screen.findByText('confirm delete'))
    await waitFor(() =>
      expect(mocks.logError).toHaveBeenCalledWith(
        'Failed to delete calendar event',
        expect.objectContaining({ eventId: 'event-1', error: 'Delete denied' })
      )
    )
  })
})
