/**
 * Readwise importer IPC (#1408 D1): connection state, the pasted token, and the
 * synced options for the import dialog's Readwise panel. The backfill itself
 * goes through the generic import channels. Free plan included: no entitlement
 * check anywhere here.
 */

import { ipcMain } from 'electron'
import { z } from 'zod'
import {
  ReadwiseConnectSchema,
  ReadwiseImportChannels,
  ReadwiseSetOptionsSchema
} from '@memry/contracts/import-channels'
import type { ReadwiseStatusResult } from '@memry/contracts/import-channels'
import { registerCommand } from './lib/register-command'
import { getDatabase } from '../database'
import {
  connectReadwise,
  disconnectReadwise,
  getReadwiseStatus,
  syncReadwiseNow
} from '../readwise/connection'
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
    (input): Promise<ReadwiseStatusResult> => connectReadwise(input.token),
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
}

export function unregisterReadwiseImportHandlers(): void {
  ipcMain.removeHandler(ReadwiseImportChannels.invoke.STATUS)
  ipcMain.removeHandler(ReadwiseImportChannels.invoke.CONNECT)
  ipcMain.removeHandler(ReadwiseImportChannels.invoke.DISCONNECT)
  ipcMain.removeHandler(ReadwiseImportChannels.invoke.SYNC_NOW)
  ipcMain.removeHandler(ReadwiseImportChannels.invoke.SET_OPTIONS)
}
