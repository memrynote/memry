import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { invokeHandler, mockIpcMain, resetIpcMocks } from '@tests/utils/mock-ipc'
import { SYNC_CHANNELS, SYNC_EVENTS } from '@memry/contracts/ipc-sync'

// ============================================================================
// Mocks
// ============================================================================

const attachmentMocks = vi.hoisted(() => ({
  sent: [] as Array<{ channel: string; payload: unknown }>,
  stat: vi.fn(),
  service: {
    uploadAttachment: vi.fn(),
    downloadAttachment: vi.fn(),
    getUploadProgress: vi.fn(),
    getDownloadProgress: vi.fn(),
    setProgressCallback: vi.fn()
  },
  queue: {
    enqueue: vi.fn(),
    dispose: vi.fn()
  }
}))

vi.mock('node:fs', () => ({
  default: {
    promises: {
      stat: attachmentMocks.stat
    }
  }
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: unknown) => {
      mockIpcMain.handle(channel, handler as Parameters<typeof mockIpcMain.handle>[1])
    }),
    removeHandler: vi.fn((channel: string) => {
      mockIpcMain.removeHandler(channel)
    })
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => [
      {
        isDestroyed: () => false,
        webContents: {
          send: (channel: string, payload: unknown) =>
            attachmentMocks.sent.push({ channel, payload })
        }
      }
    ])
  },
  net: { fetch: vi.fn() }
}))

// The real electron-store is never touched in tests; the entitlement cache reads
// and writes through this fake so the plan-limit invalidation can be asserted.
const storeData = vi.hoisted(() => ({ sync: {} as Record<string, unknown> }))
vi.mock('../store', () => ({
  store: {
    get: (key: string) => (storeData as unknown as Record<string, unknown>)[key],
    set: (key: string, value: unknown) => {
      ;(storeData as unknown as Record<string, unknown>)[key] = value
    }
  }
}))

// Keep the REAL AttachmentTooLargeError class identity. `classifyError` narrows
// with `instanceof` against the class from http-client, so a stand-in here would
// silently classify as `unknown` and the test would prove nothing.
vi.mock('../sync/attachments', async () => {
  const actual = await vi.importActual<typeof import('../sync/http-client')>('../sync/http-client')
  return {
    AttachmentSyncService: vi.fn().mockImplementation(function AttachmentSyncServiceMock() {
      return attachmentMocks.service
    }),
    AttachmentTooLargeError: actual.AttachmentTooLargeError
  }
})

vi.mock('../sync/upload-queue', () => ({
  UploadQueue: vi.fn().mockImplementation(function UploadQueueMock() {
    return attachmentMocks.queue
  })
}))

const mockOnSaved = vi.fn()
const mockOnDownloadNeeded = vi.fn()
const mockRemoveAll = vi.fn()
vi.mock('../sync/attachment-events', () => ({
  attachmentEvents: {
    onSaved: (fn: unknown) => mockOnSaved(fn),
    onDownloadNeeded: (fn: unknown) => mockOnDownloadNeeded(fn),
    removeAllListeners: (evt: string) => mockRemoveAll(evt)
  }
}))

vi.mock('../sync/crdt-writeback', () => ({
  markWritebackIgnored: vi.fn()
}))

vi.mock('../vault/index', () => ({
  getStatus: vi.fn().mockReturnValue({ path: null })
}))

vi.mock('../crypto', () => ({
  getDevicePublicKey: vi.fn(() => new Uint8Array(32)),
  getOrInitializeLocalVaultKey: vi.fn().mockResolvedValue(new Uint8Array(32)),
  secureCleanup: vi.fn(),
  retrieveKey: vi.fn().mockResolvedValue(new Uint8Array(64))
}))

vi.mock('../agent/storage/vault-id', () => ({
  getOrCreateVaultUuid: vi.fn(() => 'vault-1')
}))

vi.mock('../database/client', () => ({
  getDatabase: vi.fn(),
  isDatabaseInitialized: vi.fn().mockReturnValue(false)
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

vi.mock('../sync/note-attachment-metadata', () => ({
  recordDownloadedFileSize: vi.fn(),
  recordUploadedAttachment: vi.fn()
}))

vi.mock('../sync/runtime', () => ({
  getNetworkMonitor: vi.fn().mockReturnValue(null)
}))

vi.mock('../sync/token-manager', () => ({
  getValidAccessToken: vi.fn().mockResolvedValue(null)
}))

vi.mock('libsodium-wrappers-sumo', () => ({
  default: {
    from_base64: vi.fn(() => new Uint8Array(32)),
    to_base64: vi.fn(() => 'b64'),
    base64_variants: { ORIGINAL: 0 }
  }
}))

import {
  clearAttachmentState,
  registerAttachmentHandlers,
  unregisterAttachmentHandlers
} from './sync-attachment-handlers'
import { getStatus as getVaultStatus } from '../vault/index'
import { getValidAccessToken } from '../sync/token-manager'
import { isDatabaseInitialized } from '../database/client'
import {
  recordDownloadedFileSize,
  recordUploadedAttachment
} from '../sync/note-attachment-metadata'
import { markWritebackIgnored } from '../sync/crdt-writeback'
import { AttachmentTooLargeError } from '../sync/attachments'
import { SyncServerError } from '../sync/http-client'
import { setCachedEntitlementFromStatus, getCachedMaxFileSize } from '../billing/entitlement-cache'
import type { BillingStatus } from '../billing/paddle-billing'

describe('sync-attachment-handlers', () => {
  beforeEach(() => {
    resetIpcMocks()
    storeData.sync = {}
    attachmentMocks.sent = []
    attachmentMocks.service.uploadAttachment.mockReset()
    attachmentMocks.service.downloadAttachment
      .mockReset()
      .mockResolvedValue({ filePath: '/tmp/file.pdf' })
    attachmentMocks.service.getUploadProgress.mockReset()
    attachmentMocks.service.getDownloadProgress.mockReset()
    attachmentMocks.service.setProgressCallback.mockReset()
    attachmentMocks.stat.mockReset().mockResolvedValue({ size: 1234 })
    attachmentMocks.queue.enqueue
      .mockReset()
      .mockResolvedValue({ attachmentId: 'attachment-1', sessionId: 'session-1' })
    attachmentMocks.queue.dispose.mockReset()
    mockOnSaved.mockClear()
    mockOnDownloadNeeded.mockClear()
    mockRemoveAll.mockClear()
    vi.mocked(getValidAccessToken).mockResolvedValue(null)
    vi.mocked(getVaultStatus).mockReturnValue({ path: null } as any)
    vi.mocked(isDatabaseInitialized).mockReturnValue(false)
    clearAttachmentState()
  })

  afterEach(() => {
    unregisterAttachmentHandlers()
  })

  // #given handlers are registered
  it('registers all 4 attachment IPC channels on registerAttachmentHandlers', () => {
    // #when
    registerAttachmentHandlers()

    // #then
    expect(mockIpcMain._getHandler(SYNC_CHANNELS.UPLOAD_ATTACHMENT)).toBeDefined()
    expect(mockIpcMain._getHandler(SYNC_CHANNELS.GET_UPLOAD_PROGRESS)).toBeDefined()
    expect(mockIpcMain._getHandler(SYNC_CHANNELS.DOWNLOAD_ATTACHMENT)).toBeDefined()
    expect(mockIpcMain._getHandler(SYNC_CHANNELS.GET_DOWNLOAD_PROGRESS)).toBeDefined()
  })

  it('subscribes to attachmentEvents on register', () => {
    // #when
    registerAttachmentHandlers()

    // #then
    expect(mockOnSaved).toHaveBeenCalledTimes(1)
    expect(mockOnDownloadNeeded).toHaveBeenCalledTimes(1)
  })

  it('removes handlers and event listeners on unregister', () => {
    // #given
    registerAttachmentHandlers()

    // #when
    unregisterAttachmentHandlers()

    // #then
    expect(mockIpcMain._getHandler(SYNC_CHANNELS.UPLOAD_ATTACHMENT)).toBeUndefined()
    expect(mockIpcMain._getHandler(SYNC_CHANNELS.GET_UPLOAD_PROGRESS)).toBeUndefined()
    expect(mockIpcMain._getHandler(SYNC_CHANNELS.DOWNLOAD_ATTACHMENT)).toBeUndefined()
    expect(mockIpcMain._getHandler(SYNC_CHANNELS.GET_DOWNLOAD_PROGRESS)).toBeUndefined()
    expect(mockRemoveAll).toHaveBeenCalledWith('saved')
    expect(mockRemoveAll).toHaveBeenCalledWith('download-needed')
  })

  it('clearAttachmentState disposes the upload queue and resets the service', () => {
    // #given the module still holds singletons from a prior session
    registerAttachmentHandlers()

    // #when
    clearAttachmentState()

    // #then — safe to call multiple times without throwing
    expect(() => clearAttachmentState()).not.toThrow()
  })

  it('uploads through the queue after authentication and maps upload progress', async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue('token-1')
    attachmentMocks.service.getUploadProgress.mockReturnValue({
      attachmentId: 'attachment-1',
      chunksCompleted: 2,
      totalChunks: 4,
      phase: 'uploading'
    })
    registerAttachmentHandlers()

    await expect(
      invokeHandler(SYNC_CHANNELS.UPLOAD_ATTACHMENT, {
        noteId: 'note-1',
        filePath: '/vault/attachments/file.pdf'
      })
    ).resolves.toEqual({
      success: true,
      attachmentId: 'attachment-1',
      sessionId: 'session-1'
    })

    expect(attachmentMocks.queue.enqueue).toHaveBeenCalledWith(
      'note-1',
      '/vault/attachments/file.pdf',
      expect.any(Function)
    )

    await expect(
      invokeHandler(SYNC_CHANNELS.GET_UPLOAD_PROGRESS, { sessionId: 'session-1' })
    ).resolves.toEqual({
      progress: 50,
      uploadedChunks: 2,
      totalChunks: 4,
      status: 'uploading'
    })
  })

  it('downloads only inside the vault attachments directory and clears progress callbacks', async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue('token-1')
    vi.mocked(getVaultStatus).mockReturnValue({ path: '/vault' } as any)
    registerAttachmentHandlers()

    await expect(
      invokeHandler(SYNC_CHANNELS.DOWNLOAD_ATTACHMENT, {
        attachmentId: 'attachment-1',
        targetPath: '/vault/attachments/file.pdf'
      })
    ).resolves.toEqual({ success: true, filePath: '/tmp/file.pdf' })

    expect(attachmentMocks.service.downloadAttachment).toHaveBeenCalledWith(
      'attachment-1',
      '/vault/attachments/file.pdf'
    )
    expect(attachmentMocks.service.setProgressCallback).toHaveBeenLastCalledWith(null)

    await expect(
      invokeHandler(SYNC_CHANNELS.DOWNLOAD_ATTACHMENT, {
        attachmentId: 'attachment-1',
        targetPath: '/outside/file.pdf'
      })
    ).resolves.toEqual({
      success: false,
      error: 'Target path must be within the vault attachments directory'
    })
  })

  it('maps download progress and uploads saved attachments from event callbacks', async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue('token-1')
    attachmentMocks.service.getDownloadProgress.mockReturnValue({
      attachmentId: 'attachment-1',
      chunksCompleted: 3,
      totalChunks: 6,
      phase: 'downloading'
    })
    registerAttachmentHandlers()

    await expect(
      invokeHandler(SYNC_CHANNELS.GET_DOWNLOAD_PROGRESS, { attachmentId: 'attachment-1' })
    ).resolves.toEqual({
      progress: 50,
      downloadedChunks: 3,
      totalChunks: 6,
      status: 'downloading'
    })

    const onSaved = mockOnSaved.mock.calls[0][0] as (event: {
      noteId: string
      diskPath: string
    }) => void
    onSaved({ noteId: 'note-1', diskPath: '/vault/attachments/saved.pdf' })

    await vi.waitFor(() =>
      expect(attachmentMocks.queue.enqueue).toHaveBeenCalledWith(
        'note-1',
        '/vault/attachments/saved.pdf',
        expect.any(Function)
      )
    )
  })

  it('covers auth failures, missing progress, and zero-chunk progress mapping', async () => {
    registerAttachmentHandlers()

    await expect(
      invokeHandler(SYNC_CHANNELS.UPLOAD_ATTACHMENT, {
        noteId: 'note-1',
        filePath: '/vault/attachments/file.pdf'
      })
    ).resolves.toEqual({ success: false, error: 'Not authenticated' })

    await expect(
      invokeHandler(SYNC_CHANNELS.DOWNLOAD_ATTACHMENT, {
        attachmentId: 'attachment-1',
        targetPath: '/vault/attachments/file.pdf'
      })
    ).resolves.toEqual({ success: false, error: 'Not authenticated' })

    expect(
      await invokeHandler(SYNC_CHANNELS.GET_UPLOAD_PROGRESS, { sessionId: 'missing' })
    ).toBeNull()
    attachmentMocks.service.getUploadProgress.mockReturnValue({
      attachmentId: 'attachment-1',
      chunksCompleted: 0,
      totalChunks: 0,
      phase: 'uploading'
    })
    await expect(
      invokeHandler(SYNC_CHANNELS.GET_UPLOAD_PROGRESS, { sessionId: 'zero' })
    ).resolves.toEqual({
      progress: 0,
      uploadedChunks: 0,
      totalChunks: 0,
      status: 'uploading'
    })
  })

  it('uploads and downloads attachment events, recording metadata only when the DB is ready', async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue('token-1')
    vi.mocked(isDatabaseInitialized).mockReturnValue(true)
    registerAttachmentHandlers()

    const onSaved = mockOnSaved.mock.calls[0][0] as (event: {
      noteId: string
      diskPath: string
    }) => void
    onSaved({ noteId: 'note-1', diskPath: '/vault/attachments/saved.pdf' })
    await vi.waitFor(() =>
      expect(recordUploadedAttachment).toHaveBeenCalledWith('note-1', 'attachment-1')
    )

    const onDownloadNeeded = mockOnDownloadNeeded.mock.calls[0][0] as (event: {
      noteId: string
      attachmentId: string
      diskPath: string
    }) => void
    onDownloadNeeded({
      noteId: 'note-1',
      attachmentId: 'attachment-1',
      diskPath: '/vault/attachments/file.pdf'
    })
    await vi.waitFor(() =>
      expect(attachmentMocks.service.downloadAttachment).toHaveBeenCalledWith(
        'attachment-1',
        '/vault/attachments/file.pdf'
      )
    )
    expect(markWritebackIgnored).toHaveBeenCalledWith('/vault/attachments/file.pdf')
    await vi.waitFor(() => expect(recordDownloadedFileSize).toHaveBeenCalledWith('note-1', 1234))
  })

  it('broadcasts failures from async attachment event callbacks', async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue('token-1')
    attachmentMocks.queue.enqueue.mockRejectedValueOnce(new Error('upload boom'))
    attachmentMocks.service.downloadAttachment.mockRejectedValueOnce(new Error('download boom'))
    registerAttachmentHandlers()

    const onSaved = mockOnSaved.mock.calls[0][0] as (event: {
      noteId: string
      diskPath: string
    }) => void
    onSaved({ noteId: 'note-1', diskPath: '/vault/attachments/saved.pdf' })
    await vi.waitFor(() =>
      expect(attachmentMocks.sent).toContainEqual({
        channel: SYNC_EVENTS.ATTACHMENT_UPLOAD_FAILED,
        payload: {
          noteId: 'note-1',
          diskPath: '/vault/attachments/saved.pdf',
          error: 'upload boom',
          errorCategory: 'unknown'
        }
      })
    )

    const onDownloadNeeded = mockOnDownloadNeeded.mock.calls[0][0] as (event: {
      noteId: string
      attachmentId: string
      diskPath: string
    }) => void
    onDownloadNeeded({
      noteId: 'note-1',
      attachmentId: 'attachment-1',
      diskPath: '/vault/attachments/file.pdf'
    })
    await vi.waitFor(() =>
      expect(attachmentMocks.sent).toContainEqual({
        channel: SYNC_EVENTS.ATTACHMENT_UPLOAD_FAILED,
        payload: {
          noteId: 'note-1',
          diskPath: '/vault/attachments/file.pdf',
          error: 'download boom'
        }
      })
    )
  })

  // ==========================================================================
  // Plan file-size failures — the category has to survive the trip to the
  // renderer, and a server rejection has to correct the cache that produced it.
  // ==========================================================================

  describe('plan file-size failures', () => {
    const uploadFailed = (): Record<string, unknown> | undefined =>
      attachmentMocks.sent.find((s) => s.channel === SYNC_EVENTS.ATTACHMENT_UPLOAD_FAILED)
        ?.payload as Record<string, unknown> | undefined

    const driveSavedUpload = async (err: unknown): Promise<void> => {
      vi.mocked(getValidAccessToken).mockResolvedValue('token-1')
      attachmentMocks.queue.enqueue.mockRejectedValueOnce(err)
      registerAttachmentHandlers()

      const onSaved = mockOnSaved.mock.calls[0][0] as (event: {
        noteId: string
        diskPath: string
      }) => void
      onSaved({ noteId: 'note-1', diskPath: '/vault/attachments/report.pdf' })
      await vi.waitFor(() => expect(uploadFailed()).toBeDefined())
    }

    const cachePlanLimit = (maxFileSize: number): void => {
      setCachedEntitlementFromStatus({
        plan: 'plus',
        status: 'active',
        source: 'paddle',
        email: null,
        limits: { storageLimit: 0, maxFileSize, maxVaults: 0, versionHistoryDays: 0 },
        usage: { storageUsed: 0 },
        expiresAt: null,
        canManageBilling: false
      } as BillingStatus)
    }

    it('tags a local plan-preflight rejection as file_too_large', async () => {
      // This is the only path that raises AttachmentTooLargeError. Without the
      // category the renderer can only show the generic "stays on this device".
      await driveSavedUpload(
        new AttachmentTooLargeError(
          'File is larger than your plan allows: 6 MB exceeds 5 MB',
          6 * 1024 * 1024,
          5 * 1024 * 1024
        )
      )

      expect(uploadFailed()).toMatchObject({
        noteId: 'note-1',
        diskPath: '/vault/attachments/report.pdf',
        errorCategory: 'file_too_large'
      })
    })

    it('tags a server 413 STORAGE_FILE_TOO_LARGE as file_too_large', async () => {
      await driveSavedUpload(
        new SyncServerError(
          'Failed to initiate upload: STORAGE_FILE_TOO_LARGE',
          413,
          'STORAGE_FILE_TOO_LARGE'
        )
      )

      expect(uploadFailed()).toMatchObject({ errorCategory: 'file_too_large' })
    })

    it('a server plan-limit rejection invalidates the cached limit', async () => {
      // The server just contradicted the cached number, so keeping it would make
      // every later preflight re-apply an answer the authority already rejected.
      cachePlanLimit(5 * 1024 * 1024)
      expect(getCachedMaxFileSize()).toBe(5 * 1024 * 1024)

      await driveSavedUpload(
        new SyncServerError(
          'Failed to initiate upload: STORAGE_FILE_TOO_LARGE',
          413,
          'STORAGE_FILE_TOO_LARGE'
        )
      )

      expect(getCachedMaxFileSize()).toBeNull()
    })

    it('a local preflight rejection leaves the cache alone', async () => {
      // The local preflight is downstream of the cache — it is not evidence
      // about the server, so it must not discard a limit the server never
      // disputed.
      cachePlanLimit(5 * 1024 * 1024)

      await driveSavedUpload(
        new AttachmentTooLargeError('File is larger than your plan allows', 6, 5)
      )

      expect(getCachedMaxFileSize()).toBe(5 * 1024 * 1024)
    })

    it('an unrelated server failure keeps its own category and the cache', async () => {
      cachePlanLimit(5 * 1024 * 1024)

      await driveSavedUpload(new SyncServerError('boom', 500, 'boom'))

      expect(uploadFailed()).toMatchObject({ errorCategory: 'server_error' })
      expect(getCachedMaxFileSize()).toBe(5 * 1024 * 1024)
    })
  })
})
