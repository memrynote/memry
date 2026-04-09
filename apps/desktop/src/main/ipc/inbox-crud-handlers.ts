import { ipcMain } from 'electron'
import { InboxChannels } from '@memry/contracts/ipc-channels'
import {
  createInboxCrudHandlers,
  type InboxCrudHandlerDeps,
  type InboxCrudHandlers
} from '../inbox/crud'

export { createInboxCrudHandlers, type InboxCrudHandlerDeps, type InboxCrudHandlers }

export function registerInboxCrudHandlers(handlers: InboxCrudHandlers): void {
  ipcMain.handle(InboxChannels.invoke.GET, (_, id) => handlers.handleGet(id))
  ipcMain.handle(InboxChannels.invoke.UPDATE, (_, input) => handlers.handleUpdate(input))
  ipcMain.handle(InboxChannels.invoke.ARCHIVE, (_, id) => handlers.handleArchive(id))
  ipcMain.handle(InboxChannels.invoke.ADD_TAG, (_, itemId, tag) =>
    handlers.handleAddTag(itemId, tag)
  )
  ipcMain.handle(InboxChannels.invoke.REMOVE_TAG, (_, itemId, tag) =>
    handlers.handleRemoveTag(itemId, tag)
  )
  ipcMain.handle(InboxChannels.invoke.MARK_VIEWED, (_, itemId) => handlers.handleMarkViewed(itemId))
  ipcMain.handle(InboxChannels.invoke.UNARCHIVE, (_, id) => handlers.handleUnarchive(id))
  ipcMain.handle(InboxChannels.invoke.DELETE_PERMANENT, (_, id) =>
    handlers.handleDeletePermanent(id)
  )
  ipcMain.handle(InboxChannels.invoke.UNDO_FILE, (_, id) => handlers.handleUndoFile(id))
  ipcMain.handle(InboxChannels.invoke.UNDO_ARCHIVE, (_, id) => handlers.handleUndoArchive(id))
}

export function unregisterInboxCrudHandlers(): void {
  ipcMain.removeHandler(InboxChannels.invoke.GET)
  ipcMain.removeHandler(InboxChannels.invoke.UPDATE)
  ipcMain.removeHandler(InboxChannels.invoke.ARCHIVE)
  ipcMain.removeHandler(InboxChannels.invoke.ADD_TAG)
  ipcMain.removeHandler(InboxChannels.invoke.REMOVE_TAG)
  ipcMain.removeHandler(InboxChannels.invoke.MARK_VIEWED)
  ipcMain.removeHandler(InboxChannels.invoke.UNARCHIVE)
  ipcMain.removeHandler(InboxChannels.invoke.DELETE_PERMANENT)
  ipcMain.removeHandler(InboxChannels.invoke.UNDO_FILE)
  ipcMain.removeHandler(InboxChannels.invoke.UNDO_ARCHIVE)
}
