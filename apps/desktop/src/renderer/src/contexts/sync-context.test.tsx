import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, screen } from '@testing-library/react'
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
let attachmentUploadFailedListeners: EventCallback[] = []
let linkingRequestListeners: EventCallback[] = []
let linkingApprovedListeners: EventCallback[] = []
let conflictDetectedListeners: EventCallback[] = []
let itemSyncedListeners: EventCallback[] = []
let initialSyncProgressListeners: EventCallback[] = []
let queueClearedListeners: VoidCallback[] = []
let clockSkewWarningListeners: VoidCallback[] = []
let sessionExpiredListeners: EventCallback[] = []
let deviceRevokedListeners: EventCallback[] = []
let securityWarningListeners: EventCallback[] = []
let certificatePinFailedListeners: VoidCallback[] = []
let vaultRecoveryNeededListeners: EventCallback[] = []
let i18n: I18nInstance

const toastMock = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn()
}))

const logoutMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

vi.mock('./auth-context', () => ({
  useAuth: vi.fn().mockReturnValue({
    state: { status: 'authenticated' },
    logout: logoutMock
  })
}))

vi.mock('@/components/sync/device-revoked-dialog', () => ({
  DeviceRevokedDialog: ({
    open,
    unsyncedCount,
    onExport,
    onSignOut
  }: {
    open: boolean
    unsyncedCount: number
    onExport: () => void
    onSignOut: () => void
  }) =>
    open ? (
      <div>
        <p>revoked:{unsyncedCount}</p>
        <button type="button" onClick={onExport}>
          export
        </button>
        <button type="button" onClick={onSignOut}>
          sign out
        </button>
      </div>
    ) : null
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
  attachmentUploadFailedListeners = []
  linkingRequestListeners = []
  linkingApprovedListeners = []
  conflictDetectedListeners = []
  itemSyncedListeners = []
  initialSyncProgressListeners = []
  queueClearedListeners = []
  clockSkewWarningListeners = []
  sessionExpiredListeners = []
  deviceRevokedListeners = []
  securityWarningListeners = []
  certificatePinFailedListeners = []
  vaultRecoveryNeededListeners = []
  logoutMock.mockClear()
  vi.mocked(useAuth).mockReturnValue({
    state: { status: 'authenticated' },
    logout: logoutMock
  } as never)

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
  api.onAttachmentUploadFailed = vi.fn((cb: EventCallback) => {
    attachmentUploadFailedListeners.push(cb)
    return () => {
      attachmentUploadFailedListeners = attachmentUploadFailedListeners.filter((l) => l !== cb)
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
  api.onConflictDetected = vi.fn((cb: EventCallback) => {
    conflictDetectedListeners.push(cb)
    return () => {
      conflictDetectedListeners = conflictDetectedListeners.filter((l) => l !== cb)
    }
  })
  api.onQueueCleared = vi.fn((cb: VoidCallback) => {
    queueClearedListeners.push(cb)
    return () => {
      queueClearedListeners = queueClearedListeners.filter((l) => l !== cb)
    }
  })
  api.onClockSkewWarning = vi.fn((cb: VoidCallback) => {
    clockSkewWarningListeners.push(cb)
    return () => {
      clockSkewWarningListeners = clockSkewWarningListeners.filter((l) => l !== cb)
    }
  })
  api.onItemSynced = vi.fn((cb: EventCallback) => {
    itemSyncedListeners.push(cb)
    return () => {
      itemSyncedListeners = itemSyncedListeners.filter((l) => l !== cb)
    }
  })
  api.onInitialSyncProgress = vi.fn((cb: EventCallback) => {
    initialSyncProgressListeners.push(cb)
    return () => {
      initialSyncProgressListeners = initialSyncProgressListeners.filter((l) => l !== cb)
    }
  })
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
  api.onVaultRecoveryNeeded = vi.fn((cb: EventCallback) => {
    vaultRecoveryNeededListeners.push(cb)
    return () => {
      vaultRecoveryNeededListeners = vaultRecoveryNeededListeners.filter((l) => l !== cb)
    }
  })
})

import { useAuth } from './auth-context'
import {
  SyncProvider,
  useSync,
  syncReducer,
  initialState,
  SYNC_PROGRESS_RETENTION_MS,
  SYNC_CONFLICT_TTL_MS,
  SYNC_CONFLICT_CAP
} from './sync-context'

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

  describe('#given attachment upload failed event #when listening', () => {
    it('#then shows a toast naming the file', async () => {
      // Nothing listened to this channel for 58 days, so a total attachment
      // upload outage was silent. Pin that it surfaces.
      const { result } = renderHook(() => useSync(), { wrapper })
      await vi.waitFor(() => expect(result.current.state.status).toBe('idle'))

      act(() => {
        for (const cb of attachmentUploadFailedListeners) {
          cb({
            noteId: 'note-1',
            diskPath: '/vault/attachments/report.pdf',
            error: 'File exceeds the plus plan file size limit'
          })
        }
      })

      expect(toastMock.error).toHaveBeenCalledWith(
        expect.stringContaining('report.pdf'),
        expect.objectContaining({ duration: 10000 })
      )
    })

    it('#then shows the plan-limit toast when the failure is file_too_large', async () => {
      // The whole point of the `file_too_large` category is that the user learns
      // the file is over their plan limit. The generic "it stays on this device"
      // toast tells them nothing actionable, so this must not be what they see.
      const { result } = renderHook(() => useSync(), { wrapper })
      await vi.waitFor(() => expect(result.current.state.status).toBe('idle'))

      act(() => {
        for (const cb of attachmentUploadFailedListeners) {
          cb({
            noteId: 'note-1',
            diskPath: '/vault/attachments/report.pdf',
            error: 'File is larger than your plan allows: 50 MB exceeds 5 MB',
            errorCategory: 'file_too_large'
          })
        }
      })

      expect(toastMock.error).toHaveBeenCalledWith(
        i18n.t('errors:sync.fileTooLarge'),
        expect.objectContaining({ duration: 10000 })
      )
      // ...and not the generic one, which would bury the actual cause.
      expect(toastMock.error).not.toHaveBeenCalledWith(
        expect.stringContaining('stays on this device'),
        expect.anything()
      )
    })

    it('#then falls back to the generic toast when no category is sent', async () => {
      // Backward compatibility: an older main process sends the event with no
      // errorCategory. That must still produce the generic toast, not a crash
      // and not a silently-dropped failure.
      const { result } = renderHook(() => useSync(), { wrapper })
      await vi.waitFor(() => expect(result.current.state.status).toBe('idle'))

      act(() => {
        for (const cb of attachmentUploadFailedListeners) {
          cb({
            noteId: 'note-1',
            diskPath: '/vault/attachments/report.pdf',
            error: 'Network unreachable'
          })
        }
      })

      expect(toastMock.error).toHaveBeenCalledWith(
        expect.stringContaining('report.pdf'),
        expect.objectContaining({ duration: 10000 })
      )
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

    it('#then shows the note-too-large toast for note_too_large status errors', async () => {
      // A 413 from the body-limit middleware is a payload problem, not a quota
      // problem. Telling the user to free up space would never fix it.
      renderHook(() => useSync(), { wrapper })
      await vi.waitFor(() => expect(syncStatusListeners.length).toBeGreaterThan(0))

      act(() => {
        for (const cb of syncStatusListeners) {
          cb({ status: 'error', pendingCount: 0, errorCategory: 'note_too_large' })
        }
      })

      expect(toastMock.error).toHaveBeenCalledWith(
        'A note is too large to sync. Splitting it into smaller notes will fix this.',
        { duration: 10000 }
      )
    })

    it('#then translates session and device revoked state errors', async () => {
      const { result } = renderHook(() => useSync(), { wrapper })
      await vi.waitFor(() => expect(sessionExpiredListeners.length).toBeGreaterThan(0))

      act(() => {
        for (const cb of sessionExpiredListeners) cb({ reason: 'token_expired' })
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

    it('#then prompts for re-auth instead of a toast when the refresh token is rejected', async () => {
      renderHook(() => useSync(), { wrapper })
      await vi.waitFor(() => expect(sessionExpiredListeners.length).toBeGreaterThan(0))

      act(() => {
        for (const cb of sessionExpiredListeners) cb({ reason: 'refresh_rejected' })
      })

      await screen.findByText('Your session has ended')
      expect(toastMock.error).not.toHaveBeenCalledWith(
        'Your session has expired. Sign in again to continue syncing.',
        { duration: 8000 }
      )
    })

    it('#then records conflicts, queue clears, item activity, and initial sync progress', async () => {
      const { result } = renderHook(() => useSync(), { wrapper })
      await vi.waitFor(() => expect(conflictDetectedListeners.length).toBeGreaterThan(0))

      act(() => {
        for (const cb of syncStatusListeners) cb({ status: 'syncing', pendingCount: 4 })
        for (const cb of conflictDetectedListeners) cb({ itemId: 'note-1', type: 'note' })
        for (const cb of itemSyncedListeners) cb({ operation: 'push' })
        for (const cb of itemSyncedListeners) cb({ operation: 'pull' })
        for (const cb of initialSyncProgressListeners) {
          cb({ phase: 'notes', processedItems: 2, totalItems: 5 })
        }
      })

      expect(result.current.state.conflicts).toEqual([
        expect.objectContaining({ itemId: 'note-1', itemType: 'note' })
      ])
      expect(result.current.state.syncActivity).toEqual({ pushCount: 1, pullCount: 1 })
      expect(result.current.state.initialSyncProgress).toEqual({
        phase: 'notes',
        current: 2,
        total: 5
      })

      act(() => {
        for (const cb of queueClearedListeners) cb()
        for (const cb of clockSkewWarningListeners) cb()
        for (const cb of initialSyncProgressListeners) {
          cb({ phase: 'complete', processedItems: 5, totalItems: 5 })
        }
        for (const cb of syncStatusListeners) cb({ status: 'idle', pendingCount: 9 })
      })

      expect(result.current.state.pendingCount).toBe(9)
      expect(result.current.state.clockSkewDetected).toBe(true)
      expect(result.current.state.initialSyncProgress).toBeNull()
      expect(result.current.state.syncActivity).toEqual({ pushCount: 0, pullCount: 0 })
    })

    it('#then bounds retained conflicts instead of growing one entry per event', async () => {
      const { result } = renderHook(() => useSync(), { wrapper })
      await vi.waitFor(() => expect(conflictDetectedListeners.length).toBeGreaterThan(0))

      act(() => {
        // One item re-detected on every pull, plus a wide burst of distinct items.
        for (let i = 0; i < 150; i++) {
          for (const cb of conflictDetectedListeners) cb({ itemId: 'note-loud', type: 'note' })
        }
        for (let i = 0; i < 150; i++) {
          for (const cb of conflictDetectedListeners) cb({ itemId: `note-${i}`, type: 'note' })
        }
      })

      expect(result.current.state.conflicts.length).toBeLessThanOrEqual(100)
      expect(result.current.state.conflicts.at(-1)?.itemId).toBe('note-149')
    })

    it('#then clears conflicts through the exposed action', async () => {
      const { result } = renderHook(() => useSync(), { wrapper })
      await vi.waitFor(() => expect(conflictDetectedListeners.length).toBeGreaterThan(0))

      act(() => {
        for (const cb of conflictDetectedListeners) cb({ itemId: 'note-1', type: 'note' })
      })
      expect(result.current.state.conflicts).toHaveLength(1)

      act(() => {
        result.current.clearConflicts()
      })
      expect(result.current.state.conflicts).toEqual([])
    })

    it('#then handles linking lifecycle, key-rotation errors, and clear/dismiss actions', async () => {
      const { result } = renderHook(() => useSync(), { wrapper })
      await vi.waitFor(() => expect(linkingRequestListeners.length).toBeGreaterThan(0))

      act(() => {
        for (const cb of linkingRequestListeners) cb({ code: 'ABCD', deviceName: 'Laptop' })
      })
      expect(result.current.linkingRequest).toEqual({ code: 'ABCD', deviceName: 'Laptop' })

      act(() => result.current.clearLinkingRequest())
      expect(result.current.linkingRequest).toBeNull()

      act(() => {
        for (const cb of linkingRequestListeners) cb({ code: 'EFGH', deviceName: 'Phone' })
        for (const cb of linkingApprovedListeners) cb({})
      })
      expect(result.current.linkingRequest).toBeNull()

      act(() => {
        for (const cb of deviceRevokedListeners) cb({ unsyncedCount: 7 })
      })
      expect(result.current.state.deviceRevoked).toEqual({ unsyncedCount: 7 })

      act(() => result.current.dismissDeviceRevoked())
      expect(result.current.state.deviceRevoked).toBeNull()
      expect(result.current.state.status).toBe('unknown')
    })

    it('#then surfaces command failures and ignores commands when signed out', async () => {
      const { result, rerender } = renderHook(() => useSync(), { wrapper })
      await vi.waitFor(() => expect(result.current.state.status).toBe('idle'))

      mockSyncOps.triggerSync.mockRejectedValueOnce(new Error('trigger broke'))
      await act(async () => {
        await result.current.triggerSync()
      })
      expect(result.current.state.error).toBe('trigger broke')

      act(() => result.current.clearError())
      expect(result.current.state.status).toBe('idle')

      mockSyncOps.pause.mockRejectedValueOnce(new Error('pause broke'))
      await act(async () => {
        await result.current.pause()
      })
      expect(result.current.state.error).toBe('pause broke')

      mockSyncOps.resume.mockRejectedValueOnce(new Error('resume broke'))
      await act(async () => {
        await result.current.resume()
      })
      expect(result.current.state.error).toBe('resume broke')

      vi.mocked(useAuth).mockReturnValue({
        state: { status: 'unauthenticated' },
        logout: logoutMock
      } as never)
      rerender()
      await act(async () => {
        await result.current.triggerSync()
        await result.current.pause()
        await result.current.resume()
      })
      expect(mockSyncOps.triggerSync).toHaveBeenCalledTimes(1)
      expect(mockSyncOps.pause).toHaveBeenCalledTimes(1)
      expect(mockSyncOps.resume).toHaveBeenCalledTimes(1)
    })

    it('#then exposes device revoked export and sign-out actions through the dialog', async () => {
      renderHook(() => useSync(), { wrapper })
      await vi.waitFor(() => expect(deviceRevokedListeners.length).toBeGreaterThan(0))

      act(() => {
        for (const cb of deviceRevokedListeners) cb({ unsyncedCount: 3 })
      })

      await vi.waitFor(() => expect(document.body).toHaveTextContent('revoked:3'))
      screen.getByText('export').click()
      screen.getByText('sign out').click()

      expect(toastMock.info).toHaveBeenCalledWith('Local data export is not yet implemented', {
        duration: 5000
      })
      expect(logoutMock).toHaveBeenCalled()
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

describe('syncReducer', () => {
  const uploadEvent = (id: string, progress: number) =>
    ({ type: 'UPLOAD_PROGRESS', attachmentId: id, progress, status: 'uploading' }) as const
  const downloadEvent = (id: string, progress: number) =>
    ({ type: 'DOWNLOAD_PROGRESS', attachmentId: id, progress, status: 'decrypting' }) as const
  const conflictEvent = (itemId: string) =>
    ({ type: 'CONFLICT_DETECTED', itemId, itemType: 'note' }) as const

  describe('#given many attachments finished transferring #when the sweep runs', () => {
    it('#then retains no completed progress entries', () => {
      let state = initialState
      for (let i = 0; i < 500; i++) {
        state = syncReducer(state, uploadEvent(`att-${i}`, 40))
        state = syncReducer(state, uploadEvent(`att-${i}`, 100))
        state = syncReducer(state, downloadEvent(`dl-${i}`, 100))
      }
      expect(Object.keys(state.uploadProgress ?? {})).toHaveLength(500)
      expect(Object.keys(state.downloadProgress ?? {})).toHaveLength(500)

      state = syncReducer(state, {
        type: 'PRUNE_STALE',
        now: Date.now() + SYNC_PROGRESS_RETENTION_MS
      })

      expect(state.uploadProgress).toBeNull()
      expect(state.downloadProgress).toBeNull()
    })
  })

  describe('#given a transfer still in flight #when the sweep runs', () => {
    it('#then drops only the finished entry', () => {
      let state = syncReducer(initialState, uploadEvent('att-live', 40))
      state = syncReducer(state, uploadEvent('att-done', 100))

      state = syncReducer(state, {
        type: 'PRUNE_STALE',
        now: Date.now() + SYNC_PROGRESS_RETENTION_MS
      })

      expect(state.uploadProgress).toEqual({ 'att-live': { progress: 40, status: 'uploading' } })
    })

    it('#then keeps a just-finished entry and returns the same state object', () => {
      const state = syncReducer(initialState, uploadEvent('att-done', 100))
      const swept = syncReducer(state, { type: 'PRUNE_STALE', now: Date.now() })

      expect(Object.keys(swept.uploadProgress ?? {})).toEqual(['att-done'])
      expect(swept).toBe(state)
    })
  })

  describe('#given a burst of conflicts #when they exceed the cap', () => {
    it('#then keeps only the newest capped entries', () => {
      let state = initialState
      for (let i = 0; i < SYNC_CONFLICT_CAP + 37; i++) {
        state = syncReducer(state, conflictEvent(`note-${i}`))
      }

      expect(SYNC_CONFLICT_CAP).toBe(100)
      expect(state.conflicts).toHaveLength(SYNC_CONFLICT_CAP)
      expect(state.conflicts[0].itemId).toBe('note-37')
      expect(state.conflicts.at(-1)?.itemId).toBe(`note-${SYNC_CONFLICT_CAP + 36}`)
    })
  })

  describe('#given one item conflicts repeatedly #when more conflicts arrive', () => {
    it('#then counts the item once instead of evicting distinct conflicts', () => {
      let state = syncReducer(initialState, conflictEvent('note-a'))
      state = syncReducer(state, conflictEvent('note-b'))
      for (let i = 0; i < 500; i++) {
        state = syncReducer(state, conflictEvent('note-loud'))
      }

      expect(state.conflicts.map((entry) => entry.itemId)).toEqual([
        'note-a',
        'note-b',
        'note-loud'
      ])
    })
  })

  describe('#given conflicts older than the TTL #when the sweep runs', () => {
    it('#then drops the expired entries', () => {
      let state = syncReducer(initialState, conflictEvent('note-old'))
      state = syncReducer(state, { type: 'PRUNE_STALE', now: Date.now() + SYNC_CONFLICT_TTL_MS })

      expect(state.conflicts).toEqual([])
    })

    it('#then keeps entries inside the TTL', () => {
      const state = syncReducer(initialState, conflictEvent('note-fresh'))
      const swept = syncReducer(state, {
        type: 'PRUNE_STALE',
        now: Date.now() + SYNC_CONFLICT_TTL_MS - 1_000
      })

      expect(swept.conflicts).toHaveLength(1)
      expect(swept).toBe(state)
    })
  })

  describe('#given conflicts #when CLEAR_CONFLICTS is dispatched', () => {
    it('#then empties the list and bails out when already empty', () => {
      const withConflict = syncReducer(initialState, conflictEvent('note-a'))
      const cleared = syncReducer(withConflict, { type: 'CLEAR_CONFLICTS' })

      expect(cleared.conflicts).toEqual([])
      expect(syncReducer(cleared, { type: 'CLEAR_CONFLICTS' })).toBe(cleared)
    })
  })
})
