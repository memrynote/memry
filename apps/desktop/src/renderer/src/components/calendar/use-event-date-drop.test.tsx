import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { DragEndEvent } from '@dnd-kit/core'
import { eventTimesOnDate, useEventDateDrop } from './use-event-date-drop'
import { localInputToIso } from './date-utils'
import type { CalendarProjectionItem } from '@/services/calendar-service'

const dnd = vi.hoisted(() => ({ onDragEnd: null as ((e: DragEndEvent) => void) | null }))

vi.mock('@dnd-kit/core', () => ({
  useDndMonitor: (handlers: { onDragEnd: (e: DragEndEvent) => void }) => {
    dnd.onDragEnd = handlers.onDragEnd
  }
}))

const iso = (local: string, allDay = false) => localInputToIso(local, allDay)

const makeEvent = (overrides: Partial<CalendarProjectionItem> = {}): CalendarProjectionItem =>
  ({
    projectionId: 'event:e1',
    sourceType: 'event',
    sourceId: 'e1',
    title: 'Standup',
    startAt: iso('2026-07-15T09:30'),
    endAt: iso('2026-07-15T10:15'),
    isAllDay: false,
    visualType: 'event',
    editability: { canMove: true, canResize: true, canEditText: true, canDelete: true },
    ...overrides
  }) as CalendarProjectionItem

// Shapes mirror draggable-task-chip's event payload and the calendar droppables.
function drop(item: CalendarProjectionItem, over: Record<string, unknown> | null) {
  dnd.onDragEnd?.({
    active: { id: `canvas-event:${item.sourceId}`, data: { current: { calendarItem: item } } },
    over: over ? { id: 'cell', data: { current: over } } : null
  } as unknown as DragEndEvent)
}

const monthCell = (dateKey: string) => ({ type: 'date', dateKey, date: new Date() })

describe('eventTimesOnDate', () => {
  it('moves a timed event to another day keeping its time and duration', () => {
    expect(eventTimesOnDate(makeEvent(), '2026-07-20')).toEqual({
      startAt: iso('2026-07-20T09:30'),
      endAt: iso('2026-07-20T10:15')
    })
  })

  it('moves a multi-day all-day event keeping its span', () => {
    const item = makeEvent({
      isAllDay: true,
      startAt: iso('2026-07-15', true),
      endAt: iso('2026-07-18', true)
    })
    expect(eventTimesOnDate(item, '2026-08-01')).toEqual({
      startAt: iso('2026-08-01', true),
      endAt: iso('2026-08-04', true)
    })
  })

  it('returns null when the event already starts on the target day', () => {
    expect(eventTimesOnDate(makeEvent(), '2026-07-15')).toBeNull()
  })
})

describe('useEventDateDrop', () => {
  it('commits an event dropped on a month or all-day cell', () => {
    const onMove = vi.fn()
    renderHook(() => {
      useEventDateDrop(onMove)
    })
    const item = makeEvent()

    drop(item, monthCell('2026-07-16'))

    expect(onMove).toHaveBeenCalledWith(item, iso('2026-07-16T09:30'), iso('2026-07-16T10:15'))
  })

  it('ignores read-only events, time-grid columns and empty drops', () => {
    const onMove = vi.fn()
    renderHook(() => {
      useEventDateDrop(onMove)
    })

    drop(
      makeEvent({
        sourceType: 'external_event',
        editability: { canMove: false, canResize: false, canEditText: false, canDelete: false }
      }),
      monthCell('2026-07-16')
    )
    drop(makeEvent(), { ...monthCell('2026-07-16'), timeBehavior: 'slot' })
    drop(makeEvent(), null)

    expect(onMove).not.toHaveBeenCalled()
  })
})
