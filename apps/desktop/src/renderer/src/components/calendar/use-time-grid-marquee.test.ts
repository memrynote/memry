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
    // 864px = 9 hours * 96px/hour = 9:00 AM
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
})
