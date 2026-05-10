import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useTaskOrder } from './use-task-order'
import type { Task } from '@/data/task-model'

const task = (id: string): Task => ({ id, title: id }) as Task

describe('useTaskOrder', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
  })

  it('returns tasks unchanged until a manual order is set, then appends new tasks', () => {
    const { result } = renderHook(() => useTaskOrder({ persist: false }))
    const tasks = [task('a'), task('b'), task('c')]

    expect(result.current.getOrderedTasks('today', tasks).map((t) => t.id)).toEqual(['a', 'b', 'c'])

    act(() => result.current.setOrder('today', ['c', 'a']))

    expect(result.current.isManuallyOrdered).toBe(true)
    expect(result.current.getOrder('today')).toEqual(['c', 'a'])
    expect(result.current.getOrderedTasks('today', tasks).map((t) => t.id)).toEqual(['c', 'a', 'b'])
  })

  it('moves tasks up, down, to top, and to bottom without crossing boundaries', () => {
    const { result } = renderHook(() => useTaskOrder({ persist: false }))

    act(() => result.current.setOrder('today', ['a', 'b', 'c']))
    act(() => result.current.moveTask('today', 'b', 'up'))
    expect(result.current.getOrder('today')).toEqual(['b', 'a', 'c'])

    act(() => result.current.moveTask('today', 'b', 'up'))
    expect(result.current.getOrder('today')).toEqual(['b', 'a', 'c'])

    act(() => result.current.moveTask('today', 'a', 'down'))
    expect(result.current.getOrder('today')).toEqual(['b', 'c', 'a'])

    act(() => result.current.moveToTop('today', 'a'))
    expect(result.current.getOrder('today')).toEqual(['a', 'b', 'c'])

    act(() => result.current.moveToBottom('today', 'a'))
    expect(result.current.getOrder('today')).toEqual(['b', 'c', 'a'])
  })

  it('applies section updates, clears one section, and clears all sections', () => {
    const { result } = renderHook(() => useTaskOrder({ persist: false }))

    act(() =>
      result.current.applyOrderUpdates({
        today: ['a', 'b'],
        upcoming: ['c']
      })
    )

    expect(result.current.getOrder('today')).toEqual(['a', 'b'])
    expect(result.current.getOrder('upcoming')).toEqual(['c'])

    act(() => result.current.applyOrderUpdates({ today: null }))
    expect(result.current.getOrder('today')).toBeUndefined()
    expect(result.current.isManuallyOrdered).toBe(true)

    act(() => result.current.clearOrder())
    expect(result.current.getOrder('upcoming')).toBeUndefined()
    expect(result.current.isManuallyOrdered).toBe(false)
  })

  it('reorders by drag from existing order or task list fallback', () => {
    const { result } = renderHook(() => useTaskOrder({ persist: false }))
    const tasks = [task('a'), task('b'), task('c')]

    act(() => result.current.reorderByDrag('today', 'c', 'a', tasks))
    expect(result.current.getOrder('today')).toEqual(['c', 'a', 'b'])

    act(() => result.current.reorderByDrag('today', 'x', 'a', tasks))
    expect(result.current.getOrder('today')).toEqual(['c', 'x', 'a', 'b'])

    act(() => result.current.reorderByDrag('today', 'x', 'missing', tasks))
    expect(result.current.getOrder('today')).toEqual(['c', 'x', 'a', 'b'])
  })

  it('persists and restores section orders with a storage key prefix', () => {
    const first = renderHook(() => useTaskOrder({ storageKeyPrefix: 'vault-a' }))

    act(() => first.result.current.setOrder('today', ['b', 'a']))
    first.unmount()

    const second = renderHook(() => useTaskOrder({ storageKeyPrefix: 'vault-a' }))

    expect(second.result.current.getOrder('today')).toEqual(['b', 'a'])
    expect(second.result.current.isManuallyOrdered).toBe(true)
  })
})
