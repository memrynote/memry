import { ipcMain } from 'electron'
import { InboxChannels } from '@memry/contracts/ipc-channels'
import {
  createInboxBatchHandlers,
  type InboxBatchHandlerDeps,
  type InboxBatchHandlers
} from '../inbox/batch'

export { createInboxBatchHandlers, type InboxBatchHandlerDeps, type InboxBatchHandlers }

export function registerInboxBatchHandlers(handlers: InboxBatchHandlers): void {
  ipcMain.handle(InboxChannels.invoke.BULK_SNOOZE, (_, input) => handlers.handleBulkSnooze(input))
  ipcMain.handle(InboxChannels.invoke.BULK_FILE, (_, input) => handlers.handleBulkFile(input))
  ipcMain.handle(InboxChannels.invoke.BULK_ARCHIVE, (_, input) => handlers.handleBulkArchive(input))
  ipcMain.handle(InboxChannels.invoke.BULK_TAG, (_, input) => handlers.handleBulkTag(input))
  ipcMain.handle(InboxChannels.invoke.FILE_ALL_STALE, () => handlers.handleFileAllStale())
}

export function unregisterInboxBatchHandlers(): void {
  ipcMain.removeHandler(InboxChannels.invoke.BULK_SNOOZE)
  ipcMain.removeHandler(InboxChannels.invoke.BULK_FILE)
  ipcMain.removeHandler(InboxChannels.invoke.BULK_ARCHIVE)
  ipcMain.removeHandler(InboxChannels.invoke.BULK_TAG)
  ipcMain.removeHandler(InboxChannels.invoke.FILE_ALL_STALE)
}
