import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useResolvedEntityId } from './use-resolved-entity-id'

describe('useResolvedEntityId', () => {
  const onMissing = vi.fn()

  beforeEach(() => {
    onMissing.mockClear()
  })

  it('keeps an id that resolves', () => {
    const { result } = renderHook(() =>
      useResolvedEntityId({ id: 'task-1', exists: true, ready: true, onMissing })
    )

    expect(result.current).toBe('task-1')
    expect(onMissing).not.toHaveBeenCalled()
  })

  it('drops an id that no longer resolves and asks the owner to clear it', () => {
    const { result } = renderHook(() =>
      useResolvedEntityId({ id: 'task-gone', exists: false, ready: true, onMissing })
    )

    // Dropped in the SAME render: the drawer must never open onto a missing
    // entity, not even for one frame — its close button lives inside the
    // `entity && …` branch, so that frame is unescapable.
    expect(result.current).toBeNull()
    expect(onMissing).toHaveBeenCalledTimes(1)
  })

  it('keeps the id while the data it resolves against is still loading', () => {
    const { result, rerender } = renderHook(
      (props: { exists: boolean; ready: boolean }) =>
        useResolvedEntityId({ id: 'task-1', ...props, onMissing }),
      { initialProps: { exists: false, ready: false } }
    )

    // An empty list mid-fetch is not proof the task is gone.
    expect(result.current).toBe('task-1')
    expect(onMissing).not.toHaveBeenCalled()

    rerender({ exists: true, ready: true })
    expect(result.current).toBe('task-1')
    expect(onMissing).not.toHaveBeenCalled()
  })

  it('does nothing when there is no id to validate', () => {
    const { result } = renderHook(() =>
      useResolvedEntityId({ id: null, exists: false, ready: true, onMissing })
    )

    expect(result.current).toBeNull()
    expect(onMissing).not.toHaveBeenCalled()
  })

  it('clears once, not on every render, while the id stays missing', () => {
    const { rerender } = renderHook(() =>
      useResolvedEntityId({ id: 'task-gone', exists: false, ready: true, onMissing })
    )

    rerender()
    rerender()

    expect(onMissing).toHaveBeenCalledTimes(1)
  })

  it('re-clears when a different id goes missing', () => {
    const { rerender } = renderHook(
      (props: { id: string }) =>
        useResolvedEntityId({ ...props, exists: false, ready: true, onMissing }),
      { initialProps: { id: 'task-gone' } }
    )
    expect(onMissing).toHaveBeenCalledTimes(1)

    // A second stale id arriving while the first clear is still in flight has
    // to be cleared too, or it sticks around unresolvable.
    rerender({ id: 'task-also-gone' })

    expect(onMissing).toHaveBeenCalledTimes(2)
  })
})
