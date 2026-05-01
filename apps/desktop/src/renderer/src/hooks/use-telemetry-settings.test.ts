import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useTelemetrySettings } from './use-telemetry-settings'

describe('useTelemetrySettings', () => {
  beforeEach(() => {
    const apiMock = window.api as unknown as {
      telemetry: {
        getSettings: ReturnType<typeof vi.fn>
        setEnabled: ReturnType<typeof vi.fn>
      }
    }
    apiMock.telemetry = {
      getSettings: vi.fn().mockResolvedValue({ enabled: true }),
      setEnabled: vi.fn().mockResolvedValue({ success: true })
    }
  })

  it('starts in loading state and resolves to the runtime setting', async () => {
    // #given the runtime reports telemetry enabled
    const { result } = renderHook(() => useTelemetrySettings())

    // #when waiting for the initial load to settle
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    // #then the hook reports the runtime value
    expect(result.current.enabled).toBe(true)
  })

  it('falls back to enabled = true if the runtime reports an error', async () => {
    const apiMock = window.api as unknown as {
      telemetry: { getSettings: ReturnType<typeof vi.fn>; setEnabled: ReturnType<typeof vi.fn> }
    }
    apiMock.telemetry.getSettings.mockRejectedValueOnce(new Error('ipc down'))

    const { result } = renderHook(() => useTelemetrySettings())
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.enabled).toBe(true)
  })

  it('toggles via setEnabled and forwards the new value to the runtime', async () => {
    const setEnabledMock = (
      window.api as unknown as { telemetry: { setEnabled: ReturnType<typeof vi.fn> } }
    ).telemetry.setEnabled

    const { result } = renderHook(() => useTelemetrySettings())
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    await act(async () => {
      await result.current.setEnabled(false)
    })

    expect(setEnabledMock).toHaveBeenCalledWith(false)
    expect(result.current.enabled).toBe(false)
  })

  it('returns false from setEnabled when the IPC fails and keeps the previous value', async () => {
    const apiMock = window.api as unknown as {
      telemetry: { getSettings: ReturnType<typeof vi.fn>; setEnabled: ReturnType<typeof vi.fn> }
    }
    apiMock.telemetry.setEnabled.mockResolvedValueOnce({ success: false, error: 'boom' })

    const { result } = renderHook(() => useTelemetrySettings())
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    let success: boolean | undefined
    await act(async () => {
      success = await result.current.setEnabled(false)
    })

    expect(success).toBe(false)
    expect(result.current.enabled).toBe(true)
  })

  it('does not throw when the IPC layer rejects', async () => {
    const apiMock = window.api as unknown as {
      telemetry: { getSettings: ReturnType<typeof vi.fn>; setEnabled: ReturnType<typeof vi.fn> }
    }
    apiMock.telemetry.setEnabled.mockRejectedValueOnce(new Error('network down'))

    const { result } = renderHook(() => useTelemetrySettings())
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    let success: boolean | undefined
    await act(async () => {
      success = await result.current.setEnabled(false)
    })

    expect(success).toBe(false)
  })
})
