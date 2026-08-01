import { ipcMain, shell } from 'electron'
import { z } from 'zod'
import {
  VaultChannels,
  DownloadRemoteVaultSchema,
  SelectVaultSchema,
  UpdateVaultConfigSchema
} from '@memry/contracts/vault-api'
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
import { findVault, getVaults } from '../store'
import { createLogger } from '../lib/logger'
import { getTelemetryRuntime } from '../telemetry/runtime'

const log = createLogger('IPC:Vault')

const trackVaultEvent = (name: 'vault_opened' | 'vault_created', source: string): void => {
  try {
    const runtime = getTelemetryRuntime()
    if (!runtime) return
    runtime.track({
      id: crypto.randomUUID(),
      name,
      occurredAt: new Date().toISOString(),
      surface: 'vault',
      action: name === 'vault_opened' ? 'opened' : 'created',
      source,
      result: 'success'
    })
  } catch (error) {
    log.warn('Failed to emit vault telemetry', { name, source, error })
  }
}

/**
 * Register all vault-related IPC handlers.
 * Call this once during app initialization.
 */
export function registerVaultHandlers(): void {
  // vault:select - Show folder picker and select vault
  ipcMain.handle(
    VaultChannels.invoke.SELECT,
    createValidatedHandler(SelectVaultSchema, async (input) => {
      const knownVaultPaths = new Set(getVaults().map((vault) => vault.path))
      const wasKnown = input.path ? findVault(input.path) !== undefined : undefined
      const result = await selectVault(input)
      if (result.success && result.vault) {
        const selectedWasKnown = wasKnown ?? knownVaultPaths.has(result.vault.path)
        if (!selectedWasKnown) {
          trackVaultEvent('vault_created', 'select')
        }
        trackVaultEvent('vault_opened', 'select')
      }
      return result
    })
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
  ipcMain.handle(
    VaultChannels.invoke.SWITCH,
    createStringHandler(async (vaultPath) => {
      const result = await switchVault(vaultPath)
      if (result.success && result.vault) {
        trackVaultEvent('vault_opened', 'switch')
      }
      return result
    })
  )

  // vault:remove - Remove vault from known list
  ipcMain.handle(VaultChannels.invoke.REMOVE, createStringHandler(removeVault))

  // vault:delete-from-account - Purge vault from sync account (never deletes files)
  ipcMain.handle(
    VaultChannels.invoke.DELETE_FROM_ACCOUNT,
    createStringHandler(async (vaultUuid) => {
      const { deleteAccountVault, refreshVaultDirectory } = await import('../sync/vault-directory')
      await deleteAccountVault(vaultUuid)
      await refreshVaultDirectory({ force: true })
    })
  )

  // vault:resolve-embeds - Map `![[photo.png]]` targets to memry-file:// URLs
  ipcMain.handle(
    VaultChannels.invoke.RESOLVE_EMBEDS,
    createValidatedHandler(z.array(z.string()).max(500), async (refs) => {
      const { resolveVaultEmbeds } = await import('../vault/resolve-embed')
      return resolveVaultEmbeds(refs)
    })
  )

  // vault:reindex - Trigger manual reindex
  ipcMain.handle(VaultChannels.invoke.REINDEX, createHandler(reindex))

  // vault:reveal - Reveal vault folder in OS file manager
  ipcMain.handle(
    VaultChannels.invoke.REVEAL,
    createHandler(async () => {
      const status = getStatus()
      if (status.path) shell.showItemInFolder(status.path)
    })
  )

  // vault:list-account - List all vaults in the signed-in account
  ipcMain.handle(
    VaultChannels.invoke.LIST_ACCOUNT,
    createHandler(async () => {
      const { refreshVaultDirectory, listAccountVaults } = await import('../sync/vault-directory')
      await refreshVaultDirectory()
      return listAccountVaults()
    })
  )

  // vault:download-remote - Provision + open a cloud-only vault locally
  ipcMain.handle(
    VaultChannels.invoke.DOWNLOAD_REMOTE,
    createValidatedHandler(DownloadRemoteVaultSchema, async (input) => {
      const { downloadRemoteVault } = await import('../sync/vault-directory')
      const result = await downloadRemoteVault(input)
      if (result.success && result.vault) {
        trackVaultEvent('vault_opened', 'download-remote')
      }
      return result
    })
  )
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
