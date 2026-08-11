import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useTaskPreferences } from './use-task-preferences'

const DEFAULTS = {
  defaultProjectId: null,
  defaultSortOrder: 'manual' as const,
  defaultView: 'all' as const,
  staleInboxDays: 7
}

describe('useTaskPreferences', () => {
  let settingsChangedListener: ((event: { key: string; value: unknown }) => void) | null

  beforeEach(() => {
    settingsChangedListener = null

    const settingsMock = window.api.settings as Record<string, unknown>
    settingsMock.getTaskSettings = vi.fn().mockResolvedValue({ ...DEFAULTS })
    settingsMock.setTaskSettings = vi.fn().mockResolvedValue({ success: true })
    ;(window.api.onSettingsChanged as ReturnType<typeof vi.fn>).mockImplementation(
      (cb: (event: { key: string; value: unknown }) => void) => {
        settingsChangedListener = cb
        return () => {
          settingsChangedListener = null
        }
      }
    )
  })

  it('loads task settings on mount', async () => {
    const { result } = renderHook(() => useTaskPreferences())

    expect(result.current.isLoading).toBe(true)

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.settings).toEqual(DEFAULTS)
    expect(result.current.error).toBeNull()
    expect(window.api.settings.getTaskSettings).toHaveBeenCalledOnce()
  })

  it('returns defaults while loading', () => {
    const { result } = renderHook(() => useTaskPreferences())

    expect(result.current.settings).toEqual(DEFAULTS)
    expect(result.current.isLoading).toBe(true)
  })

  it('handles load error gracefully', async () => {
    ;(window.api.settings.getTaskSettings as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('DB read failed')
    )

    const { result } = renderHook(() => useTaskPreferences())

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.error).toBe('DB read failed')
    expect(result.current.settings).toEqual(DEFAULTS)
  })

  it('updates settings successfully', async () => {
    const { result } = renderHook(() => useTaskPreferences())

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    let success: boolean
    await act(async () => {
      success = await result.current.updateSettings({ defaultProjectId: 'proj-1' })
    })

    expect(success!).toBe(true)
    expect(window.api.settings.setTaskSettings).toHaveBeenCalledWith({
      defaultProjectId: 'proj-1'
    })
    expect(result.current.settings.defaultProjectId).toBe('proj-1')
  })

  it('handles update failure', async () => {
    ;(window.api.settings.setTaskSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      error: 'Validation failed'
    })

    const { result } = renderHook(() => useTaskPreferences())

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    let success: boolean
    await act(async () => {
      success = await result.current.updateSettings({ staleInboxDays: -1 })
    })

    expect(success!).toBe(false)
    expect(result.current.error).toBe('Validation failed')
    expect(result.current.settings.staleInboxDays).toBe(7)
  })

  it('handles update IPC exception', async () => {
    ;(window.api.settings.setTaskSettings as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('IPC timeout')
    )

    const { result } = renderHook(() => useTaskPreferences())

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    let success: boolean
    await act(async () => {
      success = await result.current.updateSettings({ defaultSortOrder: 'priority' })
    })

    expect(success!).toBe(false)
    expect(result.current.error).toBe('IPC timeout')
  })

  it('reacts to settings:changed events for tasks key', async () => {
    const { result } = renderHook(() => useTaskPreferences())

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(settingsChangedListener).not.toBeNull()

    act(() => {
      settingsChangedListener!({ key: 'tasks', value: { defaultProjectId: 'proj-remote' } })
    })

    expect(result.current.settings.defaultProjectId).toBe('proj-remote')
  })

  it('ignores settings:changed events for other keys', async () => {
    const { result } = renderHook(() => useTaskPreferences())

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    act(() => {
      settingsChangedListener!({ key: 'general', value: { theme: 'dark' } })
    })

    expect(result.current.settings).toEqual(DEFAULTS)
  })

  it('merges partial updates into existing settings', async () => {
    ;(window.api.settings.getTaskSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULTS,
      defaultProjectId: 'proj-existing',
      staleInboxDays: 14
    })

    const { result } = renderHook(() => useTaskPreferences())

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    await act(async () => {
      await result.current.updateSettings({ defaultSortOrder: 'priority' })
    })

    expect(result.current.settings).toEqual({
      defaultProjectId: 'proj-existing',
      defaultSortOrder: 'priority',
      defaultView: 'all',
      staleInboxDays: 14
    })
  })

  // The main process fans settings:changed out to every window including the
  // writer's, and that echo cannot be suppressed at the sender (#1063) because
  // sibling instances of the same hook in that window only converge through it.
  // So the echo has to be free when it carries nothing new.
  describe('echo of an already-applied value (#1063)', () => {
    it('keeps state identity when its own write echoes back', async () => {
      const { result } = renderHook(() => useTaskPreferences())

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      await act(async () => {
        await result.current.updateSettings({ defaultProjectId: 'proj-1' })
      })

      const settingsAfterOptimisticUpdate = result.current.settings

      act(() => {
        // Exactly what the main process broadcasts back to this window.
        settingsChangedListener!({ key: 'tasks', value: { defaultProjectId: 'proj-1' } })
      })

      // Same object: the state update bailed out, so React skips re-rendering
      // children and firing effects for this echo.
      expect(result.current.settings).toBe(settingsAfterOptimisticUpdate)
      expect(result.current.settings.defaultProjectId).toBe('proj-1')
    })

    it('costs zero renders for repeated no-op echoes', async () => {
      let renders = 0
      const { result } = renderHook(() => {
        renders++
        return useTaskPreferences()
      })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      // React cannot take its eager-state shortcut on the first dispatch after a
      // real state change, so it renders this component once more and then bails
      // out. Every echo after that is free — which is the steady state, since
      // each sync apply re-broadcasts the whole unchanged group.
      act(() => {
        settingsChangedListener!({ key: 'tasks', value: { ...DEFAULTS } })
      })

      const rendersAfterFirstEcho = renders

      act(() => {
        settingsChangedListener!({ key: 'tasks', value: { ...DEFAULTS } })
      })
      act(() => {
        settingsChangedListener!({ key: 'tasks', value: { ...DEFAULTS } })
      })

      expect(renders).toBe(rendersAfterFirstEcho)
    })

    it('does not re-render when a sync apply re-broadcasts the unchanged group', async () => {
      const { result } = renderHook(() => useTaskPreferences())

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      const settingsBefore = result.current.settings

      act(() => {
        settingsChangedListener!({ key: 'tasks', value: { ...DEFAULTS } })
      })

      // Same object identity: no state update happened at all.
      expect(result.current.settings).toBe(settingsBefore)
    })

    it('still converges when the echoed value genuinely differs', async () => {
      let renders = 0
      const { result } = renderHook(() => {
        renders++
        return useTaskPreferences()
      })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      const rendersBefore = renders

      act(() => {
        settingsChangedListener!({ key: 'tasks', value: { defaultProjectId: 'proj-remote' } })
      })

      expect(renders).toBeGreaterThan(rendersBefore)
      expect(result.current.settings.defaultProjectId).toBe('proj-remote')
    })
  })

  it('unsubscribes from settings:changed on unmount', async () => {
    const { unmount } = renderHook(() => useTaskPreferences())

    await waitFor(() => {
      expect(settingsChangedListener).not.toBeNull()
    })

    unmount()

    expect(settingsChangedListener).toBeNull()
  })
})
