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
  clearSelection: vi.fn()
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
  CalendarQuickCreateDialog: ({ startAt, endAt, onSave, onOpenFullEditor, onDismiss }: any) => (
    <div role="dialog" aria-label="quick create">
      <button type="button" onClick={() => onSave({ title: 'Quick', startAt, endAt })}>
        quick save
      </button>
      <button type="button" onClick={() => onOpenFullEditor({ startAt, endAt })}>
        quick full
      </button>
      <button type="button" onClick={onDismiss}>
        quick dismiss
      </button>
    </div>
  )
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
    const onCreateEventWithRange = vi.fn()
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
        onCreateEventWithRange={onCreateEventWithRange}
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
        onCreateEventWithRange={onCreateEventWithRange}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'quick save' }))
    expect(onQuickSave).toHaveBeenCalledWith({
      title: 'Quick',
      startAt: '2026-05-10T01:00:00.000Z',
      endAt: '2026-05-10T03:00:00.000Z'
    })
    fireEvent.click(screen.getByRole('button', { name: 'quick full' }))
    expect(onCreateEventWithRange).toHaveBeenCalledWith(
      '2026-05-10T01:00:00.000Z',
      '2026-05-10T03:00:00.000Z',
      false,
      { x: 10, y: 20, width: 100, height: 40 }
    )
  })
})
