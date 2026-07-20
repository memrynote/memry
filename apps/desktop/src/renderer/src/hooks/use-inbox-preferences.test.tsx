import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useInboxPreferences } from './use-inbox-preferences'

describe('useInboxPreferences', () => {
  beforeEach(() => {
    window.api = {
      settings: {
        getInboxSettings: vi.fn().mockResolvedValue({
          reviewReminderEnabled: true,
          reviewReminderTime: '18:00'
        }),
        setInboxSettings: vi.fn().mockResolvedValue({ success: true })
      },
      onSettingsChanged: vi.fn(() => () => {})
    } as never
  })

  it('loads settings', async () => {
    const { result } = renderHook(() => useInboxPreferences())
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.settings.reviewReminderTime).toBe('18:00')
  })

  it('updates optimistically on success', async () => {
    const { result } = renderHook(() => useInboxPreferences())
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    await act(async () => {
      await result.current.updateSettings({ reviewReminderTime: '06:30' })
    })
    expect(window.api.settings.setInboxSettings).toHaveBeenCalledWith({
      reviewReminderTime: '06:30'
    })
    expect(result.current.settings.reviewReminderTime).toBe('06:30')
  })
})
