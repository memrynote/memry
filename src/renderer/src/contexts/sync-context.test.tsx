import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { ReactNode } from 'react'

type EventCallback = (event: Record<string, unknown>) => void

let syncStatusListeners: EventCallback[] = []
let pausedListeners: EventCallback[] = []
let resumedListeners: EventCallback[] = []
let uploadProgressListeners: EventCallback[] = []
let downloadProgressListeners: EventCallback[] = []
let linkingRequestListeners: EventCallback[] = []
let linkingApprovedListeners: EventCallback[] = []

vi.mock('./auth-context', () => ({
  useAuth: vi.fn().mockReturnValue({
    state: { status: 'authenticated' },
    logout: vi.fn().mockResolvedValue(undefined)
  })
}))

vi.mock('@/components/sync/device-revoked-dialog', () => ({
  DeviceRevokedDialog: () => null
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

beforeEach(() => {
  syncStatusListeners = []
  pausedListeners = []
  resumedListeners = []
  uploadProgressListeners = []
  downloadProgressListeners = []
  linkingRequestListeners = []
  linkingApprovedListeners = []

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
  api.onSessionExpired = vi.fn(() => () => {})
  api.onDeviceRevoked = vi.fn(() => () => {})
  api.onConflictDetected = vi.fn(() => () => {})
  api.onQueueCleared = vi.fn(() => () => {})
  api.onClockSkewWarning = vi.fn(() => () => {})
  api.onItemSynced = vi.fn(() => () => {})
  api.onInitialSyncProgress = vi.fn(() => () => {})
  api.onKeyRotationProgress = vi.fn(() => () => {})
  api.onSecurityWarning = vi.fn(() => () => {})
  api.onCertificatePinFailed = vi.fn(() => () => {})
})

import { SyncProvider, useSync } from './sync-context'

function wrapper({ children }: { children: ReactNode }) {
  return <SyncProvider>{children}</SyncProvider>
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
  })
})
