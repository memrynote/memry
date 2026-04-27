import type {
  VaultClientAPI,
  VaultStatus,
  IndexRecoveredEvent,
  SelectVaultResponse
} from '@/types/preload-types'
import { createInvokeForwarder, subscribeEvent } from '@/lib/ipc/forwarder'
import { invoke } from '@/lib/ipc/invoke'

/**
 * Vault service - Tauri invoke forwarder.
 * Provides a typed interface for vault operations in the renderer process.
 */
const rawVaultService = createInvokeForwarder<VaultClientAPI>('vault')

export const vaultService: VaultClientAPI = new Proxy(rawVaultService, {
  get(target, property, receiver) {
    if (property === 'select') {
      return selectVault
    }
    if (property === 'switch') {
      return switchVault
    }
    return Reflect.get(target, property, receiver)
  }
}) as VaultClientAPI

async function selectVault(path?: string): Promise<SelectVaultResponse> {
  const selectedPath =
    path ??
    (await invoke<string | null>('dialog_choose_folder', {
      title: 'Select Vault Folder'
    }))

  if (!selectedPath) {
    return { success: false, vault: null, error: 'No folder selected' }
  }

  return invoke<SelectVaultResponse>('vault_open', { input: { path: selectedPath } })
}

async function switchVault(path: string): Promise<SelectVaultResponse> {
  return invoke<SelectVaultResponse>('vault_switch', { input: { path } })
}

/**
 * Subscribe to vault status changes.
 * Returns unsubscribe function.
 */
export function onVaultStatusChanged(callback: (status: VaultStatus) => void): () => void {
  return subscribeEvent<VaultStatus>('vault-status-changed', callback)
}

/**
 * Subscribe to vault index progress updates.
 * Returns unsubscribe function.
 */
export function onVaultIndexProgress(callback: (progress: number) => void): () => void {
  return subscribeEvent<number>('vault-index-progress', callback)
}

/**
 * Subscribe to vault errors.
 * Returns unsubscribe function.
 */
export function onVaultError(callback: (error: string) => void): () => void {
  return subscribeEvent<string>('vault-error', callback)
}

/**
 * Subscribe to vault index recovery events.
 * Fired when index database is automatically rebuilt from source files.
 * Returns unsubscribe function.
 */
export function onVaultIndexRecovered(callback: (event: IndexRecoveredEvent) => void): () => void {
  return subscribeEvent<IndexRecoveredEvent>('vault-index-recovered', callback)
}
