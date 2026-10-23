import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { clearTaskOrderForVault, taskOrderStorageKey, useTaskOrder } from './use-task-order'
import { VaultScopeProvider } from '@/contexts/vault-scope'
import type { Task } from '@/data/task-model'

const inVault =
  (vaultPath: string) =>
  ({ children }: { children: ReactNode }) => (
    <VaultScopeProvider vaultPath={vaultPath}>{children}</VaultScopeProvider>
  )

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

  it('keeps independent orders for two mounted vault scopes', () => {
    const a = renderHook(() => useTaskOrder(), { wrapper: inVault('/vaults/a') })
    const b = renderHook(() => useTaskOrder(), { wrapper: inVault('/vaults/b') })

    act(() => a.result.current.setOrder('today', ['a1', 'a2']))
    act(() => b.result.current.setOrder('today', ['b1', 'b2']))

    expect(JSON.parse(localStorage.getItem('task-orders:/vaults/a')!).orders.today).toEqual([
      'a1',
      'a2'
    ])
    expect(JSON.parse(localStorage.getItem('task-orders:/vaults/b')!).orders.today).toEqual([
      'b1',
      'b2'
    ])
    expect(localStorage.getItem('task-orders')).toBeNull()

    a.unmount()
    b.unmount()

    const reopenedA = renderHook(() => useTaskOrder(), { wrapper: inVault('/vaults/a') })
    expect(reopenedA.result.current.getOrder('today')).toEqual(['a1', 'a2'])
  })

  it('falls back to the legacy unscoped key for a vault without its own entry', () => {
    const legacy = JSON.stringify({ orders: { today: ['x', 'y'] } })
    localStorage.setItem('task-orders', legacy)
    localStorage.setItem('task-orders:/vaults/b', JSON.stringify({ orders: { today: ['b1'] } }))

    const a = renderHook(() => useTaskOrder(), { wrapper: inVault('/vaults/a') })
    const b = renderHook(() => useTaskOrder(), { wrapper: inVault('/vaults/b') })

    expect(a.result.current.getOrder('today')).toEqual(['x', 'y'])
    expect(a.result.current.isManuallyOrdered).toBe(true)
    expect(b.result.current.getOrder('today')).toEqual(['b1'])

    // Adopted into the vault's own key; legacy key untouched.
    expect(JSON.parse(localStorage.getItem('task-orders:/vaults/a')!).orders.today).toEqual([
      'x',
      'y'
    ])
    act(() => a.result.current.setOrder('today', ['y', 'x']))
    expect(localStorage.getItem('task-orders')).toBe(legacy)
  })

  it('uses the unscoped key outside a vault scope', () => {
    const { result } = renderHook(() => useTaskOrder())
    act(() => result.current.setOrder('today', ['a']))
    expect(JSON.parse(localStorage.getItem('task-orders')!).orders.today).toEqual(['a'])
  })

  it('clears only the removed vault entry', () => {
    localStorage.setItem('task-orders', '{"orders":{}}')
    localStorage.setItem(taskOrderStorageKey('/vaults/a'), '{"orders":{}}')
    localStorage.setItem(taskOrderStorageKey('/vaults/b'), '{"orders":{}}')

    clearTaskOrderForVault('/vaults/a')

    expect(localStorage.getItem('task-orders:/vaults/a')).toBeNull()
    expect(localStorage.getItem('task-orders:/vaults/b')).not.toBeNull()
    expect(localStorage.getItem('task-orders')).not.toBeNull()
  })
})
