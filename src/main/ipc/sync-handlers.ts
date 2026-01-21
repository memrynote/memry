/**
 * Sync IPC handlers.
 * Handles all sync-related IPC communication from renderer.
 *
 * Note: Most handlers are stubs until the sync engine (T074+) is implemented.
 *
 * @module ipc/sync-handlers
 */

/* eslint-disable @typescript-eslint/require-await */

import { ipcMain, BrowserWindow } from 'electron'
import { SyncChannels } from '@shared/contracts/ipc-sync'
import type {
  GetSyncStatusResponse,
  TriggerSyncResponse,
  GetDevicesResponse,
  CreateLinkingSessionResponse,
  ScanLinkingQRResponse,
  ApproveLinkingResponse,
  CompleteLinkingResponse,
  GetLinkingStatusResponse,
  RenameDeviceResponse,
  RevokeDeviceResponse,
  GetConflictsResponse,
  ResolveConflictResponse,
  SetupFirstDeviceResponse,
  VerifyRecoveryPhraseResponse
} from '@shared/contracts/ipc-sync'
import type { Device, UserPublic, SyncState } from '@shared/contracts/sync-api'
import {
  TriggerSyncRequestSchema,
  SetupFirstDeviceRequestSchema,
  VerifyRecoveryPhraseRequestSchema,
  ScanLinkingQRRequestSchema,
  RenameDeviceRequestSchema,
  RevokeDeviceRequestSchema,
  ResolveConflictRequestSchema
} from '@shared/contracts/ipc-sync'
import { createValidatedHandler, createHandler, createStringHandler } from './validate'
import { z } from 'zod'

function emitSyncEvent(channel: string, data: unknown): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send(channel, data)
  })
}

function createNotImplementedResponse(): { success: false; error: string } {
  return { success: false, error: 'Sync not yet implemented' }
}

function getDefaultSyncState(): SyncState {
  return {
    syncStatus: 'idle',
    pendingCount: 0,
    serverCursor: 0,
    deviceClock: {}
  }
}

export function registerSyncHandlers(): void {
  // ============================================================================
  // Status & Control
  // ============================================================================

  ipcMain.handle(
    SyncChannels.invoke.GET_SYNC_STATUS,
    createHandler(async (): Promise<GetSyncStatusResponse> => {
      return {
        state: getDefaultSyncState(),
        isOnline: false
      }
    })
  )

  ipcMain.handle(
    SyncChannels.invoke.TRIGGER_SYNC,
    createValidatedHandler(
      TriggerSyncRequestSchema.optional(),
      async (): Promise<TriggerSyncResponse> => {
        return {
          success: false,
          itemsSynced: 0,
          errors: ['Sync not yet implemented']
        }
      }
    )
  )

  ipcMain.handle(
    SyncChannels.invoke.PAUSE_SYNC,
    createHandler(async () => createNotImplementedResponse())
  )

  ipcMain.handle(
    SyncChannels.invoke.RESUME_SYNC,
    createHandler(async () => createNotImplementedResponse())
  )

  ipcMain.handle(
    SyncChannels.invoke.GET_SYNC_HISTORY,
    createHandler(async () => ({ history: [] }))
  )

  ipcMain.handle(
    SyncChannels.invoke.CLEAR_SYNC_QUEUE,
    createHandler(async () => createNotImplementedResponse())
  )

  // ============================================================================
  // First Device Setup
  // ============================================================================

  ipcMain.handle(
    SyncChannels.invoke.SETUP_FIRST_DEVICE,
    createValidatedHandler(
      SetupFirstDeviceRequestSchema,
      async (): Promise<SetupFirstDeviceResponse> => {
        return {
          recoveryPhrase: [],
          device: {} as Device,
          user: {} as UserPublic
        }
      }
    )
  )

  ipcMain.handle(
    SyncChannels.invoke.VERIFY_RECOVERY_PHRASE,
    createValidatedHandler(
      VerifyRecoveryPhraseRequestSchema,
      async (): Promise<VerifyRecoveryPhraseResponse> => {
        return { valid: false, error: 'Not implemented' }
      }
    )
  )

  ipcMain.handle(
    SyncChannels.invoke.GET_RECOVERY_PHRASE,
    createHandler(async () => ({ phrase: [] as string[] }))
  )

  // ============================================================================
  // Device Linking
  // ============================================================================

  ipcMain.handle(
    SyncChannels.invoke.CREATE_LINKING_SESSION,
    createHandler(async (): Promise<CreateLinkingSessionResponse> => {
      return {
        sessionId: '',
        qrCodeDataUrl: '',
        expiresAt: 0
      }
    })
  )

  ipcMain.handle(
    SyncChannels.invoke.SCAN_LINKING_QR,
    createValidatedHandler(
      ScanLinkingQRRequestSchema,
      async (): Promise<ScanLinkingQRResponse> => createNotImplementedResponse()
    )
  )

  ipcMain.handle(
    SyncChannels.invoke.APPROVE_LINKING,
    createValidatedHandler(
      z.object({ sessionId: z.string().uuid() }),
      async (): Promise<ApproveLinkingResponse> => createNotImplementedResponse()
    )
  )

  ipcMain.handle(
    SyncChannels.invoke.COMPLETE_LINKING,
    createValidatedHandler(
      z.object({ sessionId: z.string().uuid() }),
      async (): Promise<CompleteLinkingResponse> => createNotImplementedResponse()
    )
  )

  ipcMain.handle(
    SyncChannels.invoke.CANCEL_LINKING,
    createStringHandler(async () => createNotImplementedResponse())
  )

  ipcMain.handle(
    SyncChannels.invoke.GET_LINKING_STATUS,
    createValidatedHandler(
      z.object({ sessionId: z.string().uuid() }),
      async (): Promise<GetLinkingStatusResponse> => ({ session: null })
    )
  )

  // ============================================================================
  // Device Management
  // ============================================================================

  ipcMain.handle(
    SyncChannels.invoke.GET_DEVICES,
    createHandler(async (): Promise<GetDevicesResponse> => {
      return {
        devices: [],
        currentDeviceId: ''
      }
    })
  )

  ipcMain.handle(
    SyncChannels.invoke.GET_CURRENT_DEVICE,
    createHandler(async (): Promise<Device | null> => null)
  )

  ipcMain.handle(
    SyncChannels.invoke.RENAME_DEVICE,
    createValidatedHandler(
      RenameDeviceRequestSchema,
      async (): Promise<RenameDeviceResponse> => createNotImplementedResponse()
    )
  )

  ipcMain.handle(
    SyncChannels.invoke.REVOKE_DEVICE,
    createValidatedHandler(
      RevokeDeviceRequestSchema,
      async (): Promise<RevokeDeviceResponse> => createNotImplementedResponse()
    )
  )

  // ============================================================================
  // User Account
  // ============================================================================

  ipcMain.handle(
    SyncChannels.invoke.GET_USER,
    createHandler(async (): Promise<UserPublic | null> => null)
  )

  ipcMain.handle(
    SyncChannels.invoke.DELETE_ACCOUNT,
    createHandler(async () => createNotImplementedResponse())
  )

  // ============================================================================
  // Conflict Resolution
  // ============================================================================

  ipcMain.handle(
    SyncChannels.invoke.GET_CONFLICTS,
    createHandler(async (): Promise<GetConflictsResponse> => ({ conflicts: [] }))
  )

  ipcMain.handle(
    SyncChannels.invoke.RESOLVE_CONFLICT,
    createValidatedHandler(
      ResolveConflictRequestSchema,
      async (): Promise<ResolveConflictResponse> => createNotImplementedResponse()
    )
  )

  console.log('[IPC] Sync handlers registered')
}

export function unregisterSyncHandlers(): void {
  Object.values(SyncChannels.invoke).forEach((channel) => {
    ipcMain.removeHandler(channel)
  })
  console.log('[IPC] Sync handlers unregistered')
}

// Exported for use by sync engine (T074+) to emit events to renderer
export { emitSyncEvent }
