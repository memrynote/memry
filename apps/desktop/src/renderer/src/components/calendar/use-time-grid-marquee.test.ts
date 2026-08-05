import { describe, expect, it, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { RefObject } from 'react'
import {
  pixelToSnappedMinutes,
  minutesToTimeString,
  selectionFromDrag,
  useTimeGridMarquee
} from './use-time-grid-marquee'

const HOUR_HEIGHT = 96
const SNAP_MINUTES = 15

describe('pixelToSnappedMinutes', () => {
  it('snaps 0px to 0 minutes (midnight)', () => {
    expect(pixelToSnappedMinutes(0, HOUR_HEIGHT, SNAP_MINUTES)).toBe(0)
  })

  it('snaps 96px to 60 minutes (1:00 AM)', () => {
    expect(pixelToSnappedMinutes(96, HOUR_HEIGHT, SNAP_MINUTES)).toBe(60)
  })

  it('snaps 48px to 30 minutes (0:30 AM)', () => {
    expect(pixelToSnappedMinutes(48, HOUR_HEIGHT, SNAP_MINUTES)).toBe(30)
  })

  it('snaps 36px to 30 minutes (22.5min rounds up to nearest 15min boundary)', () => {
    expect(pixelToSnappedMinutes(36, HOUR_HEIGHT, SNAP_MINUTES)).toBe(30)
  })

  it('snaps 20px to 15 minutes (rounds to nearest)', () => {
    expect(pixelToSnappedMinutes(20, HOUR_HEIGHT, SNAP_MINUTES)).toBe(15)
  })

  it('clamps negative values to 0', () => {
    expect(pixelToSnappedMinutes(-50, HOUR_HEIGHT, SNAP_MINUTES)).toBe(0)
  })

  it('clamps above 23:45 (1425 minutes)', () => {
    expect(pixelToSnappedMinutes(9999, HOUR_HEIGHT, SNAP_MINUTES)).toBe(1425)
  })
})

describe('minutesToTimeString', () => {
  it('converts 0 to 00:00', () => {
    expect(minutesToTimeString(0)).toBe('00:00')
  })

  it('converts 90 to 01:30', () => {
    expect(minutesToTimeString(90)).toBe('01:30')
  })

  it('converts 1425 to 23:45', () => {
    expect(minutesToTimeString(1425)).toBe('23:45')
  })
})

describe('selectionFromDrag', () => {
  it('returns start < end when dragging downward', () => {
    // 96px = 60min (1:00), 192px = 120min (2:00)
    const result = selectionFromDrag(96, 192, HOUR_HEIGHT, SNAP_MINUTES)
    expect(result.startMinutes).toBe(60)
    expect(result.endMinutes).toBe(120)
  })

  it('swaps when dragging upward (end < start)', () => {
    const result = selectionFromDrag(192, 96, HOUR_HEIGHT, SNAP_MINUTES)
    expect(result.startMinutes).toBe(60)
    expect(result.endMinutes).toBe(120)
  })

  it('enforces minimum 15min duration when start equals end', () => {
    const result = selectionFromDrag(96, 96, HOUR_HEIGHT, SNAP_MINUTES)
    expect(result.startMinutes).toBe(60)
    expect(result.endMinutes).toBe(75)
  })

  it('returns pixel top and height', () => {
    // 96px=60min, 288px=180min → span=120min → height=120*(96/60)=192px
    const result = selectionFromDrag(96, 288, HOUR_HEIGHT, SNAP_MINUTES)
    expect(result.top).toBe(96) // 60min * (96/60) = 96px
    expect(result.height).toBe(192) // 120min * (96/60) = 192px
  })
})

function createMockGridRef(rect: Partial<DOMRect> = {}): RefObject<HTMLDivElement | null> {
  const element = {
    getBoundingClientRect: () => ({
      top: 0,
      left: 0,
      right: 500,
      bottom: 2304,
      width: 500,
      height: 2304,
      x: 0,
      y: 0,
      toJSON: () => ({}),
      ...rect
    }),
    scrollTop: 0,
    contains: () => true
  } as unknown as HTMLDivElement
  return { current: element }
}

describe('useTimeGridMarquee', () => {
  it('starts with no selection', () => {
    const ref = createMockGridRef()
    const { result } = renderHook(() =>
      useTimeGridMarquee({ gridRef: ref, dateForColumn: () => '2026-04-14' })
    )
    expect(result.current.selection).toBeNull()
    expect(result.current.isDragging).toBe(false)
  })

  it('creates 1-hour selection on double-click', () => {
    const ref = createMockGridRef()
    const { result } = renderHook(() =>
      useTimeGridMarquee({ gridRef: ref, dateForColumn: () => '2026-04-14' })
    )
    // 432px = 9 hours * 48px/hour = 9:00 AM
    const event = {
      clientY: 432,
      clientX: 250,
      target: ref.current,
      preventDefault: vi.fn()
    } as unknown as React.MouseEvent
    act(() => {
      result.current.handlers.onDoubleClick(event, 0)
    })
    expect(result.current.selection).not.toBeNull()
    expect(result.current.selection!.startAt).toBe('2026-04-14T09:00')
    expect(result.current.selection!.endAt).toBe('2026-04-14T10:00')
  })

  it('clears selection via clearSelection()', () => {
    const ref = createMockGridRef()
    const { result } = renderHook(() =>
      useTimeGridMarquee({ gridRef: ref, dateForColumn: () => '2026-04-14' })
    )
    const event = {
      clientY: 864,
      clientX: 250,
      target: ref.current,
      preventDefault: vi.fn()
    } as unknown as React.MouseEvent
    act(() => {
      result.current.handlers.onDoubleClick(event, 0)
    })
    expect(result.current.selection).not.toBeNull()
    act(() => {
      result.current.clearSelection()
    })
    expect(result.current.selection).toBeNull()
  })

  it('ignores non-left clicks and clicks starting on event chips', () => {
    const ref = createMockGridRef()
    const { result } = renderHook(() =>
      useTimeGridMarquee({ gridRef: ref, dateForColumn: () => '2026-04-14' })
    )
    const chip = document.createElement('button')
    chip.dataset.visualType = 'event'

    act(() => {
      result.current.handlers.onMouseDown({
        button: 1,
        clientY: 96,
        target: ref.current,
        preventDefault: vi.fn()
      } as unknown as React.MouseEvent)
      result.current.handlers.onMouseDown({
        button: 0,
        clientY: 96,
        target: chip,
        preventDefault: vi.fn()
      } as unknown as React.MouseEvent)
    })

    expect(result.current.isDragging).toBe(false)
    expect(result.current.selection).toBeNull()
  })

  it('tracks drag selection, column fallback geometry, autoscroll, and mouseup cleanup', () => {
    vi.useFakeTimers()
    const rafCallbacks: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      rafCallbacks.push(callback)
      return rafCallbacks.length
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const grid = document.createElement('div')
    Object.defineProperty(grid, 'scrollTop', { value: 10, writable: true })
    grid.getBoundingClientRect = vi.fn(
      () =>
        ({
          top: 100,
          left: 20,
          bottom: 300,
          right: 420,
          width: 400,
          height: 200,
          x: 20,
          y: 100,
          toJSON: () => ({})
        }) as DOMRect
    )
    const gutter = document.createElement('div')
    const column = document.createElement('div')
    column.getBoundingClientRect = vi.fn(
      () =>
        ({
          top: 100,
          left: 120,
          bottom: 300,
          right: 220,
          width: 100,
          height: 200,
          x: 120,
          y: 100,
          toJSON: () => ({})
        }) as DOMRect
    )
    grid.append(gutter, column)
    const ref = { current: grid } as React.RefObject<HTMLDivElement | null>
    const { result, unmount } = renderHook(() =>
      useTimeGridMarquee({
        gridRef: ref,
        dateForColumn: (index) => `2026-04-${String(14 + index).padStart(2, '0')}`,
        columnCount: 2
      })
    )

    act(() => {
      result.current.handlers.onMouseDown(
        {
          button: 0,
          clientY: 148,
          target: grid,
          preventDefault: vi.fn()
        } as unknown as React.MouseEvent,
        0
      )
    })
    expect(result.current.isDragging).toBe(true)

    act(() => {
      document.dispatchEvent(new MouseEvent('mousemove', { clientY: 296 }))
    })
    expect(result.current.selection).toEqual(
      expect.objectContaining({
        date: '2026-04-14',
        startAt: '2026-04-14T01:15',
        endAt: '2026-04-14T04:15',
        columnIndex: 0,
        anchorRect: expect.objectContaining({ x: 120, width: 100 })
      })
    )
    expect(rafCallbacks.length).toBeGreaterThan(0)

    act(() => {
      rafCallbacks.at(-1)?.(0)
      document.dispatchEvent(new MouseEvent('mouseup'))
    })
    expect(result.current.isDragging).toBe(false)
    expect(result.current.selection).not.toBeNull()

    unmount()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('anchors on the column offset when the column element cannot be measured', () => {
    // Week view renders an infinitely virtualized day strip: the grid element is
    // ~4.5M px wide and, once scrolled to today, its own left edge sits ~2.5M px
    // outside the window. Falling back to that edge put the quick-create popover
    // off-window entirely, so its Save button was unclickable.
    const COLUMN_WIDTH = 125
    const COLUMN_COUNT = 36_525
    const TODAY_INDEX = 20_671
    const GRID_LEFT = 304 - 20_670 * COLUMN_WIDTH

    const grid = document.createElement('div')
    Object.defineProperty(grid, 'scrollTop', { value: 0, writable: true })
    grid.getBoundingClientRect = vi.fn(
      () =>
        ({
          top: 100,
          left: GRID_LEFT,
          bottom: 1252,
          right: GRID_LEFT + COLUMN_WIDTH * COLUMN_COUNT,
          width: COLUMN_WIDTH * COLUMN_COUNT,
          height: 1152,
          x: GRID_LEFT,
          y: 100,
          toJSON: () => ({})
        }) as DOMRect
    )
    const ref = { current: grid } as React.RefObject<HTMLDivElement | null>
    const { result } = renderHook(() =>
      useTimeGridMarquee({
        gridRef: ref,
        dateForColumn: () => '2026-08-06',
        columnCount: COLUMN_COUNT,
        // The virtualizer had not rendered this column yet.
        getColumnElement: () => null
      })
    )

    act(() => {
      result.current.handlers.onDoubleClick(
        { clientY: 196, target: grid, preventDefault: vi.fn() } as unknown as React.MouseEvent,
        TODAY_INDEX
      )
    })

    expect(result.current.selection!.anchorRect).toEqual(
      expect.objectContaining({ x: 429, width: COLUMN_WIDTH })
    )
  })

  it('clears click-only drags on mouseup', () => {
    const ref = createMockGridRef()
    const { result } = renderHook(() =>
      useTimeGridMarquee({ gridRef: ref, dateForColumn: () => '2026-04-14' })
    )

    act(() => {
      result.current.handlers.onMouseDown(
        {
          button: 0,
          clientY: 96,
          target: ref.current,
          preventDefault: vi.fn()
        } as unknown as React.MouseEvent,
        0
      )
    })
    expect(result.current.isDragging).toBe(true)

    act(() => {
      document.dispatchEvent(new MouseEvent('mouseup'))
    })

    expect(result.current.isDragging).toBe(false)
    expect(result.current.selection).toBeNull()
  })
})
