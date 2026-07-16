import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CalendarWeekView } from './calendar-week-view'

const mocks = vi.hoisted(() => ({
  scrollToDate: vi.fn(),
  onMouseDown: vi.fn(),
  onDoubleClick: vi.fn(),
  selection: null as null | {
    columnIndex: number
    top: number
    height: number
    startAt: string
    endAt: string
    anchorRect: { x: number; y: number; width: number; height: number }
  },
  isDragging: false,
  clearSelection: vi.fn(),
  dragContext: null as null | { dragState: { isDragging: boolean } }
}))

vi.mock('@/contexts/drag-context', () => ({
  useOptionalDragContext: () => mocks.dragContext
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string) => key,
    i18n: { language: 'en-US' }
  })
}))

vi.mock('@/hooks/use-general-settings', () => ({
  useGeneralSettings: () => ({ settings: { clockFormat: '24h' } })
}))

vi.mock('./calendar-item-chip', () => ({
  CalendarItemChip: ({ item, onClick, onDeleteItem, isSelected }: any) => (
    <div data-visual-type={item.visualType} data-selected={String(isSelected)}>
      <button
        type="button"
        onClick={() =>
          onClick?.(item, {
            x: 1,
            y: 2,
            width: 3,
            height: 4
          })
        }
      >
        chip:{item.title}
      </button>
      <button type="button" onClick={() => onDeleteItem?.(item)}>
        delete:{item.title}
      </button>
    </div>
  )
}))

vi.mock('./use-week-infinite-scroll', () => ({
  useWeekInfiniteScroll: ({ onVisibleDayStartChange }: any) => {
    onVisibleDayStartChange?.(0, '2026-05-10')
    return {
      scrollContainerRef: { current: document.createElement('div') },
      visibleDayStart: 0,
      scrollToDate: mocks.scrollToDate,
      dateForDayIndex: (index: number) => {
        const date = new Date('2026-05-10T00:00:00.000Z')
        date.setUTCDate(date.getUTCDate() + index)
        return date.toISOString().slice(0, 10)
      },
      virtualizer: {
        options: { count: 7 },
        getVirtualItems: () =>
          Array.from({ length: 7 }, (_, index) => ({
            index,
            key: index,
            start: index * 120,
            size: 120
          })),
        getTotalSize: () => 840
      }
    }
  }
}))

vi.mock('./use-time-grid-marquee', () => ({
  useTimeGridMarquee: () => ({
    selection: mocks.selection,
    isDragging: mocks.isDragging,
    clearSelection: mocks.clearSelection,
    handlers: {
      onMouseDown: mocks.onMouseDown,
      onDoubleClick: mocks.onDoubleClick
    }
  })
}))

vi.mock('./use-scroll-to-current-time', () => ({
  useScrollToCurrentTime: vi.fn()
}))

vi.mock('./marquee-selection-overlay', () => ({
  MarqueeSelectionOverlay: ({ startAt, endAt }: { startAt: string; endAt: string }) => (
    <div>
      marquee:{startAt}:{endAt}
    </div>
  )
}))

vi.mock('./calendar-quick-create-dialog', () => ({
  CalendarQuickCreateDialog: ({ startAt, endAt, onSave, onDismiss }: any) => (
    <div role="dialog" aria-label="quick create">
      <button type="button" onClick={() => onSave({ title: 'Quick', startAt, endAt })}>
        quick save
      </button>
      <button type="button" onClick={onDismiss}>
        quick dismiss
      </button>
    </div>
  )
}))

// `timeBehavior`, `hourHeight`, and `dueTime` never reach the DOM — only the wrapper
// div and its children do. A copy-paste bug that forwards the wrong `date` or
// hardcodes `hourHeight` would render identically. Mock useDroppable one level down
// (real CalendarTimedColumnDroppable / CalendarAllDayCell / use-calendar-date-droppable
// still run) so we can assert the real config each column registers.
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

const timedItem = {
  projectionId: 'event:event-1',
  sourceType: 'event',
  sourceId: 'event-1',
  title: 'Planning',
  startAt: '2026-05-10T09:00:00.000Z',
  endAt: '2026-05-10T10:30:00.000Z',
  isAllDay: false,
  visualType: 'event',
  source: { provider: null }
} as any

const allDayItem = {
  ...timedItem,
  projectionId: 'external:all-day',
  sourceType: 'external_event',
  sourceId: 'all-day',
  title: 'Conference',
  startAt: '2026-05-10T00:00:00.000Z',
  endAt: '2026-05-11T00:00:00.000Z',
  isAllDay: true,
  visualType: 'external_event',
  source: { provider: 'google' }
} as any

describe('CalendarWeekView extra coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.selection = null
    mocks.isDragging = false
    mocks.dragContext = null
  })

  it('renders timed and all-day items, item actions, grid gestures, and today jumps', () => {
    const onSelectItem = vi.fn()
    const onDeleteItem = vi.fn()
    const onVisibleDayStartChange = vi.fn()

    const { rerender } = render(
      <CalendarWeekView
        anchorDate="2026-05-10"
        todayRequestKey={1}
        items={[timedItem, allDayItem]}
        selectedItemId="event-1"
        onSelectItem={onSelectItem}
        onDeleteItem={onDeleteItem}
        onVisibleDayStartChange={onVisibleDayStartChange}
      />
    )

    expect(screen.getByTestId('week-all-day-strip')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'chip:Planning' }))
    expect(onSelectItem).toHaveBeenCalledWith(timedItem, {
      x: 1,
      y: 2,
      width: 3,
      height: 4
    })

    fireEvent.click(screen.getByRole('button', { name: 'delete:Conference' }))
    expect(onDeleteItem).toHaveBeenCalledWith(allDayItem)

    const firstColumn = screen.getByTestId('calendar-week-scroll').querySelector('[data-day-index]')
    expect(firstColumn).not.toBeNull()
    fireEvent.mouseDown(firstColumn as HTMLElement)
    fireEvent.doubleClick(firstColumn as HTMLElement)
    expect(mocks.onMouseDown).toHaveBeenCalled()
    expect(mocks.onDoubleClick).toHaveBeenCalled()

    rerender(
      <CalendarWeekView
        anchorDate="2026-05-12"
        todayRequestKey={2}
        items={[timedItem]}
        selectedItemId={null}
      />
    )
    expect(mocks.scrollToDate).toHaveBeenCalled()
  })

  it('renders drag and settled marquee states and forwards quick-create actions', async () => {
    const onQuickSave = vi.fn()
    mocks.selection = {
      columnIndex: 0,
      top: 48,
      height: 96,
      startAt: '2026-05-10T01:00:00.000Z',
      endAt: '2026-05-10T03:00:00.000Z',
      anchorRect: { x: 10, y: 20, width: 100, height: 40 }
    }
    mocks.isDragging = true

    const { rerender } = render(
      <CalendarWeekView
        anchorDate="2026-05-10"
        items={[]}
        selectedItemId={null}
        onQuickSave={onQuickSave}
      />
    )

    expect(screen.getByText(/marquee:2026-05-10T01:00/)).toBeInTheDocument()

    mocks.isDragging = false
    rerender(
      <CalendarWeekView
        anchorDate="2026-05-10"
        items={[]}
        selectedItemId={null}
        onQuickSave={onQuickSave}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'quick save' }))
    expect(onQuickSave).toHaveBeenCalledWith({
      title: 'Quick',
      startAt: '2026-05-10T01:00:00.000Z',
      endAt: '2026-05-10T03:00:00.000Z'
    })
  })
})

describe('CalendarWeekView drop target wiring', () => {
  beforeEach(() => {
    droppableMocks.useDroppable.mockClear()
    droppableMocks.useDraggable.mockClear()
    mocks.dragContext = null
  })

  const expectedDates = [
    '2026-05-10',
    '2026-05-11',
    '2026-05-12',
    '2026-05-13',
    '2026-05-14',
    '2026-05-15',
    '2026-05-16'
  ]

  function droppableCalls(): Array<{ id: string; data: Record<string, unknown> }> {
    return droppableMocks.useDroppable.mock.calls.map(
      ([config]) => config as { id: string; data: Record<string, unknown> }
    )
  }

  it('registers each visible day column as a timed slot droppable with its own date and the view HOUR_HEIGHT', () => {
    render(
      <CalendarWeekView
        anchorDate="2026-05-10"
        items={[timedItem, allDayItem]}
        selectedItemId={null}
      />
    )

    const timedCalls = droppableCalls().filter(
      (call) => call.data.type === 'date' && call.data.timeBehavior === 'slot'
    )

    expect(timedCalls.map((call) => call.data.dateKey).sort()).toEqual([...expectedDates].sort())
    for (const call of timedCalls) {
      expect(call.data.hourHeight).toBe(48)
    }

    const may10 = timedCalls.find((call) => call.data.dateKey === '2026-05-10')
    expect(may10).toBeDefined()
    expect(may10?.id).toBe('calendar-timed-column:2026-05-10')
  })

  it('registers each all-day cell with timeBehavior "clear" so a dropped task loses its time', () => {
    render(
      <CalendarWeekView
        anchorDate="2026-05-10"
        items={[timedItem, allDayItem]}
        selectedItemId={null}
      />
    )

    const allDayCalls = droppableCalls().filter(
      (call) => call.data.type === 'date' && 'dueTime' in call.data
    )

    expect(allDayCalls.map((call) => call.data.dateKey).sort()).toEqual([...expectedDates].sort())
    const may10 = allDayCalls.find((call) => call.data.dateKey === '2026-05-10')
    expect(may10).toBeDefined()
    expect(may10?.data.dueTime).toBeNull()
    expect(may10?.id).toBe('calendar-date:2026-05-10:clear')
  })
})

describe('CalendarWeekView all-day strip reveal during task drag', () => {
  beforeEach(() => {
    droppableMocks.useDroppable.mockClear()
    droppableMocks.useDraggable.mockClear()
    mocks.dragContext = null
  })

  function droppableCalls(): Array<{ id: string; data: Record<string, unknown> }> {
    return droppableMocks.useDroppable.mock.calls.map(
      ([config]) => config as { id: string; data: Record<string, unknown> }
    )
  }

  it('does not render the all-day strip when idle and there are no all-day items', () => {
    render(<CalendarWeekView anchorDate="2026-05-10" items={[timedItem]} selectedItemId={null} />)

    expect(screen.queryByTestId('week-all-day-strip')).not.toBeInTheDocument()
    expect(droppableCalls().some((call) => 'dueTime' in call.data)).toBe(false)
  })

  it('reveals the all-day strip with a droppable cell per visible day when a task drag is in flight, even with no all-day items', () => {
    mocks.dragContext = { dragState: { isDragging: true } }

    render(<CalendarWeekView anchorDate="2026-05-10" items={[timedItem]} selectedItemId={null} />)

    expect(screen.getByTestId('week-all-day-strip')).toBeInTheDocument()

    const allDayCalls = droppableCalls().filter(
      (call) => call.data.type === 'date' && 'dueTime' in call.data
    )
    const expectedDates = [
      '2026-05-10',
      '2026-05-11',
      '2026-05-12',
      '2026-05-13',
      '2026-05-14',
      '2026-05-15',
      '2026-05-16'
    ]
    expect(allDayCalls.map((call) => call.data.dateKey).sort()).toEqual([...expectedDates].sort())
  })
})
