import { ipcMain } from 'electron'
import { PortalChannels } from '@memry/contracts/ipc-channels'
import {
  PortalGetUsageSchema,
  PortalSearchSchema,
  PortalStampAnchorSchema
} from '@memry/contracts/portals-api'
import { getPortalUsage, searchPortalBlocks, stampAnchor } from '../portals/portal-service'
import { createValidatedHandler } from './validate'

export function registerPortalsHandlers(): void {
  ipcMain.handle(
    PortalChannels.invoke.GET_USAGE,
    createValidatedHandler(PortalGetUsageSchema, (input) => getPortalUsage(input))
  )
  ipcMain.handle(
    PortalChannels.invoke.STAMP_ANCHOR,
    createValidatedHandler(PortalStampAnchorSchema, (input) =>
      stampAnchor(input.noteId, input.blockId)
    )
  )
  ipcMain.handle(
    PortalChannels.invoke.SEARCH,
    createValidatedHandler(PortalSearchSchema, (input) => searchPortalBlocks(input))
  )
}

export function unregisterPortalsHandlers(): void {
  ipcMain.removeHandler(PortalChannels.invoke.GET_USAGE)
  ipcMain.removeHandler(PortalChannels.invoke.STAMP_ANCHOR)
  ipcMain.removeHandler(PortalChannels.invoke.SEARCH)
}
