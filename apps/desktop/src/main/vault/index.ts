import { dialog, BrowserWindow } from 'electron'
import type {
  VaultInfo,
  VaultStatus,
  VaultConfig,
  SelectVaultResponse,
  GetVaultsResponse
} from '@memry/contracts/vault-api'
import {
  getCurrentVaultPath,
  setCurrentVaultPath,
  getVaults,
  upsertVault,
  removeVault as removeVaultFromStore,
  findVault,
  touchVault,
  type StoredVaultInfo
} from '../store'
import {
  initVault,
  isVaultInitialized,
  isValidDirectory,
  hasWritePermission,
  getVaultName,
  readVaultConfig,
  writeVaultConfig,
  countMarkdownFiles,
  getDataDbPath,
  getIndexDbPath
} from './init'
import {
  initDatabase,
  initIndexDatabase,
  closeAllDatabases,
  runMigrations,
  runIndexMigrations,
  initializeFts,
  getDatabase,
  getIndexDatabase,
  checkIndexHealth,
  type IndexHealth
} from '../database'
import { seedDefaults } from '../database/seed'
import { VaultChannels } from '@memry/contracts/ipc-channels'
import { VaultError, VaultErrorCode } from '../lib/errors'
import { startWatcher, stopWatcher } from './watcher'
import { indexVault, rebuildIndex } from './indexer'
import { initEmbeddingModel, isModelLoaded, isModelLoading } from '../lib/embeddings'
import { flushFtsUpdates, hasPendingFtsUpdates } from '../database'
import { clearEmbeddingQueue, hasPendingEmbeddings } from '../inbox/embedding-queue'
import { createLogger } from '../lib/logger'
import { startSyncRuntime, stopSyncRuntime } from '../sync/runtime'

const logger = createLogger('Vault')

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

/**
 * Show native folder picker dialog
 */
async function showFolderPicker(): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
    title: 'Select Vault Folder',
    buttonLabel: 'Select Vault'
  })

  if (result.canceled || result.filePaths.length === 0) {
    return null
  }

  return result.filePaths[0]
}

/**
 * Validate a vault path
 */
function validateVaultPath(vaultPath: string): void {
  if (!isValidDirectory(vaultPath)) {
    throw new VaultError('Selected path is not a valid directory', VaultErrorCode.INVALID_PATH)
  }

  if (!hasWritePermission(vaultPath)) {
    throw new VaultError(
      'No write permission for selected directory',
      VaultErrorCode.PERMISSION_DENIED
    )
  }
}

/**
 * Convert stored vault info to VaultInfo interface
 */
function toVaultInfo(stored: StoredVaultInfo): VaultInfo {
  return {
    path: stored.path,
    name: stored.name,
    noteCount: stored.noteCount,
    taskCount: stored.taskCount,
    lastOpened: stored.lastOpened,
    isDefault: stored.isDefault
  }
}

/**
 * Create VaultInfo for a vault path
 */
function createVaultInfo(vaultPath: string): VaultInfo {
  const config = readVaultConfig(vaultPath)
  const noteCount = countMarkdownFiles(vaultPath, config.excludePatterns)
  const existingVault = findVault(vaultPath)

  return {
    path: vaultPath,
    name: getVaultName(vaultPath),
    noteCount,
    taskCount: existingVault?.taskCount ?? 0,
    lastOpened: new Date().toISOString(),
    isDefault: existingVault?.isDefault ?? getVaults().length === 0
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
function emitStatusChanged(): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send('vault:status-changed', currentStatus)
  })
}

/**
 * Emit indexing progress event to all windows
 */
export function emitIndexProgress(progress: number): void {
  updateStatus({ indexProgress: progress })
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send('vault:index-progress', progress)
  })
}

/**
 * Emit vault error event to all windows
 */
export function emitVaultError(error: string): void {
  updateStatus({ error })
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send('vault:error', error)
  })
}

/**
 * Index recovered event data
 */
export interface IndexRecoveredEvent {
  reason: IndexHealth
  filesIndexed: number
  duration: number
}

/**
 * Emit index recovered event to all windows.
 * Sent after automatic recovery from corrupt or missing index.
 */
export function emitIndexRecovered(event: IndexRecoveredEvent): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send(VaultChannels.events.INDEX_RECOVERED, event)
  })
}

/**
 * Open a vault: initialize structure, run migrations, start database, index notes
 */
async function openVault(vaultPath: string): Promise<void> {
  // Initialize vault structure if needed
  if (!isVaultInitialized(vaultPath)) {
    initVault(vaultPath)
  }

  // Get database paths
  const dataDbPath = getDataDbPath(vaultPath)
  const indexDbPath = getIndexDbPath(vaultPath)

  // Run data.db migrations (always needed)
  runMigrations(dataDbPath)

  // Initialize data database
  initDatabase(dataDbPath)

  // Seed default data (inbox project, etc.)
  seedDefaults(getDatabase())

  // Check index database health before proceeding
  const indexHealth: IndexHealth = checkIndexHealth(indexDbPath)
  logger.info(`Index health check: ${indexHealth}`)

  updateStatus({ isIndexing: true, indexProgress: 0 })

  try {
    if (indexHealth !== 'healthy') {
      // Index is corrupt or missing - rebuild from source files
      logger.warn(`Index ${indexHealth}, triggering rebuild...`)
      const rebuildResult = await rebuildIndex(vaultPath)

      // Notify renderer about recovery
      emitIndexRecovered({
        reason: indexHealth,
        filesIndexed: rebuildResult.filesIndexed,
        duration: rebuildResult.duration
      })
    } else {
      // Index is healthy - try to run migrations
      try {
        runIndexMigrations(indexDbPath)
        initIndexDatabase(indexDbPath)
        initializeFts(getIndexDatabase())

        // Run indexing to pick up any new/missing notes
        // This will skip files already in cache, so it's fast for subsequent opens
        await indexVault(vaultPath)
      } catch (migrationError) {
        // Migration failed (e.g., table already exists) - rebuild index from scratch
        logger.error('Migration failed, rebuilding index:', migrationError)
        const rebuildResult = await rebuildIndex(vaultPath)

        // Notify renderer about recovery
        emitIndexRecovered({
          reason: 'migration_failed',
          filesIndexed: rebuildResult.filesIndexed,
          duration: rebuildResult.duration
        })
      }
    }
  } catch (error) {
    logger.error('Indexing failed:', error)
    // Continue anyway - watcher will pick up files
  }

  updateStatus({ isIndexing: false, indexProgress: 100 })

  // Start file watcher for external changes
  await startWatcher(vaultPath)

  updateStatus({
    isOpen: true,
    path: vaultPath,
    error: null
  })

  await startSyncRuntime()

  // Start loading embedding model in background (non-blocking)
  // This ensures the model is ready when user needs AI suggestions
  if (!isModelLoaded() && !isModelLoading()) {
    logger.info('Starting background embedding model load...')
    initEmbeddingModel().catch((err) => {
      logger.error('Background embedding model load failed:', err)
    })
  }
}

/**
 * Select a vault (show folder picker if no path provided)
 */
export async function selectVault(input: { path?: string }): Promise<SelectVaultResponse> {
  try {
    const vaultPath = input.path ?? (await showFolderPicker())

    if (!vaultPath) {
      return { success: false, vault: null, error: 'No folder selected' }
    }

    // Validate the path
    validateVaultPath(vaultPath)

    // Close current vault if open
    if (currentStatus.isOpen) {
      await closeVault()
    }

    // Open the vault
    await openVault(vaultPath)

    // Create vault info
    const vaultInfo = createVaultInfo(vaultPath)

    // Store in electron-store
    setCurrentVaultPath(vaultPath)
    upsertVault(vaultInfo)
    touchVault(vaultPath)

    return { success: true, vault: vaultInfo }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to select vault'
    updateStatus({ error: message })
    return { success: false, vault: null, error: message }
  }
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
    return {
      excludePatterns: [],
      defaultNoteFolder: 'notes',
      journalFolder: 'journal',
      attachmentsFolder: 'attachments'
    }
  }

  const config = readVaultConfig(currentStatus.path)
  return {
    excludePatterns: config.excludePatterns,
    defaultNoteFolder: config.defaultNoteFolder,
    journalFolder: config.journalFolder,
    attachmentsFolder: config.attachmentsFolder
  }
}

/**
 * Update vault configuration.
 * If excludePatterns change, the file watcher is restarted with the new patterns.
 */
export async function updateConfig(updates: Partial<VaultConfig>): Promise<VaultConfig> {
  if (!currentStatus.path) {
    throw new VaultError('No vault is currently open', VaultErrorCode.NOT_INITIALIZED)
  }

  const oldConfig = getConfig()
  writeVaultConfig(currentStatus.path, updates)
  const newConfig = getConfig()

  // Restart watcher if exclude patterns changed
  if (
    updates.excludePatterns &&
    JSON.stringify(oldConfig.excludePatterns) !== JSON.stringify(newConfig.excludePatterns)
  ) {
    logger.info('Exclude patterns changed, restarting watcher...')
    await stopWatcher()
    await startWatcher(currentStatus.path, newConfig.excludePatterns)
  }

  return newConfig
}

/**
 * Close current vault
 */
export async function closeVault(): Promise<void> {
  if (!currentStatus.isOpen) {
    return
  }

  // Stop file watcher
  await stopWatcher()

  // Flush any pending FTS updates before closing database
  if (hasPendingFtsUpdates()) {
    try {
      const indexDb = getIndexDatabase()
      const flushed = flushFtsUpdates(indexDb)
      if (flushed > 0) {
        logger.debug(`Flushed ${flushed} pending FTS updates before close`)
      }
    } catch (error) {
      logger.error('Failed to flush FTS updates:', error)
    }
  }

  // Clear any pending embedding updates (don't wait for them on shutdown)
  if (hasPendingEmbeddings()) {
    clearEmbeddingQueue()
    logger.debug('Cleared pending embedding updates before close')
  }

  await stopSyncRuntime()

  // Close databases
  closeAllDatabases()

  // Update status
  updateStatus({
    isOpen: false,
    path: null,
    isIndexing: false,
    indexProgress: 0,
    error: null
  })
}

/**
 * Get all known vaults
 */
export function getAllVaults(): GetVaultsResponse {
  const vaults = getVaults().map(toVaultInfo)
  return {
    vaults,
    currentVault: getCurrentVaultPath()
  }
}

/**
 * Switch to a different vault
 */
export async function switchVault(vaultPath: string): Promise<SelectVaultResponse> {
  return selectVault({ path: vaultPath })
}

/**
 * Remove a vault from known list (doesn't delete files)
 */
export async function removeVault(vaultPath: string): Promise<void> {
  // Close if it's the current vault
  if (currentStatus.path === vaultPath) {
    await closeVault()
    setCurrentVaultPath(null)
  }

  removeVaultFromStore(vaultPath)
}

/**
 * Trigger manual reindex of current vault
 */
export async function reindex(): Promise<void> {
  if (!currentStatus.path) {
    throw new VaultError('No vault is currently open', VaultErrorCode.NOT_INITIALIZED)
  }

  updateStatus({ isIndexing: true, indexProgress: 0 })

  try {
    await indexVault(currentStatus.path)
    updateStatus({ isIndexing: false, indexProgress: 100 })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Reindex failed'
    updateStatus({ isIndexing: false, error: message })
    throw error
  }
}

/**
 * Auto-open the last vault on app start
 * In test mode (TEST_VAULT_PATH env var), opens the test vault instead
 */
export async function autoOpenLastVault(): Promise<void> {
  // Support E2E testing with TEST_VAULT_PATH environment variable
  const testVaultPath = process.env.TEST_VAULT_PATH
  if (testVaultPath && process.env.NODE_ENV === 'test') {
    try {
      // Initialize the test vault if needed
      if (!isVaultInitialized(testVaultPath)) {
        initVault(testVaultPath)
      }
      await openVault(testVaultPath)
      return
    } catch (error) {
      logger.error('Failed to open test vault:', error)
    }
  }

  const lastVault = getCurrentVaultPath()

  if (lastVault && isVaultInitialized(lastVault)) {
    try {
      await openVault(lastVault)
      touchVault(lastVault)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to open last vault'
      updateStatus({ error: message })
      // Clear the invalid vault path
      setCurrentVaultPath(null)
    }
  }
}
