import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CalendarShell } from './calendar-shell'
import type { CalendarEventDraft } from './types'

const calendarApi = vi.hoisted(() => ({
  refreshGoogleCalendarProvider: vi.fn()
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string) => key
  })
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    warn: vi.fn()
  })
}))

vi.mock('@/services/calendar-service', () => ({
  refreshGoogleCalendarProvider: calendarApi.refreshGoogleCalendarProvider
}))

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('./calendar-toolbar', () => ({
  CalendarToolbar: ({
    extraActions,
    onCreateEvent,
    onNext,
    onPrevious,
    onToday,
    onViewChange
  }: {
    extraActions: React.ReactNode
    onCreateEvent: (rect: { x: number; y: number; width: number; height: number }) => void
    onNext: () => void
    onPrevious: () => void
    onToday: () => void
    onViewChange: (view: string) => void
  }) => (
    <div>
      {extraActions}
      <button type="button" onClick={() => onCreateEvent({ x: 1, y: 2, width: 3, height: 4 })}>
        create
      </button>
      <button type="button" onClick={onPrevious}>
        previous
      </button>
      <button type="button" onClick={onToday}>
        today
      </button>
      <button type="button" onClick={onNext}>
        next
      </button>
      <button type="button" onClick={() => onViewChange('month')}>
        month
      </button>
    </div>
  )
}))

vi.mock('./calendar-day-view', () => ({
  CalendarDayView: () => <div data-testid="day-view" />
}))

vi.mock('./calendar-week-view', () => ({
  CalendarWeekView: ({
    onQuickSave,
    onSelectItem,
    onVisibleDayStartChange
  }: {
    onQuickSave?: (draft: CalendarEventDraft) => void
    onSelectItem: (
      item: { id: string; title: string },
      rect: { x: number; y: number; width: number; height: number }
    ) => void
    onVisibleDayStartChange?: (index: number, startDate: string) => void
  }) => (
    <div data-testid="week-view">
      <button
        type="button"
        onClick={() =>
          onSelectItem({ id: 'event-1', title: 'Event' }, { x: 0, y: 1, width: 2, height: 3 })
        }
      >
        select week item
      </button>
      <button type="button" onClick={() => onVisibleDayStartChange?.(1, '2026-05-18')}>
        visible week
      </button>
      <button
        type="button"
        onClick={() =>
          onQuickSave?.({
            title: 'Quick',
            description: '',
            startAt: '2026-05-14T09:00',
            endAt: '2026-05-14T10:00',
            isAllDay: false,
            targetCalendarId: null,
            projectId: null
          })
        }
      >
        quick save
      </button>
    </div>
  )
}))

vi.mock('./calendar-month-view', () => ({
  CalendarMonthView: () => <div data-testid="month-view" />
}))

vi.mock('./calendar-year-view', () => ({
  CalendarYearView: ({
    onAnchorChange,
    onViewChange
  }: {
    onAnchorChange?: (date: string) => void
    onViewChange: (view: string) => void
  }) => (
    <div data-testid="year-view">
      <button type="button" onClick={() => onAnchorChange?.('2027-01-01')}>
        change anchor
      </button>
      <button type="button" onClick={() => onViewChange('day')}>
        open day
      </button>
    </div>
  )
}))

vi.mock('./calendar-event-popover', () => ({
  CalendarEventPopover: ({
    onDismiss,
    onDraftChange,
    onSave
  }: {
    onDismiss: () => void
    onDraftChange: (draft: CalendarEventDraft) => void
    onSave: () => void
  }) => (
    <div data-testid="event-popover">
      <button
        type="button"
        onClick={() =>
          onDraftChange({
            title: 'Changed',
            description: '',
            startAt: '2026-05-14T09:00',
            endAt: '2026-05-14T10:00',
            isAllDay: false,
            targetCalendarId: null,
            projectId: null
          })
        }
      >
        change draft
      </button>
      <button type="button" onClick={onSave}>
        save popover
      </button>
      <button type="button" onClick={onDismiss}>
        dismiss popover
      </button>
    </div>
  )
}))

vi.mock('./calendar-inbox-snooze-popover', () => ({
  CalendarInboxSnoozePopover: ({
    onDismiss,
    onOpenInInbox,
    onReschedule,
    onUnsnooze
  }: {
    onDismiss: () => void
    onOpenInInbox: (itemId: string) => void
    onReschedule: (itemId: string, snoozeUntil: string) => void
    onUnsnooze: (itemId: string) => void
  }) => (
    <div data-testid="snooze-popover">
      <button type="button" onClick={() => onOpenInInbox('inbox-1')}>
        open inbox
      </button>
      <button type="button" onClick={() => onUnsnooze('inbox-1')}>
        unsnooze inbox
      </button>
      <button type="button" onClick={() => onReschedule('inbox-1', '2026-05-15T09:00:00.000Z')}>
        reschedule inbox
      </button>
      <button type="button" onClick={onDismiss}>
        dismiss snooze
      </button>
    </div>
  )
}))

function createProps(overrides: Partial<React.ComponentProps<typeof CalendarShell>> = {}) {
  return {
    view: 'week',
    anchorDate: '2026-05-14',
    items: [],
    importedSources: [{ id: 'source-1', title: 'Work Calendar' }],
    isLoading: false,
    showMemryItems: true,
    showImportedCalendars: false,
    selectedImportedSourceIds: ['source-1'],
    selectedVisualTypes: ['event'],
    selectedItemId: null,
    popoverState: null,
    inboxSnoozePopoverState: null,
    onInboxSnoozeOpenInInbox: vi.fn(),
    onInboxSnoozeUnsnooze: vi.fn(),
    onInboxSnoozeReschedule: vi.fn(),
    onInboxSnoozePopoverDismiss: vi.fn(),
    isSaving: false,
    onViewChange: vi.fn(),
    onPrevious: vi.fn(),
    onNext: vi.fn(),
    onToday: vi.fn(),
    onCreateEvent: vi.fn(),
    onSearchJump: vi.fn(),
    onToggleMemryItems: vi.fn(),
    onToggleImportedCalendars: vi.fn(),
    onToggleImportedSource: vi.fn(),
    onToggleVisualType: vi.fn(),
    onSelectItem: vi.fn(),
    onDeleteItem: vi.fn(),
    onPopoverDismiss: vi.fn(),
    onPopoverDraftChange: vi.fn(),
    onPopoverSave: vi.fn(),
    onAnchorChange: vi.fn(),
    onWeekVisibleRangeChange: vi.fn(),
    onQuickSave: vi.fn(),
    ...overrides
  } satisfies React.ComponentProps<typeof CalendarShell>
}

describe('CalendarShell', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    calendarApi.refreshGoogleCalendarProvider.mockResolvedValue({ success: true })
  })

  it('drives toolbar, filter, refresh, week, and popover actions', async () => {
    const user = userEvent.setup()
    const props = createProps({
      showImportedCalendars: true,
      popoverState: {
        mode: 'create',
        draft: {
          title: 'Draft',
          description: '',
          startAt: '2026-05-14T09:00',
          endAt: '2026-05-14T10:00',
          isAllDay: false,
          targetCalendarId: null,
          projectId: null
        },
        anchorRect: { x: 0, y: 0, width: 10, height: 10 }
      },
      inboxSnoozePopoverState: {
        item: { id: 'snooze-1', sourceId: 'inbox-1', title: 'Snoozed inbox item' } as never,
        anchorRect: { x: 5, y: 5, width: 10, height: 10 }
      }
    })

    render(<CalendarShell {...props} />)

    await user.click(screen.getByRole('button', { name: 'filter.refresh-google-calendars' }))
    await waitFor(() => expect(calendarApi.refreshGoogleCalendarProvider).toHaveBeenCalledTimes(1))

    await user.click(screen.getByRole('checkbox', { name: 'filter.memry-items' }))
    await user.click(screen.getByRole('checkbox', { name: 'filter.imported-calendars' }))
    await user.click(screen.getByRole('checkbox', { name: 'visual-type.task' }))
    await user.click(screen.getByRole('checkbox', { name: 'Work Calendar' }))
    expect(props.onToggleMemryItems).toHaveBeenCalledTimes(1)
    expect(props.onToggleImportedCalendars).toHaveBeenCalledTimes(1)
    expect(props.onToggleVisualType).toHaveBeenCalledWith('task')
    expect(props.onToggleImportedSource).toHaveBeenCalledWith('source-1')

    for (const label of ['create', 'previous', 'today', 'next', 'month']) {
      await user.click(screen.getByRole('button', { name: label }))
    }
    expect(props.onCreateEvent).toHaveBeenCalledWith({ x: 1, y: 2, width: 3, height: 4 })
    expect(props.onPrevious).toHaveBeenCalledTimes(1)
    expect(props.onToday).toHaveBeenCalledTimes(1)
    expect(props.onNext).toHaveBeenCalledTimes(1)
    expect(props.onViewChange).toHaveBeenCalledWith('month')

    await user.click(screen.getByRole('button', { name: 'select week item' }))
    await user.click(screen.getByRole('button', { name: 'visible week' }))
    await user.click(screen.getByRole('button', { name: 'quick save' }))
    expect(props.onSelectItem).toHaveBeenCalledWith(
      { id: 'event-1', title: 'Event' },
      { x: 0, y: 1, width: 2, height: 3 }
    )
    expect(props.onWeekVisibleRangeChange).toHaveBeenCalledWith('2026-05-18')
    expect(props.onQuickSave).toHaveBeenCalledWith(expect.objectContaining({ title: 'Quick' }))

    await user.click(screen.getByRole('button', { name: 'change draft' }))
    await user.click(screen.getByRole('button', { name: 'save popover' }))
    await user.click(screen.getByRole('button', { name: 'dismiss popover' }))
    expect(props.onPopoverDraftChange).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Changed' })
    )
    expect(props.onPopoverSave).toHaveBeenCalledTimes(1)
    expect(props.onPopoverDismiss).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: 'open inbox' }))
    await user.click(screen.getByRole('button', { name: 'unsnooze inbox' }))
    await user.click(screen.getByRole('button', { name: 'reschedule inbox' }))
    await user.click(screen.getByRole('button', { name: 'dismiss snooze' }))
    expect(props.onInboxSnoozeOpenInInbox).toHaveBeenCalledWith('inbox-1')
    expect(props.onInboxSnoozeUnsnooze).toHaveBeenCalledWith('inbox-1')
    expect(props.onInboxSnoozeReschedule).toHaveBeenCalledWith(
      'inbox-1',
      '2026-05-15T09:00:00.000Z'
    )
    expect(props.onInboxSnoozePopoverDismiss).toHaveBeenCalledTimes(1)
  })

  it('renders loading and alternate views while handling refresh failures', async () => {
    const user = userEvent.setup()
    const props = createProps({ isLoading: true, importedSources: [] })
    const { rerender } = render(<CalendarShell {...props} />)

    expect(screen.getByText('state.loading-calendar')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'filter.refresh-google-calendars' })
    ).not.toBeInTheDocument()

    calendarApi.refreshGoogleCalendarProvider.mockResolvedValueOnce({
      success: false,
      error: 'nope'
    })
    rerender(<CalendarShell {...createProps({ view: 'day' })} />)
    expect(screen.getByTestId('day-view')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'filter.refresh-google-calendars' }))
    await waitFor(() => expect(calendarApi.refreshGoogleCalendarProvider).toHaveBeenCalledTimes(1))

    calendarApi.refreshGoogleCalendarProvider.mockRejectedValueOnce(new Error('network down'))
    await user.click(screen.getByRole('button', { name: 'filter.refresh-google-calendars' }))
    await waitFor(() => expect(calendarApi.refreshGoogleCalendarProvider).toHaveBeenCalledTimes(2))

    rerender(<CalendarShell {...createProps({ view: 'month' })} />)
    expect(screen.getByTestId('month-view')).toBeInTheDocument()

    const yearProps = createProps({ view: 'year' })
    rerender(<CalendarShell {...yearProps} />)
    await user.click(screen.getByRole('button', { name: 'change anchor' }))
    await user.click(screen.getByRole('button', { name: 'open day' }))
    expect(yearProps.onAnchorChange).toHaveBeenCalledWith('2027-01-01')
    expect(yearProps.onViewChange).toHaveBeenCalledWith('day')
  })
})
