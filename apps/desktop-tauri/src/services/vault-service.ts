import type {
  VaultClientAPI,
  VaultStatus,
  VaultConfig,
  SelectVaultResponse,
  GetVaultsResponse,
  IndexRecoveredEvent
} from '@/types/preload-types'

/**
 * Vault service - thin wrapper around window.api.vault
 * Provides a typed interface for vault operations in the renderer process.
 */
export const vaultService: VaultClientAPI = {
  /**
   * Select a vault folder. If no path provided, shows folder picker dialog.
   */
  select: (path?: string): Promise<SelectVaultResponse> => {
    return window.api.vault.select(path)
  },

  /**
   * Create a new vault at the specified path.
   * Note: Currently uses select() internally - full create support in future phase.
   */
  create: (path: string, name: string): Promise<SelectVaultResponse> => {
    return window.api.vault.create(path, name)
  },

  /**
   * Get all known vaults and current vault path.
   */
  getAll: (): Promise<GetVaultsResponse> => {
    return window.api.vault.getAll()
  },

  /**
   * Get current vault status.
   */
  getStatus: (): Promise<VaultStatus> => {
    return window.api.vault.getStatus()
  },

  /**
   * Get current vault configuration.
   */
  getConfig: (): Promise<VaultConfig> => {
    return window.api.vault.getConfig()
  },

  /**
   * Update vault configuration.
   */
  updateConfig: (config: Partial<VaultConfig>): Promise<VaultConfig> => {
    return window.api.vault.updateConfig(config)
  },

  /**
   * Close the current vault.
   */
  close: (): Promise<void> => {
    return window.api.vault.close()
  },

  /**
   * Switch to a different vault.
   */
  switch: (vaultPath: string): Promise<SelectVaultResponse> => {
    return window.api.vault.switch(vaultPath)
  },

  /**
   * Remove a vault from the known list (doesn't delete files).
   */
  remove: (vaultPath: string): Promise<void> => {
    return window.api.vault.remove(vaultPath)
  },

  /**
   * Trigger manual reindex of current vault.
   */
  reindex: (): Promise<void> => {
    return window.api.vault.reindex()
  },

  reveal: (): Promise<void> => {
    return window.api.vault.reveal()
  }
}

/**
 * Subscribe to vault status changes.
 * Returns unsubscribe function.
 */
export function onVaultStatusChanged(callback: (status: VaultStatus) => void): () => void {
  return window.api.onVaultStatusChanged(callback)
}

/**
 * Subscribe to vault index progress updates.
 * Returns unsubscribe function.
 */
export function onVaultIndexProgress(callback: (progress: number) => void): () => void {
  return window.api.onVaultIndexProgress(callback)
}

/**
 * Subscribe to vault errors.
 * Returns unsubscribe function.
 */
export function onVaultError(callback: (error: string) => void): () => void {
  return window.api.onVaultError(callback)
}

/**
 * Subscribe to vault index recovery events.
 * Fired when index database is automatically rebuilt from source files.
 * Returns unsubscribe function.
 */
export function onVaultIndexRecovered(callback: (event: IndexRecoveredEvent) => void): () => void {
  return window.api.onVaultIndexRecovered(callback)
}
