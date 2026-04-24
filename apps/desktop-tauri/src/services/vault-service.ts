import type {
  VaultClientAPI,
  VaultStatus,
  IndexRecoveredEvent
} from '@/types/preload-types'
import { createInvokeForwarder, subscribeEvent } from '@/lib/ipc/forwarder'

/**
 * Vault service - Tauri invoke forwarder.
 * Provides a typed interface for vault operations in the renderer process.
 */
export const vaultService: VaultClientAPI = createInvokeForwarder<VaultClientAPI>('vault')

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
