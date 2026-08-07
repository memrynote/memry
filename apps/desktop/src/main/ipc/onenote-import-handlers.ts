/**
 * OneNote importer IPC: Microsoft sign-in state + notebook tree for the import
 * dialog's OneNote panel. The import run itself goes through the generic
 * import channels (`import-handlers.ts`); these four commands only exist
 * because an account-based importer needs auth + source discovery before
 * `import:start` can be called.
 */

import { ipcMain } from 'electron'
import { z } from 'zod'
import { OneNoteImportChannels } from '@memry/contracts/import-channels'
import type {
  OneNoteAuthStatusResult,
  OneNoteNotebooksResult
} from '@memry/contracts/import-channels'
import { registerCommand } from './lib/register-command'
import {
  connectOneNote,
  disconnectOneNote,
  getOneNoteAccessToken,
  getOneNoteAuthStatus,
  resolveOneNoteClientId
} from '../import/onenote/onenote-auth'
import { createOneNoteGraphClient } from '../import/onenote/onenote-graph'

/** How long the notebook picker may spend scanning before it gives up. */
const NOTEBOOK_SCAN_TIMEOUT_MS = 90_000

export function registerOneNoteImportHandlers(): void {
  registerCommand(
    OneNoteImportChannels.invoke.STATUS,
    z.unknown(),
    async (): Promise<OneNoteAuthStatusResult> => getOneNoteAuthStatus(),
    'errors:importer.onenoteStatusFailed'
  )

  registerCommand(
    OneNoteImportChannels.invoke.CONNECT,
    z.unknown(),
    async (): Promise<OneNoteAuthStatusResult> => {
      const account = await connectOneNote()
      return { configured: true, connected: true, account }
    },
    'errors:importer.onenoteConnectFailed'
  )

  registerCommand(
    OneNoteImportChannels.invoke.DISCONNECT,
    z.unknown(),
    async () => {
      await disconnectOneNote()
      return { success: true as const }
    },
    'errors:importer.onenoteDisconnectFailed'
  )

  registerCommand(
    OneNoteImportChannels.invoke.NOTEBOOKS,
    z.unknown(),
    async (): Promise<OneNoteNotebooksResult> => {
      const clientId = resolveOneNoteClientId()
      if (!clientId) {
        throw new Error('OneNote import is not configured (missing ONENOTE_CLIENT_ID).')
      }
      // The picker must answer or fail, never hang: without a deadline a
      // rate-limited account parks this invoke behind minutes of backoff with
      // no way for the dialog to cancel it.
      const deadline = Date.now() + NOTEBOOK_SCAN_TIMEOUT_MS
      const graph = createOneNoteGraphClient({
        getAccessToken: (forceRefresh) => getOneNoteAccessToken({ clientId, forceRefresh }),
        isCancelled: () => Date.now() > deadline,
        status: () => {}
      })
      try {
        return { notebooks: await graph.listNotebookTrees() }
      } catch (error) {
        if (Date.now() > deadline) {
          throw new Error('OneNote took too long to list your notebooks. Please try again.')
        }
        throw error
      }
    },
    'errors:importer.onenoteNotebooksFailed'
  )
}

export function unregisterOneNoteImportHandlers(): void {
  ipcMain.removeHandler(OneNoteImportChannels.invoke.STATUS)
  ipcMain.removeHandler(OneNoteImportChannels.invoke.CONNECT)
  ipcMain.removeHandler(OneNoteImportChannels.invoke.DISCONNECT)
  ipcMain.removeHandler(OneNoteImportChannels.invoke.NOTEBOOKS)
}
