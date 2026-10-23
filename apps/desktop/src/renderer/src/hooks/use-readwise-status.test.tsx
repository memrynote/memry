import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'

const t = (k: string): string => k
vi.mock('@memry/i18n/renderer', () => ({ useT: () => ({ t }) }))

import { useReadwiseStatus } from './use-readwise-status'

describe('useReadwiseStatus', () => {
  const status = vi.fn()
  let listeners: Array<() => void> = []
  beforeEach(() => {
    status.mockReset()
    listeners = []
    ;(window as unknown as { api: unknown }).api = {
      onReadwiseStatusChanged: (callback: () => void) => {
        listeners.push(callback)
        return () => {
          listeners = listeners.filter((listener) => listener !== callback)
        }
      },
      import: { readwise: { status } }
    }
  })

  it('re-reads when main reports a status change, and stops listening on unmount', async () => {
    status.mockResolvedValue({ connected: true, syncing: null })
    const { result, unmount } = renderHook(() => useReadwiseStatus(true))
    await waitFor(() => {
      expect(result.current.status).toEqual({ connected: true, syncing: null })
    })

    status.mockResolvedValue({ connected: true, syncing: { stage: 'reading' } })
    act(() => {
      listeners.forEach((listener) => listener())
    })
    await waitFor(() => {
      expect(result.current.status).toEqual({ connected: true, syncing: { stage: 'reading' } })
    })

    unmount()
    expect(listeners).toHaveLength(0)
  })

  it('does not ask while disabled', () => {
    renderHook(() => useReadwiseStatus(false))
    expect(status).not.toHaveBeenCalled()
  })

  it('loads, re-reads on refresh, and falls back to null on failure or an error envelope', async () => {
    status.mockResolvedValue({ connected: true })
    const { result } = renderHook(() => useReadwiseStatus(true))
    await waitFor(() => {
      expect(result.current.status).toEqual({ connected: true })
    })

    status.mockResolvedValue({ success: false, error: 'no vault' })
    act(() => {
      result.current.refresh()
    })
    await waitFor(() => {
      expect(result.current.status).toBeNull()
    })
    expect(status).toHaveBeenCalledTimes(2)

    status.mockRejectedValue(new Error('x'))
    act(() => {
      result.current.refresh()
    })
    await waitFor(() => {
      expect(status).toHaveBeenCalledTimes(3)
    })
    expect(result.current.status).toBeNull()
  })
})
