import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { invokeHandler, mockIpcMain, resetIpcMocks } from '@tests/utils/mock-ipc'
import { SYNC_CHANNELS } from '@shared/contracts/ipc-sync'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: unknown) => {
      mockIpcMain.handle(channel, handler as Parameters<typeof mockIpcMain.handle>[1])
    }),
    removeHandler: vi.fn((channel: string) => {
      mockIpcMain.removeHandler(channel)
    })
  }
}))

import { registerSyncHandlers, unregisterSyncHandlers } from './sync-handlers'

const ALL_SYNC_HANDLER_CHANNELS = [
  SYNC_CHANNELS.AUTH_REQUEST_OTP,
  SYNC_CHANNELS.AUTH_VERIFY_OTP,
  SYNC_CHANNELS.AUTH_RESEND_OTP,
  SYNC_CHANNELS.SETUP_FIRST_DEVICE,
  SYNC_CHANNELS.CONFIRM_RECOVERY_PHRASE,
  SYNC_CHANNELS.GENERATE_LINKING_QR,
  SYNC_CHANNELS.LINK_VIA_QR,
  SYNC_CHANNELS.LINK_VIA_RECOVERY,
  SYNC_CHANNELS.APPROVE_LINKING,
  SYNC_CHANNELS.GET_DEVICES,
  SYNC_CHANNELS.REMOVE_DEVICE,
  SYNC_CHANNELS.RENAME_DEVICE,
  SYNC_CHANNELS.GET_STATUS,
  SYNC_CHANNELS.TRIGGER_SYNC,
  SYNC_CHANNELS.GET_HISTORY,
  SYNC_CHANNELS.GET_QUEUE_SIZE,
  SYNC_CHANNELS.PAUSE,
  SYNC_CHANNELS.RESUME,
  SYNC_CHANNELS.UPLOAD_ATTACHMENT,
  SYNC_CHANNELS.GET_UPLOAD_PROGRESS,
  SYNC_CHANNELS.DOWNLOAD_ATTACHMENT,
  SYNC_CHANNELS.GET_DOWNLOAD_PROGRESS
] as const

describe('sync IPC handlers', () => {
  beforeEach(() => {
    resetIpcMocks()
    vi.clearAllMocks()
  })

  afterEach(() => {
    unregisterSyncHandlers()
  })

  it('registers handlers for all sync channels', () => {
    registerSyncHandlers()

    for (const channel of ALL_SYNC_HANDLER_CHANNELS) {
      expect(mockIpcMain.handle).toHaveBeenCalledWith(channel, expect.any(Function))
    }
  })

  it('throws explicit not-implemented error when invoked', async () => {
    registerSyncHandlers()

    await expect(invokeHandler(SYNC_CHANNELS.TRIGGER_SYNC)).rejects.toThrow(
      'TRIGGER_SYNC not yet implemented'
    )
  })

  it('unregisters all sync handlers', () => {
    registerSyncHandlers()
    unregisterSyncHandlers()

    for (const channel of ALL_SYNC_HANDLER_CHANNELS) {
      expect(mockIpcMain.removeHandler).toHaveBeenCalledWith(channel)
    }
  })
})
