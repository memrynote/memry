import { ipcMain } from 'electron'
import {
  VaultChannels,
  SelectVaultSchema,
  UpdateVaultConfigSchema
} from '@shared/contracts/vault-api'
import { createValidatedHandler, createHandler, createStringHandler } from './validate'
import {
  selectVault,
  getStatus,
  getConfig,
  updateConfig,
  closeVault,
  getAllVaults,
  switchVault,
  removeVault,
  reindex
} from '../vault'

/**
 * Register all vault-related IPC handlers.
 * Call this once during app initialization.
 */
export function registerVaultHandlers(): void {
  // vault:select - Show folder picker and select vault
  ipcMain.handle(
    VaultChannels.invoke.SELECT,
    createValidatedHandler(SelectVaultSchema, selectVault)
  )

  // vault:get-status - Get current vault status
  ipcMain.handle(
    VaultChannels.invoke.GET_STATUS,
    createHandler(() => getStatus())
  )

  // vault:get-config - Get vault configuration
  ipcMain.handle(
    VaultChannels.invoke.GET_CONFIG,
    createHandler(() => getConfig())
  )

  // vault:update-config - Update vault configuration
  ipcMain.handle(
    VaultChannels.invoke.UPDATE_CONFIG,
    createValidatedHandler(UpdateVaultConfigSchema, (input) => updateConfig(input))
  )

  // vault:close - Close current vault
  ipcMain.handle(VaultChannels.invoke.CLOSE, createHandler(closeVault))

  // vault:get-all - Get list of known vaults
  ipcMain.handle(
    VaultChannels.invoke.GET_ALL,
    createHandler(() => getAllVaults())
  )

  // vault:switch - Switch to a different vault
  ipcMain.handle(VaultChannels.invoke.SWITCH, createStringHandler(switchVault))

  // vault:remove - Remove vault from known list
  ipcMain.handle(VaultChannels.invoke.REMOVE, createStringHandler(removeVault))

  // vault:reindex - Trigger manual reindex
  ipcMain.handle(VaultChannels.invoke.REINDEX, createHandler(reindex))
}

/**
 * Unregister all vault-related IPC handlers.
 * Useful for cleanup or testing.
 */
export function unregisterVaultHandlers(): void {
  Object.values(VaultChannels.invoke).forEach((channel) => {
    ipcMain.removeHandler(channel)
  })
}
