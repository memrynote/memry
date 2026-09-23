import { ipcMain, shell } from 'electron'
import {
  ListVaultActivitySchema,
  SetVaultActivityRetentionSchema,
  VaultActivityChannels,
  type ListVaultActivityResult
} from '@memry/contracts/vault-activity-api'
import { createHandler, createValidatedHandler } from './validate'
import {
  clearActivity,
  getActivityRetentionDays,
  isActivityLogOpen,
  listActivity,
  prepareActivityLogFile,
  setActivityRetentionDays
} from '../vault/activity-log'

export function registerVaultActivityHandlers(): void {
  ipcMain.handle(
    VaultActivityChannels.invoke.LIST,
    createValidatedHandler(
      ListVaultActivitySchema,
      async (input): Promise<ListVaultActivityResult> => ({
        entries: listActivity({ limit: input.limit, filter: input.filter }),
        retentionDays: getActivityRetentionDays(),
        available: isActivityLogOpen()
      })
    )
  )

  ipcMain.handle(
    VaultActivityChannels.invoke.CLEAR,
    createHandler(async () => {
      await clearActivity()
      return { cleared: true as const }
    })
  )

  ipcMain.handle(
    VaultActivityChannels.invoke.SET_RETENTION,
    createValidatedHandler(SetVaultActivityRetentionSchema, async (input) => {
      await setActivityRetentionDays(input.days)
      return { retentionDays: input.days }
    })
  )

  ipcMain.handle(
    VaultActivityChannels.invoke.REVEAL,
    createHandler(async () => {
      const logPath = await prepareActivityLogFile()
      if (!logPath) return { revealed: false as const }
      shell.showItemInFolder(logPath)
      return { revealed: true as const }
    })
  )
}

export function unregisterVaultActivityHandlers(): void {
  for (const channel of Object.values(VaultActivityChannels.invoke)) {
    ipcMain.removeHandler(channel)
  }
}
