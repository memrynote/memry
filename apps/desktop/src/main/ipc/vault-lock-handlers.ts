import { ipcMain } from 'electron'
import { VaultLocksChannels, VaultLockSetSchema } from '@memry/contracts/vault-locks-api'
import { getVaultLockState } from '../vault-locks/registry'
import { setVaultLock } from '../vault-locks/service'
import { createValidatedHandler } from './validate'

export function registerVaultLockHandlers(): void {
  ipcMain.handle(VaultLocksChannels.invoke.LIST, () => getVaultLockState())
  ipcMain.handle(
    VaultLocksChannels.invoke.SET,
    createValidatedHandler(VaultLockSetSchema, (input) => setVaultLock(input))
  )
}

export function unregisterVaultLockHandlers(): void {
  ipcMain.removeHandler(VaultLocksChannels.invoke.LIST)
  ipcMain.removeHandler(VaultLocksChannels.invoke.SET)
}
