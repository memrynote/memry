import { ipcMain } from 'electron'

import { SYNC_CHANNELS } from '@shared/contracts/ipc-sync'

const notImplemented = (channel: string) => (): never => {
  throw new Error(`${channel} not yet implemented`)
}

export function registerSyncHandlers(): void {
  ipcMain.handle(SYNC_CHANNELS.AUTH_REQUEST_OTP, notImplemented('AUTH_REQUEST_OTP'))
  ipcMain.handle(SYNC_CHANNELS.AUTH_VERIFY_OTP, notImplemented('AUTH_VERIFY_OTP'))
  ipcMain.handle(SYNC_CHANNELS.AUTH_RESEND_OTP, notImplemented('AUTH_RESEND_OTP'))

  ipcMain.handle(SYNC_CHANNELS.SETUP_FIRST_DEVICE, notImplemented('SETUP_FIRST_DEVICE'))
  ipcMain.handle(SYNC_CHANNELS.CONFIRM_RECOVERY_PHRASE, notImplemented('CONFIRM_RECOVERY_PHRASE'))

  ipcMain.handle(SYNC_CHANNELS.GENERATE_LINKING_QR, notImplemented('GENERATE_LINKING_QR'))
  ipcMain.handle(SYNC_CHANNELS.LINK_VIA_QR, notImplemented('LINK_VIA_QR'))
  ipcMain.handle(SYNC_CHANNELS.LINK_VIA_RECOVERY, notImplemented('LINK_VIA_RECOVERY'))
  ipcMain.handle(SYNC_CHANNELS.APPROVE_LINKING, notImplemented('APPROVE_LINKING'))

  ipcMain.handle(SYNC_CHANNELS.GET_DEVICES, notImplemented('GET_DEVICES'))
  ipcMain.handle(SYNC_CHANNELS.REMOVE_DEVICE, notImplemented('REMOVE_DEVICE'))
  ipcMain.handle(SYNC_CHANNELS.RENAME_DEVICE, notImplemented('RENAME_DEVICE'))

  ipcMain.handle(SYNC_CHANNELS.GET_STATUS, notImplemented('GET_STATUS'))
  ipcMain.handle(SYNC_CHANNELS.TRIGGER_SYNC, notImplemented('TRIGGER_SYNC'))
  ipcMain.handle(SYNC_CHANNELS.GET_HISTORY, notImplemented('GET_HISTORY'))
  ipcMain.handle(SYNC_CHANNELS.GET_QUEUE_SIZE, notImplemented('GET_QUEUE_SIZE'))
  ipcMain.handle(SYNC_CHANNELS.PAUSE, notImplemented('PAUSE'))
  ipcMain.handle(SYNC_CHANNELS.RESUME, notImplemented('RESUME'))

  ipcMain.handle(SYNC_CHANNELS.UPLOAD_ATTACHMENT, notImplemented('UPLOAD_ATTACHMENT'))
  ipcMain.handle(SYNC_CHANNELS.GET_UPLOAD_PROGRESS, notImplemented('GET_UPLOAD_PROGRESS'))
  ipcMain.handle(SYNC_CHANNELS.DOWNLOAD_ATTACHMENT, notImplemented('DOWNLOAD_ATTACHMENT'))
  ipcMain.handle(SYNC_CHANNELS.GET_DOWNLOAD_PROGRESS, notImplemented('GET_DOWNLOAD_PROGRESS'))

  console.log('[IPC] Sync handlers registered')
}

export function unregisterSyncHandlers(): void {
  ipcMain.removeHandler(SYNC_CHANNELS.AUTH_REQUEST_OTP)
  ipcMain.removeHandler(SYNC_CHANNELS.AUTH_VERIFY_OTP)
  ipcMain.removeHandler(SYNC_CHANNELS.AUTH_RESEND_OTP)

  ipcMain.removeHandler(SYNC_CHANNELS.SETUP_FIRST_DEVICE)
  ipcMain.removeHandler(SYNC_CHANNELS.CONFIRM_RECOVERY_PHRASE)

  ipcMain.removeHandler(SYNC_CHANNELS.GENERATE_LINKING_QR)
  ipcMain.removeHandler(SYNC_CHANNELS.LINK_VIA_QR)
  ipcMain.removeHandler(SYNC_CHANNELS.LINK_VIA_RECOVERY)
  ipcMain.removeHandler(SYNC_CHANNELS.APPROVE_LINKING)

  ipcMain.removeHandler(SYNC_CHANNELS.GET_DEVICES)
  ipcMain.removeHandler(SYNC_CHANNELS.REMOVE_DEVICE)
  ipcMain.removeHandler(SYNC_CHANNELS.RENAME_DEVICE)

  ipcMain.removeHandler(SYNC_CHANNELS.GET_STATUS)
  ipcMain.removeHandler(SYNC_CHANNELS.TRIGGER_SYNC)
  ipcMain.removeHandler(SYNC_CHANNELS.GET_HISTORY)
  ipcMain.removeHandler(SYNC_CHANNELS.GET_QUEUE_SIZE)
  ipcMain.removeHandler(SYNC_CHANNELS.PAUSE)
  ipcMain.removeHandler(SYNC_CHANNELS.RESUME)

  ipcMain.removeHandler(SYNC_CHANNELS.UPLOAD_ATTACHMENT)
  ipcMain.removeHandler(SYNC_CHANNELS.GET_UPLOAD_PROGRESS)
  ipcMain.removeHandler(SYNC_CHANNELS.DOWNLOAD_ATTACHMENT)
  ipcMain.removeHandler(SYNC_CHANNELS.GET_DOWNLOAD_PROGRESS)

  console.log('[IPC] Sync handlers unregistered')
}
