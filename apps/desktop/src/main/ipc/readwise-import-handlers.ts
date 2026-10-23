/**
 * Readwise importer IPC (#1408 D1): connection state, the pasted token, and the
 * synced options for the import dialog's Readwise panel. The backfill itself
 * goes through the generic import channels. Free plan included: no entitlement
 * check anywhere here.
 */

import { ipcMain } from 'electron'
import { z } from 'zod'
import {
  ReadwiseBookCommandSchema,
  ReadwiseConnectSchema,
  ReadwiseImportChannels,
  ReadwiseRestoreBookSchema,
  ReadwiseSetOptionsSchema,
  ReadwiseTakeOverSchema
} from '@memry/contracts/import-channels'
import type { ReadwiseDeletedBook, ReadwiseStatusResult } from '@memry/contracts/import-channels'
import { registerCommand } from './lib/register-command'
import { getDatabase } from '../database'
import {
  connectReadwise,
  disconnectReadwise,
  getReadwiseStatus,
  syncReadwiseNow,
  takeOverReadwise,
  withUserMessage
} from '../readwise/connection'
import {
  listDeletedBooks,
  refreshBookInfo,
  reimportBook,
  restoreBook
} from '../readwise/book-commands'
import { writeReadwiseOptions } from '../readwise/settings'

export function registerReadwiseImportHandlers(): void {
  registerCommand(
    ReadwiseImportChannels.invoke.STATUS,
    z.unknown(),
    (): Promise<ReadwiseStatusResult> => getReadwiseStatus(),
    'errors:importer.readwiseStatusFailed'
  )

  registerCommand(
    ReadwiseImportChannels.invoke.CONNECT,
    ReadwiseConnectSchema,
    (input): Promise<ReadwiseStatusResult> => withUserMessage(connectReadwise(input.token)),
    'errors:importer.readwiseConnectFailed'
  )

  registerCommand(
    ReadwiseImportChannels.invoke.DISCONNECT,
    z.unknown(),
    async () => {
      await disconnectReadwise()
      return { success: true as const }
    },
    'errors:importer.readwiseDisconnectFailed'
  )

  registerCommand(
    ReadwiseImportChannels.invoke.SYNC_NOW,
    z.unknown(),
    async () => {
      await syncReadwiseNow()
      return { success: true as const }
    },
    'errors:importer.readwiseSyncFailed'
  )

  registerCommand(
    ReadwiseImportChannels.invoke.SET_OPTIONS,
    ReadwiseSetOptionsSchema,
    async (input): Promise<ReadwiseStatusResult> => {
      writeReadwiseOptions(getDatabase(), input)
      return await getReadwiseStatus()
    },
    'errors:importer.readwiseOptionsFailed'
  )

  registerCommand(
    ReadwiseImportChannels.invoke.REIMPORT_BOOK,
    ReadwiseBookCommandSchema,
    async (input) => {
      await reimportBook(input.noteId)
      return { success: true as const }
    },
    'errors:importer.readwiseBookCommandFailed'
  )

  registerCommand(
    ReadwiseImportChannels.invoke.REFRESH_BOOK,
    ReadwiseBookCommandSchema,
    async (input) => {
      await refreshBookInfo(input.noteId)
      return { success: true as const }
    },
    'errors:importer.readwiseBookCommandFailed'
  )

  registerCommand(
    ReadwiseImportChannels.invoke.LIST_DELETED,
    z.unknown(),
    async (): Promise<{ books: ReadwiseDeletedBook[] }> => ({ books: await listDeletedBooks() }),
    'errors:importer.readwiseBookCommandFailed'
  )

  registerCommand(
    ReadwiseImportChannels.invoke.RESTORE_BOOK,
    ReadwiseRestoreBookSchema,
    async (input) => {
      await restoreBook(input.readwiseBookId)
      return { success: true as const }
    },
    'errors:importer.readwiseBookCommandFailed'
  )

  registerCommand(
    ReadwiseImportChannels.invoke.TAKE_OVER,
    ReadwiseTakeOverSchema,
    (input): Promise<ReadwiseStatusResult> => withUserMessage(takeOverReadwise(input.token)),
    'errors:importer.readwiseTakeOverFailed'
  )
}

export function unregisterReadwiseImportHandlers(): void {
  ipcMain.removeHandler(ReadwiseImportChannels.invoke.STATUS)
  ipcMain.removeHandler(ReadwiseImportChannels.invoke.CONNECT)
  ipcMain.removeHandler(ReadwiseImportChannels.invoke.DISCONNECT)
  ipcMain.removeHandler(ReadwiseImportChannels.invoke.SYNC_NOW)
  ipcMain.removeHandler(ReadwiseImportChannels.invoke.SET_OPTIONS)
  ipcMain.removeHandler(ReadwiseImportChannels.invoke.REIMPORT_BOOK)
  ipcMain.removeHandler(ReadwiseImportChannels.invoke.REFRESH_BOOK)
  ipcMain.removeHandler(ReadwiseImportChannels.invoke.LIST_DELETED)
  ipcMain.removeHandler(ReadwiseImportChannels.invoke.RESTORE_BOOK)
  ipcMain.removeHandler(ReadwiseImportChannels.invoke.TAKE_OVER)
}
