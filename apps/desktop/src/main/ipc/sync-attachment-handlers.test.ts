import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { mockIpcMain, resetIpcMocks } from '@tests/utils/mock-ipc'
import { SYNC_CHANNELS } from '@memry/contracts/ipc-sync'

// ============================================================================
// Mocks
// ============================================================================

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
    getAllWindows: vi.fn().mockReturnValue([])
  }
}))

vi.mock('../sync/attachments', () => ({
  AttachmentSyncService: vi.fn().mockImplementation(() => ({
    uploadAttachment: vi.fn(),
    downloadAttachment: vi.fn(),
    getUploadProgress: vi.fn(),
    getDownloadProgress: vi.fn(),
    setProgressCallback: vi.fn()
  }))
}))

vi.mock('../sync/upload-queue', () => ({
  UploadQueue: vi.fn().mockImplementation(() => ({
    enqueue: vi.fn(),
    dispose: vi.fn()
  }))
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
  getOrDeriveVaultKey: vi.fn().mockResolvedValue(new Uint8Array(32)),
  secureCleanup: vi.fn(),
  retrieveKey: vi.fn().mockResolvedValue(new Uint8Array(64))
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

describe('sync-attachment-handlers', () => {
  beforeEach(() => {
    resetIpcMocks()
    mockOnSaved.mockClear()
    mockOnDownloadNeeded.mockClear()
    mockRemoveAll.mockClear()
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
})
