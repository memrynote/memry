import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { ReactNode } from 'react'
import { I18nextProvider } from 'react-i18next'
import type { i18n as I18nInstance } from 'i18next'
import { createRendererI18n } from '@memry/i18n/renderer'

type EventCallback = (event: Record<string, unknown>) => void
type VoidCallback = () => void

let syncStatusListeners: EventCallback[] = []
let pausedListeners: EventCallback[] = []
let resumedListeners: EventCallback[] = []
let uploadProgressListeners: EventCallback[] = []
let downloadProgressListeners: EventCallback[] = []
let linkingRequestListeners: EventCallback[] = []
let linkingApprovedListeners: EventCallback[] = []
let sessionExpiredListeners: VoidCallback[] = []
let deviceRevokedListeners: EventCallback[] = []
let securityWarningListeners: EventCallback[] = []
let certificatePinFailedListeners: VoidCallback[] = []
let i18n: I18nInstance

const toastMock = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn()
}))

vi.mock('./auth-context', () => ({
  useAuth: vi.fn().mockReturnValue({
    state: { status: 'authenticated' },
    logout: vi.fn().mockResolvedValue(undefined)
  })
}))

vi.mock('@/components/sync/device-revoked-dialog', () => ({
  DeviceRevokedDialog: () => null
}))

vi.mock('sonner', () => ({
  toast: toastMock
}))

const mockSyncOps = {
  getStatus: vi.fn().mockResolvedValue({
    status: 'idle',
    lastSyncAt: null,
    pendingCount: 0,
    error: undefined
  }),
  triggerSync: vi.fn().mockResolvedValue(undefined),
  pause: vi.fn().mockResolvedValue(undefined),
  resume: vi.fn().mockResolvedValue(undefined)
}

beforeEach(async () => {
  i18n = await createRendererI18n({ locale: 'en' })
  toastMock.error.mockClear()
  toastMock.info.mockClear()
  mockSyncOps.getStatus.mockResolvedValue({
    status: 'idle',
    lastSyncAt: null,
    pendingCount: 0,
    error: undefined
  })
  mockSyncOps.triggerSync.mockResolvedValue(undefined)
  mockSyncOps.pause.mockResolvedValue(undefined)
  mockSyncOps.resume.mockResolvedValue(undefined)

  syncStatusListeners = []
  pausedListeners = []
  resumedListeners = []
  uploadProgressListeners = []
  downloadProgressListeners = []
  linkingRequestListeners = []
  linkingApprovedListeners = []
  sessionExpiredListeners = []
  deviceRevokedListeners = []
  securityWarningListeners = []
  certificatePinFailedListeners = []

  const api = (window as unknown as { api: Record<string, unknown> }).api as Record<string, unknown>
  api.syncOps = mockSyncOps
  api.onSyncStatusChanged = vi.fn((cb: EventCallback) => {
    syncStatusListeners.push(cb)
    return () => {
      syncStatusListeners = syncStatusListeners.filter((l) => l !== cb)
    }
  })
  api.onSyncPaused = vi.fn((cb: EventCallback) => {
    pausedListeners.push(cb)
    return () => {
      pausedListeners = pausedListeners.filter((l) => l !== cb)
    }
  })
  api.onSyncResumed = vi.fn((cb: EventCallback) => {
    resumedListeners.push(cb)
    return () => {
      resumedListeners = resumedListeners.filter((l) => l !== cb)
    }
  })
  api.onUploadProgress = vi.fn((cb: EventCallback) => {
    uploadProgressListeners.push(cb)
    return () => {
      uploadProgressListeners = uploadProgressListeners.filter((l) => l !== cb)
    }
  })
  api.onDownloadProgress = vi.fn((cb: EventCallback) => {
    downloadProgressListeners.push(cb)
    return () => {
      downloadProgressListeners = downloadProgressListeners.filter((l) => l !== cb)
    }
  })
  api.onLinkingRequest = vi.fn((cb: EventCallback) => {
    linkingRequestListeners.push(cb)
    return () => {
      linkingRequestListeners = linkingRequestListeners.filter((l) => l !== cb)
    }
  })
  api.onLinkingApproved = vi.fn((cb: EventCallback) => {
    linkingApprovedListeners.push(cb)
    return () => {
      linkingApprovedListeners = linkingApprovedListeners.filter((l) => l !== cb)
    }
  })
  api.onSessionExpired = vi.fn((cb: VoidCallback) => {
    sessionExpiredListeners.push(cb)
    return () => {
      sessionExpiredListeners = sessionExpiredListeners.filter((l) => l !== cb)
    }
  })
  api.onDeviceRevoked = vi.fn((cb: EventCallback) => {
    deviceRevokedListeners.push(cb)
    return () => {
      deviceRevokedListeners = deviceRevokedListeners.filter((l) => l !== cb)
    }
  })
  api.onConflictDetected = vi.fn(() => () => {})
  api.onQueueCleared = vi.fn(() => () => {})
  api.onClockSkewWarning = vi.fn(() => () => {})
  api.onItemSynced = vi.fn(() => () => {})
  api.onInitialSyncProgress = vi.fn(() => () => {})
  api.onKeyRotationProgress = vi.fn(() => () => {})
  api.onSecurityWarning = vi.fn((cb: EventCallback) => {
    securityWarningListeners.push(cb)
    return () => {
      securityWarningListeners = securityWarningListeners.filter((l) => l !== cb)
    }
  })
  api.onCertificatePinFailed = vi.fn((cb: VoidCallback) => {
    certificatePinFailedListeners.push(cb)
    return () => {
      certificatePinFailedListeners = certificatePinFailedListeners.filter((l) => l !== cb)
    }
  })
})

import { SyncProvider, useSync } from './sync-context'

function wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nextProvider i18n={i18n}>
      <SyncProvider>{children}</SyncProvider>
    </I18nextProvider>
  )
}

describe('SyncProvider', () => {
  describe('#given authenticated user #when mounted', () => {
    it('#then fetches initial sync status', async () => {
      const { result } = renderHook(() => useSync(), { wrapper })
      await vi.waitFor(() => {
        expect(result.current.state.status).toBe('idle')
      })
    })
  })

  describe('#given sync:paused event fired #when listening', () => {
    it('#then state transitions to paused', async () => {
      const { result } = renderHook(() => useSync(), { wrapper })
      await vi.waitFor(() => expect(result.current.state.status).toBe('idle'))

      act(() => {
        for (const cb of pausedListeners) {
          cb({ pendingCount: 3 })
        }
      })

      expect(result.current.state.status).toBe('paused')
      expect(result.current.state.pendingCount).toBe(3)
    })
  })

  describe('#given sync:resumed event fired #when listening', () => {
    it('#then state transitions back to idle', async () => {
      const { result } = renderHook(() => useSync(), { wrapper })
      await vi.waitFor(() => expect(result.current.state.status).toBe('idle'))

      act(() => {
        for (const cb of pausedListeners) cb({ pendingCount: 2 })
      })
      expect(result.current.state.status).toBe('paused')

      act(() => {
        for (const cb of resumedListeners) cb({ pendingCount: 2 })
      })
      expect(result.current.state.status).toBe('idle')
    })
  })

  describe('#given upload progress event #when listening', () => {
    it('#then updates uploadProgress state', async () => {
      const { result } = renderHook(() => useSync(), { wrapper })
      await vi.waitFor(() => expect(result.current.state.status).toBe('idle'))

      act(() => {
        for (const cb of uploadProgressListeners) {
          cb({ attachmentId: 'att-1', progress: 50, status: 'uploading' })
        }
      })

      expect(result.current.state.uploadProgress).toEqual({
        'att-1': { progress: 50, status: 'uploading' }
      })
    })
  })

  describe('#given download progress event #when listening', () => {
    it('#then updates downloadProgress state', async () => {
      const { result } = renderHook(() => useSync(), { wrapper })
      await vi.waitFor(() => expect(result.current.state.status).toBe('idle'))

      act(() => {
        for (const cb of downloadProgressListeners) {
          cb({ attachmentId: 'att-2', progress: 75, status: 'downloading' })
        }
      })

      expect(result.current.state.downloadProgress).toEqual({
        'att-2': { progress: 75, status: 'downloading' }
      })
    })
  })

  describe('#given status-changed event #when listening', () => {
    it('#then updates state from event data', async () => {
      const { result } = renderHook(() => useSync(), { wrapper })
      await vi.waitFor(() => expect(result.current.state.status).toBe('idle'))

      act(() => {
        for (const cb of syncStatusListeners) {
          cb({ status: 'syncing', pendingCount: 5, lastSyncAt: 1000 })
        }
      })

      expect(result.current.state.status).toBe('syncing')
      expect(result.current.state.pendingCount).toBe(5)
      expect(result.current.state.lastSyncAt).toBe(1000)
    })

    it('#then translates errors namespace payloads before storing them', async () => {
      const { result } = renderHook(() => useSync(), { wrapper })
      await vi.waitFor(() => expect(result.current.state.status).toBe('idle'))

      act(() => {
        for (const cb of syncStatusListeners) {
          cb({
            status: 'error',
            pendingCount: 0,
            error: 'errors:sync.networkOffline'
          })
        }
      })

      expect(result.current.state.error).toBe(
        'You are offline. Changes will sync when you reconnect.'
      )
    })
  })

  describe('#given global sync events #when listening', () => {
    it('#then uses errors namespace messages for storage quota toasts', async () => {
      renderHook(() => useSync(), { wrapper })
      await vi.waitFor(() => expect(syncStatusListeners.length).toBeGreaterThan(0))

      act(() => {
        for (const cb of syncStatusListeners) {
          cb({ status: 'error', pendingCount: 0, errorCategory: 'storage_quota_exceeded' })
        }
      })

      expect(toastMock.error).toHaveBeenCalledWith(
        'Your sync storage is full. Free up space or upgrade your plan.',
        { duration: 10000 }
      )
    })

    it('#then translates session and device revoked state errors', async () => {
      const { result } = renderHook(() => useSync(), { wrapper })
      await vi.waitFor(() => expect(sessionExpiredListeners.length).toBeGreaterThan(0))

      act(() => {
        for (const cb of sessionExpiredListeners) cb()
      })
      expect(toastMock.error).toHaveBeenCalledWith(
        'Your session has expired. Sign in again to continue syncing.',
        { duration: 8000 }
      )

      act(() => {
        for (const cb of deviceRevokedListeners) cb({ unsyncedCount: 2 })
      })
      await vi.waitFor(() =>
        expect(result.current.state.error).toBe('This device has been removed from your account.')
      )
    })

    it('#then uses errors namespace messages for security warning toasts', async () => {
      renderHook(() => useSync(), { wrapper })
      await vi.waitFor(() => expect(securityWarningListeners.length).toBeGreaterThan(0))

      act(() => {
        for (const cb of securityWarningListeners) cb({ permanent: false })
      })

      expect(toastMock.error).toHaveBeenCalledWith(
        'A sync item failed signature verification and will be retried.',
        { duration: 8000 }
      )
    })

    it('#then uses errors namespace messages for certificate pin pause toasts', async () => {
      renderHook(() => useSync(), { wrapper })
      await vi.waitFor(() => expect(certificatePinFailedListeners.length).toBeGreaterThan(0))

      act(() => {
        for (const cb of certificatePinFailedListeners) cb()
      })

      expect(toastMock.error).toHaveBeenCalledWith(
        'Secure connection to sync server could not be verified. Syncing has been paused for your protection.',
        { duration: 15000 }
      )
    })
  })
})
