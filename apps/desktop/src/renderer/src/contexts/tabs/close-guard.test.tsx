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

  it('ignores a trailing cancel while a save is in flight', async () => {
    const commit = vi.fn()
    let release = (_saved: boolean) => {}
    const save = vi.fn(() => new Promise<boolean>((resolve) => (release = resolve)))
    const { result } = renderHook(() => useCloseGuardRegistry())

    act(() => {
      result.current.registerCloseGuard('tab-1', { isDirty: () => true, save })
    })
    act(() => result.current.requestClose(['tab-1'], commit))

    // The dialog primitive closes itself on top of our own handler, so a cancel
    // lands mid-save. It must not abort the close the user just asked for.
    let saving: Promise<void> = Promise.resolve()
    act(() => {
      saving = result.current.resolvePending('save')
      void result.current.resolvePending('cancel')
    })
    await act(async () => {
      release(true)
      await saving
    })

    expect(save).toHaveBeenCalledTimes(1)
    expect(commit).toHaveBeenCalledTimes(1)
    expect(result.current.pending).toBeNull()
  })

  it('ignores a second close request while a prompt is up', () => {
    const first = vi.fn()
    const second = vi.fn()
    const { result } = renderHook(() => useCloseGuardRegistry())

    act(() => {
      result.current.registerCloseGuard('tab-1', {
        isDirty: () => true,
        save: vi.fn().mockResolvedValue(true)
      })
    })
    act(() => result.current.requestClose(['tab-1'], first))
    act(() => result.current.requestClose(['tab-1'], second))

    expect(second).not.toHaveBeenCalled()
    expect(result.current.pending).toEqual({ tabId: 'tab-1' })
  })

  it('reports whether the pending tab can be saved', () => {
    const { result } = renderHook(() => useCloseGuardRegistry())

    act(() => {
      result.current.registerCloseGuard('tab-1', {
        isDirty: () => true,
        canSave: () => false,
        save: vi.fn().mockResolvedValue(false)
      })
    })
    act(() => result.current.requestClose(['tab-1'], vi.fn()))

    expect(result.current.pendingCanSave).toBe(false)
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
