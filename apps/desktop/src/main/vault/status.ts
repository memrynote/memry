import type { VaultStatus, VaultConfig } from '@memry/contracts/vault-api'
import { broadcastToAllWindows } from '../lib/window-broadcast'
import { readVaultConfig } from './init'
import { normalizeJournalSettings, syncJournalConfig } from './journal-config'

/**
 * Current vault status
 */
let currentStatus: VaultStatus = {
  isOpen: false,
  path: null,
  isIndexing: false,
  indexProgress: 0,
  error: null
}
let isShuttingDown = false
const statusListeners = new Set<(status: VaultStatus) => void>()

/**
 * Mark the app as shutting down so vault status changes (e.g. closeVault during
 * graceful shutdown) stop reaching the renderer. Prevents the UI flipping to the
 * vault picker while the app is quitting/installing an update.
 */
export function beginVaultShutdown(): void {
  isShuttingDown = true
}

export function isVaultShuttingDown(): boolean {
  return isShuttingDown
}

export function onVaultStatusChanged(listener: (status: VaultStatus) => void): () => void {
  statusListeners.add(listener)
  return () => {
    statusListeners.delete(listener)
  }
}

/**
 * Update vault status and emit to all windows
 */
export function updateStatus(updates: Partial<VaultStatus>): void {
  currentStatus = { ...currentStatus, ...updates }
  emitStatusChanged()
}

/**
 * Emit vault status changed event to all windows
 */
export function emitStatusChanged(): void {
  // During shutdown, suppress ALL consumers — both the main-process listeners
  // (e.g. the window-resize listener that would shrink the window to the vault
  // picker size) and the renderer broadcast. The gate must be first: a
  // closeVault() during graceful shutdown flips status to isOpen:false, and
  // nothing should react to it while the app is quitting/installing.
  if (isShuttingDown) return
  statusListeners.forEach((listener) => listener(currentStatus))
  broadcastToAllWindows('vault:status-changed', currentStatus)
}

/**
 * Emit indexing progress event to all windows.
 *
 * `counts` rides along on the status broadcast so the renderer can show
 * "building x/y" while the background index build runs; the dedicated
 * `vault:index-progress` channel keeps its plain percentage payload.
 */
export function emitIndexProgress(
  progress: number,
  counts?: { indexed: number; total: number }
): void {
  updateStatus({
    indexProgress: progress,
    ...(counts ? { indexBuilt: counts.indexed, indexTotal: counts.total } : {})
  })
  broadcastToAllWindows('vault:index-progress', progress)
}

/**
 * Emit vault error event to all windows
 */
export function emitVaultError(error: string): void {
  updateStatus({ error })
  broadcastToAllWindows('vault:error', error)
}

/**
 * Get current vault status
 */
export function getStatus(): VaultStatus {
  return currentStatus
}

/**
 * Get vault configuration
 */
export function getConfig(): VaultConfig {
  if (!currentStatus.path) {
    const fallback: VaultConfig = {
      excludePatterns: [],
      defaultNoteFolder: '',
      journalFolder: 'journal',
      journalDateFormat: 'YYYY-MM-DD',
      attachmentsFolder: 'attachments',
      journalShowInSidebar: false
    }
    syncJournalConfig(fallback)
    return fallback
  }

  const config = readVaultConfig(currentStatus.path)
  const resolved: VaultConfig = normalizeJournalSettings({
    excludePatterns: config.excludePatterns,
    defaultNoteFolder: config.defaultNoteFolder,
    journalFolder: config.journalFolder,
    journalDateFormat: config.journalDateFormat,
    attachmentsFolder: config.attachmentsFolder,
    journalShowInSidebar: config.journalShowInSidebar === true
  })
  syncJournalConfig(resolved)
  return resolved
}
