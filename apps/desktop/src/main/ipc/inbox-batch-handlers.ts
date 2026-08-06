import { ipcMain } from 'electron'
import { InboxChannels } from '@memry/contracts/ipc-channels'
import {
  createInboxBatchHandlers,
  type InboxBatchHandlerDeps,
  type InboxBatchHandlers
} from '../inbox/batch'
import { trackMainEvent } from '../telemetry/track'
import type { TelemetryEventName } from '@memry/contracts/telemetry-api'

export { createInboxBatchHandlers, type InboxBatchHandlerDeps, type InboxBatchHandlers }

// Bulk operations bypass the per-item IPC handlers where inbox_filed /
// inbox_archived / inbox_snoozed are tracked; emit one event per bulk call
// with the processed count so bulk usage is not invisible.
function trackBulk(
  name: TelemetryEventName,
  action: string,
  source: string,
  result: { success: boolean; processedCount: number } | undefined
): void {
  trackMainEvent(name, {
    surface: 'inbox',
    action,
    source,
    result: result?.success ? 'success' : 'failed',
    metrics: { itemCount: result?.processedCount ?? 0 }
  })
}

export function registerInboxBatchHandlers(handlers: InboxBatchHandlers): void {
  ipcMain.handle(InboxChannels.invoke.BULK_SNOOZE, async (_, input) => {
    const result = await handlers.handleBulkSnooze(input)
    trackBulk('inbox_snoozed', 'snoozed', 'bulk', result)
    return result
  })
  ipcMain.handle(InboxChannels.invoke.BULK_FILE, async (_, input) => {
    const result = await handlers.handleBulkFile(input)
    trackBulk('inbox_filed', 'filed', 'bulk', result)
    return result
  })
  ipcMain.handle(InboxChannels.invoke.BULK_ARCHIVE, async (_, input) => {
    const result = await handlers.handleBulkArchive(input)
    trackBulk('inbox_archived', 'archived', 'bulk', result)
    return result
  })
  ipcMain.handle(InboxChannels.invoke.BULK_TAG, (_, input) => handlers.handleBulkTag(input))
  ipcMain.handle(InboxChannels.invoke.FILE_ALL_STALE, async () => {
    const result = await handlers.handleFileAllStale()
    trackBulk('inbox_filed', 'filed', 'stale_sweep', result)
    return result
  })
}

export function unregisterInboxBatchHandlers(): void {
  ipcMain.removeHandler(InboxChannels.invoke.BULK_SNOOZE)
  ipcMain.removeHandler(InboxChannels.invoke.BULK_FILE)
  ipcMain.removeHandler(InboxChannels.invoke.BULK_ARCHIVE)
  ipcMain.removeHandler(InboxChannels.invoke.BULK_TAG)
  ipcMain.removeHandler(InboxChannels.invoke.FILE_ALL_STALE)
}
