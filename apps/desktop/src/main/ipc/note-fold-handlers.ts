import { ipcMain } from 'electron'

import {
  FoldChannels,
  FoldGetRequestSchema,
  FoldRetryRequestSchema,
  type FoldAgentStatus,
  type FoldLastRun,
  type FoldLayers
} from '@memry/contracts/note-fold'

import { getNoteFold, getNoteFoldAgentStatus } from '../note-fold'
import { createValidatedHandler } from './validate'

export function registerNoteFoldHandlers(): void {
  ipcMain.handle(
    FoldChannels.invoke.GET,
    createValidatedHandler(FoldGetRequestSchema, (input): Promise<FoldLayers> =>
      getNoteFold().get(input.noteId)
    )
  )
  ipcMain.handle(
    FoldChannels.invoke.RETRY,
    createValidatedHandler(FoldRetryRequestSchema, (input): Promise<FoldLayers | null> =>
      getNoteFold().retry(input.noteId)
    )
  )
  ipcMain.handle(FoldChannels.invoke.LAST_RUN, (): FoldLastRun => getNoteFold().getLastRun())
  ipcMain.handle(FoldChannels.invoke.AGENT_STATUS, (): Promise<FoldAgentStatus> =>
    getNoteFoldAgentStatus()
  )
}

export function unregisterNoteFoldHandlers(): void {
  ipcMain.removeHandler(FoldChannels.invoke.GET)
  ipcMain.removeHandler(FoldChannels.invoke.RETRY)
  ipcMain.removeHandler(FoldChannels.invoke.LAST_RUN)
  ipcMain.removeHandler(FoldChannels.invoke.AGENT_STATUS)
}
