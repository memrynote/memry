import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CalendarDayView } from './calendar-day-view'
import type { CalendarProjectionItem } from '@/services/calendar-service'

const mocks = vi.hoisted(() => ({
  marquee: {
    selection: null as null | {
      top: number
      height: number
      startAt: string
      endAt: string
      anchorRect: { x: number; y: number; width: number; height: number }
    },
    isDragging: false,
    onMouseDown: vi.fn(),
    onDoubleClick: vi.fn(),
    clearSelection: vi.fn()
  },
  scrollToCurrentTime: vi.fn()
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

vi.mock('@/hooks/use-general-settings', () => ({
  useGeneralSettings: () => ({
    settings: { clockFormat: '12h' }
  })
}))

vi.mock('./use-scroll-to-current-time', () => ({
  useScrollToCurrentTime: (...args: unknown[]) => mocks.scrollToCurrentTime(...args)
}))

vi.mock('./use-time-grid-marquee', () => ({
  useTimeGridMarquee: ({ dateForColumn }: { dateForColumn: (columnIndex: number) => string }) => {
    dateForColumn(0)
    return {
      selection: mocks.marquee.selection,
      isDragging: mocks.marquee.isDragging,
      handlers: {
        onMouseDown: mocks.marquee.onMouseDown,
        onDoubleClick: mocks.marquee.onDoubleClick
      },
      clearSelection: mocks.marquee.clearSelection
    }
  }
}))

vi.mock('./marquee-selection-overlay', () => ({
  MarqueeSelectionOverlay: ({ startAt, endAt }: { startAt: string; endAt: string }) => (
    <div data-testid="marquee-selection">
      {startAt} {endAt}
    </div>
  )
}))

vi.mock('./calendar-item-chip', () => ({
  CalendarItemChip: ({
    item,
    isSelected,
    onClick,
    onDeleteItem
  }: {
    item: CalendarProjectionItem
    isSelected: boolean
    onClick?: (item: CalendarProjectionItem, rect: DOMRect) => void
    onDeleteItem?: (item: CalendarProjectionItem) => void
  }) => (
    <div>
      <button
        type="button"
        data-selected={isSelected ? 'true' : 'false'}
        onClick={() => onClick?.(item, new DOMRect(1, 2, 3, 4))}
      >
        {item.title}
      </button>
      <button type="button" onClick={() => onDeleteItem?.(item)}>
        delete {item.title}
      </button>
    </div>
  )
}))

vi.mock('./calendar-quick-create-dialog', () => ({
  CalendarQuickCreateDialog: ({
    onDismiss,
    onSave,
    startAt,
    endAt,
    isAllDay
  }: {
    onDismiss: () => void
    onSave: (draft: { title: string; startAt: string; endAt: string; isAllDay: boolean }) => void
    startAt: string
    endAt: string
    isAllDay: boolean
  }) => (
    <div data-testid="quick-create-dialog">
      <span>
        {startAt} {endAt} {String(isAllDay)}
      </span>
      <button
        type="button"
        onClick={() => onSave({ title: 'Quick event', startAt, endAt, isAllDay })}
      >
        quick save
      </button>
      <button type="button" onClick={onDismiss}>
        dismiss quick create
      </button>
    </div>
  )
}))

// `timeBehavior`, `hourHeight`, and `dueTime` never reach the DOM — only the wrapper
// div and its children do. A copy-paste bug that forwards the wrong `date` or
// hardcodes `hourHeight` would render identically. Mock useDroppable one level down
// (real CalendarTimedColumnDroppable / CalendarAllDayCell / use-calendar-date-droppable
// still run) so we can assert the real config the day view registers.
const droppableMocks = vi.hoisted(() => ({
  useDroppable: vi.fn((_config: unknown) => ({ setNodeRef: vi.fn(), isOver: false })),
  useDraggable: vi.fn(() => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    isDragging: false
  }))
}))

vi.mock('@dnd-kit/core', () => ({
  useDroppable: droppableMocks.useDroppable,
  useDraggable: droppableMocks.useDraggable
}))

function eventItem(overrides: Partial<CalendarProjectionItem>): CalendarProjectionItem {
  return {
    projectionId: 'projection-1',
    sourceId: 'event-1',
    sourceType: 'event',
    title: 'Planning',
    descriptionPreview: null,
    startAt: '2026-05-14T09:00',
    endAt: '2026-05-14T10:00',
    isAllDay: false,
    color: '#64748b',
    eventType: 'external',
    sourceCalendarId: null,
    sourceCalendarName: null,
    googleHtmlLink: null,
    sourceNoteId: null,
    taskStatus: null,
    taskPriority: null,
    taskDueDate: null,
    taskDueTime: null,
    taskProjectId: null,
    taskProjectName: null,
    reminderId: null,
    inboxItemId: null,
    ...overrides
  } as CalendarProjectionItem
}

describe('CalendarDayView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.marquee.selection = null
    mocks.marquee.isDragging = false
  })

  it('renders all-day and timed items and forwards grid and item actions', () => {
    const allDayItem = eventItem({
      projectionId: 'all-day',
      sourceId: 'event-all-day',
      title: 'All-day offsite',
      isAllDay: true,
      startAt: '2026-05-14',
      endAt: '2026-05-15'
    })
    const timedItem = eventItem({
      projectionId: 'timed',
      sourceId: 'event-timed',
      title: 'Timed sync'
    })
    const onSelectItem = vi.fn()
    const onDeleteItem = vi.fn()

    render(
      <CalendarDayView
        anchorDate="2026-05-14"
        items={[allDayItem, timedItem, eventItem({ startAt: '2026-05-15T09:00' })]}
        selectedItemId="event-timed"
        onSelectItem={onSelectItem}
        onDeleteItem={onDeleteItem}
      />
    )

    expect(screen.getByTestId('day-all-day-strip')).toBeInTheDocument()
    expect(screen.getByText('All-day offsite')).toBeInTheDocument()
    expect(screen.getByText('Timed sync')).toHaveAttribute('data-selected', 'true')
    expect(screen.queryByText('Planning')).not.toBeInTheDocument()

    fireEvent.mouseDown(screen.getByTestId('day-time-grid'))
    fireEvent.doubleClick(screen.getByTestId('day-time-grid'))
    expect(mocks.marquee.onMouseDown).toHaveBeenCalled()
    expect(mocks.marquee.onDoubleClick).toHaveBeenCalled()

    fireEvent.click(screen.getByText('Timed sync'))
    fireEvent.click(screen.getByText('delete Timed sync'))
    expect(onSelectItem).toHaveBeenCalledWith(timedItem, expect.any(DOMRect))
    expect(onDeleteItem).toHaveBeenCalledWith(timedItem)
  })

  it('shows quick create from a settled selection and clears after actions', async () => {
    mocks.marquee.selection = {
      top: 96,
      height: 48,
      startAt: '2026-05-14T11:00',
      endAt: '2026-05-14T12:00',
      anchorRect: { x: 10, y: 20, width: 30, height: 40 }
    }
    const onQuickSave = vi.fn().mockResolvedValue(undefined)

    render(
      <CalendarDayView
        anchorDate="2026-05-14"
        items={[]}
        selectedItemId={null}
        onQuickSave={onQuickSave}
      />
    )

    expect(screen.getByTestId('marquee-selection')).toHaveTextContent('2026-05-14T11:00')
    expect(screen.getByTestId('quick-create-dialog')).toHaveTextContent('false')

    fireEvent.click(screen.getByText('quick save'))
    await waitFor(() =>
      expect(onQuickSave).toHaveBeenCalledWith({
        title: 'Quick event',
        startAt: '2026-05-14T11:00',
        endAt: '2026-05-14T12:00',
        isAllDay: false
      })
    )
    expect(mocks.marquee.clearSelection).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByText('dismiss quick create'))
    expect(mocks.marquee.clearSelection).toHaveBeenCalledTimes(2)
  })

  it('shows the marquee overlay while dragging without opening quick create', () => {
    mocks.marquee.selection = {
      top: 48,
      height: 48,
      startAt: '2026-05-14T10:00',
      endAt: '2026-05-14T11:00',
      anchorRect: { x: 4, y: 8, width: 12, height: 16 }
    }
    mocks.marquee.isDragging = true

    render(
      <CalendarDayView
        anchorDate="2026-05-14"
        items={[]}
        selectedItemId={null}
        onQuickSave={vi.fn()}
      />
    )

    expect(screen.getByTestId('marquee-selection')).toHaveTextContent('2026-05-14T10:00')
    expect(screen.queryByTestId('quick-create-dialog')).not.toBeInTheDocument()
  })
})

describe('CalendarDayView drop target wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.marquee.selection = null
    mocks.marquee.isDragging = false
  })

  it('registers the timed grid as a slot droppable for anchorDate with HOUR_HEIGHT, and the all-day cell with timeBehavior "clear"', () => {
    const allDayItem = eventItem({
      projectionId: 'all-day',
      sourceId: 'event-all-day',
      title: 'All-day offsite',
      isAllDay: true,
      startAt: '2026-05-14',
      endAt: '2026-05-15'
    })
    const timedItem = eventItem({
      projectionId: 'timed',
      sourceId: 'event-timed',
      title: 'Timed sync'
    })

    render(
      <CalendarDayView
        anchorDate="2026-05-14"
        items={[allDayItem, timedItem]}
        selectedItemId={null}
      />
    )

    const calls = droppableMocks.useDroppable.mock.calls.map(
      ([config]) => config as { id: string; data: Record<string, unknown> }
    )

    const timedCall = calls.find(
      (call) => call.data.type === 'date' && call.data.timeBehavior === 'slot'
    )
    expect(timedCall).toBeDefined()
    expect(timedCall?.data.dateKey).toBe('2026-05-14')
    expect(timedCall?.data.hourHeight).toBe(48)
    expect(timedCall?.id).toBe('calendar-timed-column:2026-05-14')

    const allDayCall = calls.find((call) => call.data.type === 'date' && 'dueTime' in call.data)
    expect(allDayCall).toBeDefined()
    expect(allDayCall?.data.dateKey).toBe('2026-05-14')
    expect(allDayCall?.data.dueTime).toBeNull()
    expect(allDayCall?.id).toBe('calendar-date:2026-05-14:clear')
  })
})
