import { describe, expect, it, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { RefObject } from 'react'
import {
  snapMinutes,
  clampStartWithinDay,
  isoFromDayMinutes,
  computeMovedTimes,
  computeResizedTimes,
  isEventMovable,
  isEventResizable,
  useEventDrag,
  MINUTES_IN_DAY
} from './use-event-drag'
import type { CalendarProjectionItem } from '@/services/calendar-service'

const SNAP = 15

function makeEvent(overrides: Partial<CalendarProjectionItem> = {}): CalendarProjectionItem {
  return {
    projectionId: 'event:e1',
    sourceType: 'event',
    sourceId: 'e1',
    title: 'Standup',
    descriptionPreview: null,
    startAt: '2026-04-14T09:00:00.000Z',
    endAt: '2026-04-14T10:00:00.000Z',
    isAllDay: false,
    timezone: 'UTC',
    visualType: 'event',
    editability: { canMove: true, canResize: true, canEditText: true, canDelete: true },
    source: { provider: null, isMemryManaged: true, calendarSourceId: null } as never,
    binding: null,
    snoozeOffsetMinutes: null,
    ...overrides
  } as CalendarProjectionItem
}

function minutesLocal(iso: string): number {
  const d = new Date(iso)
  return d.getHours() * 60 + d.getMinutes()
}

describe('snapMinutes', () => {
  it('rounds to nearest snap increment', () => {
    expect(snapMinutes(0, SNAP)).toBe(0)
    expect(snapMinutes(7, SNAP)).toBe(0)
    expect(snapMinutes(8, SNAP)).toBe(15)
    expect(snapMinutes(98, SNAP)).toBe(105)
  })
})

describe('clampStartWithinDay', () => {
  it('keeps the event inside the day', () => {
    expect(clampStartWithinDay(-30, 60)).toBe(0)
    expect(clampStartWithinDay(1400, 60)).toBe(MINUTES_IN_DAY - 60) // 1380
    expect(clampStartWithinDay(600, 60)).toBe(600)
  })
})

describe('isoFromDayMinutes', () => {
  it('round-trips a local time of day', () => {
    expect(minutesLocal(isoFromDayMinutes('2026-04-14', 540))).toBe(540) // 09:00
  })

  it('rolls a full day (1440) into next-day midnight', () => {
    const iso = isoFromDayMinutes('2026-04-14', MINUTES_IN_DAY)
    const d = new Date(iso)
    expect(d.getHours()).toBe(0)
    expect(d.getDate()).toBe(15)
  })
})

describe('computeMovedTimes', () => {
  it('shifts start by snapped delta, preserving duration', () => {
    // start 540 (09:00), 60min duration, +35min drag → snaps to +30 → 570 (09:30)
    const r = computeMovedTimes(540, 60, 35, SNAP, '2026-04-14')
    expect(r.startMin).toBe(570)
    expect(r.endMin).toBe(630)
  })

  it('clamps so the event cannot spill past midnight', () => {
    const r = computeMovedTimes(1380, 60, 120, SNAP, '2026-04-14') // would be 25:00
    expect(r.startMin).toBe(MINUTES_IN_DAY - 60)
    expect(r.endMin).toBe(MINUTES_IN_DAY)
  })

  it('moves to the target date for cross-day drags', () => {
    const r = computeMovedTimes(540, 60, 0, SNAP, '2026-04-16')
    expect(new Date(r.startAt).getDate()).toBe(16)
    expect(minutesLocal(r.startAt)).toBe(540)
  })
})

describe('computeResizedTimes', () => {
  it('moves the start edge but never within 15min of the end', () => {
    const r = computeResizedTimes(540, 600, 90, 'start', SNAP, '2026-04-14') // pushed past end
    expect(r.startMin).toBe(600 - SNAP)
    expect(r.endMin).toBe(600)
  })

  it('moves the end edge but never within 15min of the start', () => {
    const r = computeResizedTimes(540, 600, -120, 'end', SNAP, '2026-04-14') // pulled past start
    expect(r.endMin).toBe(540 + SNAP)
    expect(r.startMin).toBe(540)
  })

  it('extends the end edge by snapped delta', () => {
    const r = computeResizedTimes(540, 600, 40, 'end', SNAP, '2026-04-14')
    expect(r.endMin).toBe(645) // 600 + snapped(40)=45
  })
})

describe('eligibility guards', () => {
  it('only native timed events are movable/resizable', () => {
    expect(isEventMovable(makeEvent())).toBe(true)
    expect(isEventResizable(makeEvent())).toBe(true)
    expect(isEventMovable(makeEvent({ isAllDay: true }))).toBe(false)
    expect(isEventMovable(makeEvent({ sourceType: 'task', visualType: 'task' }))).toBe(false)
    expect(
      isEventResizable(
        makeEvent({
          editability: { canMove: true, canResize: false, canEditText: true, canDelete: true }
        })
      )
    ).toBe(false)
  })
})

function mockGridRef(): RefObject<HTMLDivElement | null> {
  const el = {
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 700, height: 1152 }) as DOMRect
  } as unknown as HTMLDivElement
  return { current: el }
}

describe('useEventDrag', () => {
  it('ignores non-event chips and never commits', () => {
    const onCommit = vi.fn()
    const { result } = renderHook(() =>
      useEventDrag({ gridRef: mockGridRef(), dateForColumn: () => '2026-04-14', onCommit })
    )
    act(() => {
      result.current.startMove(
        {
          button: 0,
          clientX: 10,
          clientY: 10,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn()
        } as never,
        makeEvent({ sourceType: 'task', visualType: 'task' }),
        0
      )
    })
    expect(result.current.drag).toBeNull()
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('commits new times after a move drag and suppresses the trailing click', async () => {
    const onCommit = vi.fn().mockResolvedValue(undefined)
    const { result } = renderHook(() =>
      useEventDrag({ gridRef: mockGridRef(), dateForColumn: () => '2026-04-14', onCommit })
    )
    act(() => {
      result.current.startMove(
        {
          button: 0,
          clientX: 100,
          clientY: 100,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn()
        } as never,
        makeEvent(),
        0
      )
    })
    // Drag down 48px = +60min, past the 4px threshold.
    act(() => {
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 100, clientY: 148 }))
    })
    expect(result.current.drag).not.toBeNull()
    await act(async () => {
      document.dispatchEvent(new MouseEvent('mouseup'))
    })
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(result.current.wasDragged()).toBe(true)
    // read-and-clear
    expect(result.current.wasDragged()).toBe(false)
  })

  it('treats a click without movement as a plain click (no commit, no suppression)', () => {
    const onCommit = vi.fn()
    const { result } = renderHook(() =>
      useEventDrag({ gridRef: mockGridRef(), dateForColumn: () => '2026-04-14', onCommit })
    )
    act(() => {
      result.current.startMove(
        {
          button: 0,
          clientX: 100,
          clientY: 100,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn()
        } as never,
        makeEvent(),
        0
      )
      document.dispatchEvent(new MouseEvent('mouseup'))
    })
    expect(onCommit).not.toHaveBeenCalled()
    expect(result.current.wasDragged()).toBe(false)
  })
})
