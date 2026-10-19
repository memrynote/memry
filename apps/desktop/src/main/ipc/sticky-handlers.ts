import { ipcMain } from 'electron'
import {
  StickyChannels,
  StickyDraftIdSchema,
  StickyOpenTargetSchema,
  StickyPeekSchema,
  StickyResizeSchema,
  StickySaveDraftSchema,
  StickySendSchema,
  StickyUndoSchema,
  StickyUnfoldSchema
} from '@memry/contracts/sticky-api'
import { deleteStickyDraft, listStickyDrafts, saveStickyDraft } from '../stickies/drafts'
import { sendSticky, undoStickySend } from '../stickies/send'
import {
  getStickyWindowSession,
  openStickyTargetInMainWindow,
  resizeStickyWindow,
  showStickyWindow,
  tuckStickyWindow
} from '../stickies/sticky-window'
import { setEdgeTabPeek } from '../stickies/edge-tab'
import { createValidatedHandler } from './validate'

export function registerStickyHandlers(): void {
  ipcMain.handle(StickyChannels.invoke.LIST_DRAFTS, () => listStickyDrafts())
  ipcMain.handle(
    StickyChannels.invoke.SAVE_DRAFT,
    createValidatedHandler(StickySaveDraftSchema, (input) => saveStickyDraft(input))
  )
  ipcMain.handle(
    StickyChannels.invoke.DELETE_DRAFT,
    createValidatedHandler(StickyDraftIdSchema, (input) => ({
      success: deleteStickyDraft(input.id)
    }))
  )
  ipcMain.handle(
    StickyChannels.invoke.SEND,
    createValidatedHandler(StickySendSchema, (input) => sendSticky(input))
  )
  ipcMain.handle(
    StickyChannels.invoke.UNDO_SEND,
    createValidatedHandler(StickyUndoSchema, (input) => undoStickySend(input.undoToken))
  )
  ipcMain.handle(
    StickyChannels.invoke.OPEN_TARGET,
    createValidatedHandler(StickyOpenTargetSchema, (input) => openStickyTargetInMainWindow(input))
  )
  ipcMain.handle(StickyChannels.invoke.GET_SESSION, () => getStickyWindowSession())
  ipcMain.handle(StickyChannels.invoke.TUCK, () => tuckStickyWindow())
  ipcMain.handle(
    StickyChannels.invoke.UNFOLD,
    createValidatedHandler(StickyUnfoldSchema, (input) => showStickyWindow(input.draftId))
  )
  ipcMain.handle(
    StickyChannels.invoke.PEEK,
    createValidatedHandler(StickyPeekSchema, (input) => setEdgeTabPeek(input.open))
  )

  ipcMain.handle(
    StickyChannels.invoke.RESIZE,
    createValidatedHandler(StickyResizeSchema, (input) => resizeStickyWindow(input.height))
  )
}

export function unregisterStickyHandlers(): void {
  for (const channel of Object.values(StickyChannels.invoke)) ipcMain.removeHandler(channel)
}
