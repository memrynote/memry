import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'

const toastMock = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: toastMock }))
vi.mock('@memry/i18n/renderer', () => ({ useT: () => ({ t: (key: string) => key }) }))

import { useReadwiseErrorToast } from './use-readwise-error-toast'

describe('useReadwiseErrorToast', () => {
  const status = vi.fn()
  const ackErrorToast = vi.fn()
  let listeners: Array<() => void> = []
  const open = vi.fn()

  const connected = (kind: string | null) => ({
    connected: true,
    error: kind ? { kind, detail: null } : null
  })

  beforeEach(() => {
    vi.clearAllMocks()
    listeners = []
    ackErrorToast.mockResolvedValue({ first: true })
    ;(window as unknown as { api: unknown }).api = {
      onReadwiseStatusChanged: (callback: () => void) => {
        listeners.push(callback)
        return () => {
          listeners = listeners.filter((listener) => listener !== callback)
        }
      },
      import: { readwise: { status, ackErrorToast } }
    }
  })

  it.each(['invalid-token', 'subscription-expired'])(
    'shows one toast for %s, with a button that opens Readwise',
    async (kind) => {
      status.mockResolvedValue(connected(kind))
      renderHook(() => {
        useReadwiseErrorToast(open)
      })

      await waitFor(() => {
        expect(toastMock).toHaveBeenCalledTimes(1)
      })
      const [title, options] = toastMock.mock.calls[0]
      expect(title).toBe(`import.dialog.readwise.errorToast.${kind}.title`)
      expect(options.action.label).toBe('import.dialog.readwise.errorToast.open')
      options.action.onClick()
      expect(open).toHaveBeenCalled()
    }
  )

  it('shows nothing when main says this episode already had its toast', async () => {
    status.mockResolvedValue(connected('invalid-token'))
    ackErrorToast.mockResolvedValue({ first: false })
    renderHook(() => {
      useReadwiseErrorToast(open)
    })

    await waitFor(() => {
      expect(ackErrorToast).toHaveBeenCalled()
    })
    expect(toastMock).not.toHaveBeenCalled()
  })

  it.each(['network', 'rate-limited', 'server', 'unexpected', null])(
    'never toasts for %s, and does not even claim the episode',
    async (kind) => {
      status.mockResolvedValue(connected(kind))
      renderHook(() => {
        useReadwiseErrorToast(open)
      })
      await waitFor(() => {
        expect(status).toHaveBeenCalled()
      })
      act(() => {
        listeners.forEach((listener) => listener())
      })
      await waitFor(() => {
        expect(status).toHaveBeenCalledTimes(2)
      })
      expect(ackErrorToast).not.toHaveBeenCalled()
      expect(toastMock).not.toHaveBeenCalled()
    }
  )

  it('checks again when a run fails, and survives a status that cannot be read', async () => {
    status.mockRejectedValueOnce(new Error('no vault'))
    renderHook(() => {
      useReadwiseErrorToast(open)
    })
    await waitFor(() => {
      expect(status).toHaveBeenCalledTimes(1)
    })
    expect(toastMock).not.toHaveBeenCalled()

    status.mockResolvedValue(connected('invalid-token'))
    act(() => {
      listeners.forEach((listener) => listener())
    })
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledTimes(1)
    })
  })

  it('stops listening on unmount', () => {
    status.mockResolvedValue(connected(null))
    const { unmount } = renderHook(() => {
      useReadwiseErrorToast(open)
    })
    unmount()
    expect(listeners).toHaveLength(0)
  })
})
