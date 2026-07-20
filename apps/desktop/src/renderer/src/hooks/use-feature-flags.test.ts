import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useFeatureFlags } from './use-feature-flags'

describe('useFeatureFlags', () => {
  let settingsChangedListener: ((event: { key: string; value: unknown }) => void) | null

  beforeEach(() => {
    settingsChangedListener = null

    const settingsMock = window.api.settings as Record<string, unknown>
    settingsMock.getFeaturesSettings = vi.fn().mockResolvedValue({
      home: true,
      inbox: false,
      journal: true,
      tasks: true,
      calendar: true,
      graph: true
    })
    settingsMock.setFeaturesSettings = vi.fn().mockResolvedValue({ success: true })
    ;(window.api.onSettingsChanged as ReturnType<typeof vi.fn>).mockImplementation(
      (cb: (event: { key: string; value: unknown }) => void) => {
        settingsChangedListener = cb
        return () => {
          settingsChangedListener = null
        }
      }
    )
  })

  it('loads persisted flags', async () => {
    const { result } = renderHook(() => useFeatureFlags())
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.isEnabled('inbox')).toBe(false)
    expect(result.current.isEnabled('tasks')).toBe(true)
  })

  it('setFlag persists and updates optimistically', async () => {
    const { result } = renderHook(() => useFeatureFlags())
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    await act(async () => {
      await result.current.setFlag('tasks', false)
    })
    expect(window.api.settings.setFeaturesSettings).toHaveBeenCalledWith({ tasks: false })
    expect(result.current.isEnabled('tasks')).toBe(false)
  })

  it('reacts to external settings:changed events', async () => {
    const { result } = renderHook(() => useFeatureFlags())
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    act(() => settingsChangedListener?.({ key: 'features', value: { graph: false } }))
    expect(result.current.isEnabled('graph')).toBe(false)
  })

  it('settings:changed during the initial fetch wins over the stale fetch result', async () => {
    let resolveGet!: (value: unknown) => void
    const settingsMock = window.api.settings as Record<string, unknown>
    settingsMock.getFeaturesSettings = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveGet = resolve
      })
    )

    const { result } = renderHook(() => useFeatureFlags())
    act(() => settingsChangedListener?.({ key: 'features', value: { graph: false } }))
    await act(async () => {
      // stale snapshot read before the write: still has graph: true
      resolveGet({
        home: true,
        inbox: false,
        journal: true,
        tasks: true,
        calendar: true,
        graph: true
      })
    })

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.isEnabled('graph')).toBe(false)
  })

  it('setFlag during the initial fetch wins over the stale fetch result', async () => {
    let resolveGet!: (value: unknown) => void
    const settingsMock = window.api.settings as Record<string, unknown>
    settingsMock.getFeaturesSettings = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveGet = resolve
      })
    )

    const { result } = renderHook(() => useFeatureFlags())
    await act(async () => {
      await result.current.setFlag('tasks', false)
    })
    await act(async () => {
      resolveGet({
        home: true,
        inbox: false,
        journal: true,
        tasks: true,
        calendar: true,
        graph: true
      })
    })

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.isEnabled('tasks')).toBe(false)
  })
})
