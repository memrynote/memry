import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { useCloseGuardRegistry } from './close-guard'

describe('useCloseGuardRegistry', () => {
  it('commits immediately when no tab is guarded', () => {
    const commit = vi.fn()
    const { result } = renderHook(() => useCloseGuardRegistry())

    act(() => result.current.requestClose(['tab-1'], commit))

    expect(commit).toHaveBeenCalledTimes(1)
    expect(result.current.pending).toBeNull()
  })

  it('commits immediately when the guarded tab is clean', () => {
    const commit = vi.fn()
    const { result } = renderHook(() => useCloseGuardRegistry())

    act(() => {
      result.current.registerCloseGuard('tab-1', {
        isDirty: () => false,
        save: vi.fn().mockResolvedValue(true)
      })
    })
    act(() => result.current.requestClose(['tab-1'], commit))

    expect(commit).toHaveBeenCalledTimes(1)
  })

  it('holds the close and exposes a pending prompt when dirty', () => {
    const commit = vi.fn()
    const { result } = renderHook(() => useCloseGuardRegistry())

    act(() => {
      result.current.registerCloseGuard('tab-1', {
        isDirty: () => true,
        save: vi.fn().mockResolvedValue(true)
      })
    })
    act(() => result.current.requestClose(['tab-1'], commit))

    expect(commit).not.toHaveBeenCalled()
    expect(result.current.pending).toEqual({ tabId: 'tab-1' })
  })

  it('discard commits without saving', async () => {
    const commit = vi.fn()
    const save = vi.fn().mockResolvedValue(true)
    const { result } = renderHook(() => useCloseGuardRegistry())

    act(() => {
      result.current.registerCloseGuard('tab-1', { isDirty: () => true, save })
    })
    act(() => result.current.requestClose(['tab-1'], commit))
    await act(async () => {
      await result.current.resolvePending('discard')
    })

    expect(save).not.toHaveBeenCalled()
    expect(commit).toHaveBeenCalledTimes(1)
    expect(result.current.pending).toBeNull()
  })

  it('save commits only when the save succeeds', async () => {
    const commit = vi.fn()
    const save = vi.fn().mockResolvedValue(false)
    const { result } = renderHook(() => useCloseGuardRegistry())

    act(() => {
      result.current.registerCloseGuard('tab-1', { isDirty: () => true, save })
    })
    act(() => result.current.requestClose(['tab-1'], commit))
    await act(async () => {
      await result.current.resolvePending('save')
    })

    expect(save).toHaveBeenCalledTimes(1)
    expect(commit).not.toHaveBeenCalled()
    expect(result.current.pending).toEqual({ tabId: 'tab-1' })

    save.mockResolvedValue(true)
    await act(async () => {
      await result.current.resolvePending('save')
    })

    expect(commit).toHaveBeenCalledTimes(1)
  })

  it('cancel aborts the whole operation', async () => {
    const commit = vi.fn()
    const { result } = renderHook(() => useCloseGuardRegistry())

    act(() => {
      result.current.registerCloseGuard('tab-1', {
        isDirty: () => true,
        save: vi.fn().mockResolvedValue(true)
      })
      result.current.registerCloseGuard('tab-2', {
        isDirty: () => true,
        save: vi.fn().mockResolvedValue(true)
      })
    })
    act(() => result.current.requestClose(['tab-1', 'tab-2'], commit))
    await act(async () => {
      await result.current.resolvePending('cancel')
    })

    expect(commit).not.toHaveBeenCalled()
    expect(result.current.pending).toBeNull()
  })

  it('prompts each dirty tab in turn, then commits once', async () => {
    const commit = vi.fn()
    const { result } = renderHook(() => useCloseGuardRegistry())

    act(() => {
      result.current.registerCloseGuard('tab-1', {
        isDirty: () => true,
        save: vi.fn().mockResolvedValue(true)
      })
      result.current.registerCloseGuard('tab-2', {
        isDirty: () => true,
        save: vi.fn().mockResolvedValue(true)
      })
    })
    act(() => result.current.requestClose(['tab-1', 'tab-2', 'tab-3'], commit))

    expect(result.current.pending).toEqual({ tabId: 'tab-1' })
    await act(async () => {
      await result.current.resolvePending('discard')
    })
    expect(result.current.pending).toEqual({ tabId: 'tab-2' })
    expect(commit).not.toHaveBeenCalled()

    await act(async () => {
      await result.current.resolvePending('discard')
    })
    expect(result.current.pending).toBeNull()
    expect(commit).toHaveBeenCalledTimes(1)
  })

  it('unregistering removes the guard', () => {
    const commit = vi.fn()
    const { result } = renderHook(() => useCloseGuardRegistry())

    let unregister = () => {}
    act(() => {
      unregister = result.current.registerCloseGuard('tab-1', {
        isDirty: () => true,
        save: vi.fn().mockResolvedValue(true)
      })
    })
    act(() => unregister())
    act(() => result.current.requestClose(['tab-1'], commit))

    expect(commit).toHaveBeenCalledTimes(1)
  })
})
