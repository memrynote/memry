import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// dnd-kit types `useDroppable({ data })` as `Data<T> = T & AnyData` — effectively
// untyped — so `tsc` gives no structural protection on the shape this hook builds.
// Mock `useDroppable` to capture exactly what config it was called with, so these
// tests can assert on the real invariant: whether `dueTime` is present or absent.
const droppableMocks = vi.hoisted(() => ({
  useDroppable: vi.fn((_config: unknown) => ({
    setNodeRef: vi.fn(),
    isOver: false
  }))
}))

vi.mock('@dnd-kit/core', () => ({
  useDroppable: droppableMocks.useDroppable
}))

import { useCalendarDateDroppable } from './use-calendar-date-droppable'

interface DroppableData {
  type: string
  date: Date
  dateKey: string
  dueTime?: string | null
}

interface DroppableConfig {
  id: string
  data: DroppableData
}

function lastConfig(): DroppableConfig {
  const call = droppableMocks.useDroppable.mock.calls.at(-1)
  if (!call) throw new Error('useDroppable was not called')
  return call[0] as DroppableConfig
}

describe('useCalendarDateDroppable', () => {
  beforeEach(() => {
    droppableMocks.useDroppable.mockClear()
  })

  it('omits dueTime entirely for "preserve" (month cell keeps the task\'s time)', () => {
    renderHook(() => useCalendarDateDroppable({ date: '2026-07-16', timeBehavior: 'preserve' }))

    const { data } = lastConfig()
    expect(Object.prototype.hasOwnProperty.call(data, 'dueTime')).toBe(false)
    expect('dueTime' in data).toBe(false)
  })

  it('sets dueTime to null for "clear" (all-day cell clears the task\'s time)', () => {
    renderHook(() => useCalendarDateDroppable({ date: '2026-07-16', timeBehavior: 'clear' }))

    const { data } = lastConfig()
    expect(Object.prototype.hasOwnProperty.call(data, 'dueTime')).toBe(true)
    expect('dueTime' in data).toBe(true)
    expect(data.dueTime).toBeNull()
  })

  it('omits dueTime entirely for "slot" (timed column resolves the time at drop)', () => {
    renderHook(() => useCalendarDateDroppable({ date: '2026-07-16', timeBehavior: 'slot' }))

    const { data } = lastConfig()
    expect(Object.prototype.hasOwnProperty.call(data, 'dueTime')).toBe(false)
    expect('dueTime' in data).toBe(false)
  })

  it('carries date as a real Date instance (not a string) and dateKey as the original key', () => {
    renderHook(() => useCalendarDateDroppable({ date: '2026-07-16', timeBehavior: 'preserve' }))

    const { data } = lastConfig()
    expect(data.date).toBeInstanceOf(Date)
    expect(typeof data.date).not.toBe('string')
    expect(data.date.getFullYear()).toBe(2026)
    expect(data.date.getMonth()).toBe(6) // July is month index 6
    expect(data.date.getDate()).toBe(16)
    expect(data.dateKey).toBe('2026-07-16')
    expect(typeof data.dateKey).toBe('string')
  })

  it('registers a per-cell id keyed by date and timeBehavior, and forwards droppable state', () => {
    const { result } = renderHook(() =>
      useCalendarDateDroppable({ date: '2026-07-16', timeBehavior: 'clear' })
    )

    const config = lastConfig()
    expect(config.id).toBe('calendar-date:2026-07-16:clear')
    expect(config.data.type).toBe('date')
    expect(result.current.setNodeRef).toEqual(expect.any(Function))
    expect(result.current.isOver).toBe(false)
  })
})
