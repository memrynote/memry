import { ipcMain } from 'electron'
import { InboxChannels } from '@memry/contracts/ipc-channels'
import {
  createInboxQueryHandlers,
  type InboxQueryHandlerDeps,
  type InboxQueryHandlers
} from '../inbox/queries'

export { createInboxQueryHandlers, type InboxQueryHandlerDeps, type InboxQueryHandlers }

export function registerInboxQueryHandlers(handlers: InboxQueryHandlers): void {
  ipcMain.handle(InboxChannels.invoke.LIST, (_, input) => handlers.handleList(input))
  ipcMain.handle(InboxChannels.invoke.GET_JOBS, (_, input) => handlers.handleGetJobs(input))
  ipcMain.handle(InboxChannels.invoke.GET_TAGS, () => handlers.handleGetTags())
  ipcMain.handle(InboxChannels.invoke.GET_STATS, () => handlers.handleGetStats())
  ipcMain.handle(InboxChannels.invoke.GET_PATTERNS, () => handlers.handleGetPatterns())
  ipcMain.handle(InboxChannels.invoke.GET_STALE_THRESHOLD, () => handlers.handleGetStaleThreshold())
  ipcMain.handle(InboxChannels.invoke.SET_STALE_THRESHOLD, (_, days) =>
    handlers.handleSetStaleThreshold(days)
  )
  ipcMain.handle(InboxChannels.invoke.LIST_ARCHIVED, (_, input) =>
    handlers.handleListArchived(input)
  )
  ipcMain.handle(InboxChannels.invoke.GET_FILING_HISTORY, (_, input) =>
    handlers.handleGetFilingHistory(input)
  )
}

export function unregisterInboxQueryHandlers(): void {
  ipcMain.removeHandler(InboxChannels.invoke.LIST)
  ipcMain.removeHandler(InboxChannels.invoke.GET_JOBS)
  ipcMain.removeHandler(InboxChannels.invoke.GET_TAGS)
  ipcMain.removeHandler(InboxChannels.invoke.GET_STATS)
  ipcMain.removeHandler(InboxChannels.invoke.GET_PATTERNS)
  ipcMain.removeHandler(InboxChannels.invoke.GET_STALE_THRESHOLD)
  ipcMain.removeHandler(InboxChannels.invoke.SET_STALE_THRESHOLD)
  ipcMain.removeHandler(InboxChannels.invoke.LIST_ARCHIVED)
  ipcMain.removeHandler(InboxChannels.invoke.GET_FILING_HISTORY)
}
