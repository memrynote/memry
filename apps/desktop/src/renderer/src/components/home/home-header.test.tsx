import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { HomeHeader } from './home-header'
import { CalendarWidget } from './widgets/calendar-widget'
import type { CalendarProjectionItem } from '@/services/calendar-service'

// #1956: the header counted every calendar item (`items.length`) while the widget only renders
// non-task items (`visualType !== 'task'`). A non-task item seeded alongside a task on the same
// day used to make the header say "2 events" while the widget drew a single row. Both now derive
// their count from the same filtered collection (`filterCalendarWidgetItems`).
const items: CalendarProjectionItem[] = [
  {
    projectionId: 'reminder-1',
    sourceType: 'reminder',
    sourceId: 's1',
    title: 'Pick up dry cleaning',
    descriptionPreview: null,
    startAt: '2026-08-12T09:30:00.000Z',
    endAt: null,
    isAllDay: false,
    timezone: 'UTC',
    visualType: 'reminder',
    editability: {
      canMove: true,
      canResize: false,
      canEditText: true,
      canDelete: true
    },
    source: {
      provider: null,
      calendarSourceId: null,
      title: null,
      color: null,
      kind: null,
      isMemryManaged: true
    },
    binding: null,
    snoozeOffsetMinutes: null
  } as CalendarProjectionItem,
  {
    projectionId: 'task-1',
    sourceType: 'task',
    sourceId: 's2',
    title: 'Ship #1956',
    descriptionPreview: null,
    startAt: '2026-08-12T14:00:00.000Z',
    endAt: null,
    isAllDay: false,
    timezone: 'UTC',
    visualType: 'task',
    editability: {
      canMove: true,
      canResize: false,
      canEditText: true,
      canDelete: true
    },
    source: {
      provider: null,
      calendarSourceId: null,
      title: null,
      color: null,
      kind: null,
      isMemryManaged: true
    },
    binding: null,
    snoozeOffsetMinutes: null
  } as CalendarProjectionItem
]

vi.mock('@/hooks/use-calendar-range', () => ({
  useCalendarRange: () => ({ items, isLoading: false, error: null })
}))

vi.mock('@/hooks/use-general-settings', () => ({
  useGeneralSettings: () => ({ settings: { clockFormat: '24h' } })
}))

vi.mock('@/features/tasks/use-task-queries', () => ({
  useTaskWorkspaceData: () => ({ tasks: [], projects: [] })
}))

describe('Home header vs calendar widget event count (#1956)', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('header event count matches the widget rendered row count', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 12, 10, 0, 0, 0))

    render(
      <HomeHeader
        boards={[]}
        activeBoardId={null}
        onSelectBoard={() => {}}
        onCreateBoard={() => {}}
        onDeleteBoard={() => {}}
        onManageBoards={() => {}}
        showAddWidget={false}
        galleryOpen={false}
        onGalleryOpenChange={() => {}}
        onAddWidget={() => {}}
      />
    )
    render(<CalendarWidget config={{}} size="M" />)

    // One non-task item was seeded: the header must report exactly 1 event, not 2.
    expect(screen.getByText('1 event')).toBeInTheDocument()
    expect(screen.getAllByTestId('calendar-event')).toHaveLength(1)
  })
})
