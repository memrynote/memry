import { dialog } from 'electron'
import { broadcastToAllWindows } from '../lib/window-broadcast'
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
  invalidateVaultConfigCache,
  countMarkdownFiles,
  getDataDbPath,
  getIndexDbPath
} from './init'
import { getJournalConfig, setJournalConfig } from './journal-config'
import {
  initDatabase,
  initIndexDatabase,
  closeAllDatabases,
  runMigrations,
  runIndexMigrations,
  initializeFts,
  initializeFtsTasks,
  initializeFtsInbox,
  getDatabase,
  getIndexDatabase,
  checkIndexHealth,
  type IndexHealth
} from '../database'
import { ensureDefaultTaskProject } from '../database/defaults'
import { VaultChannels } from '@memry/contracts/ipc-channels'
import { VaultError, VaultErrorCode } from '../lib/errors'
import { startWatcher, stopWatcher } from './watcher'
import { indexVault, rebuildIndex } from './indexer'
import { createLogger } from '../lib/logger'
import { trackMainError, trackMainLog } from '../telemetry/diagnostics'
import { trackMainEvent } from '../telemetry/track'
import { getMainI18n } from '../lib/main-i18n'
import { startSyncRuntime, stopSyncRuntime } from '../sync/runtime'
import { reconcileProjections, startProjectionRuntime, stopProjectionRuntime } from '../projections'
import { createNoteDerivedStateProjector } from '../projections/projectors/note-derived-state-projector'
import { createSearchProjector } from '../projections/projectors/search-projector'
import { createEmbeddingProjector } from '../projections/projectors/embedding-projector'
import { createInboxStatsProjector } from '../projections/projectors/inbox-stats-projector'
import { createNoteProjectLinksProjector } from '../projections/projectors/note-project-links-projector'
import { PropertyDefinitionsService } from './property-definitions'
import { migrateSettingsToConfig } from './settings-cache'
import {
  applyProjectFrontmatterBackfill,
  snapshotProjectFrontmatterBackfill
} from './backfill-project-frontmatter'
import { promoteSpatialCanvas } from '../settings/promote-spatial-canvas'
import { migrateTemplateFilesToDb } from './templates-migration'
import { reconcileCanvasFiles } from '../canvas/reconcile'
import { configureLazyAgentServices } from '../agent/lazy-services'
import { registerLazyAgentHandlers, unregisterLazyAgentHandlers } from '../ipc/agent-lazy-handlers'
import type { AgentHandle } from '../agent/bootstrap'

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
let agentHandle: AgentHandle | null = null
let agentStartupPromise: Promise<void> | null = null
/**
 * Whether the MCP lifecycle owns a listening server for the current vault.
 *
 * The MCP server comes up before the agent runtime and survives a startAgent()
 * failure, so teardown cannot be keyed on agentHandle: the server outlives it,
 * and its tool closures hold this vault's data/index database handles.
 *
 * Tracked here rather than read back from the lifecycle module so closeVault()
 * does not have to import that module — and the MCP SDK and every vault tool it
 * pulls in — on the quit path of a user who never touched the agent.
 */
let agentMcpStarted = false

/**
 * How long stopVaultAgentServices() waits for an in-flight agent start before
 * tearing down without it.
 *
 * Derived from the shutdown budget, not picked for roundness: closeVault() is
 * the last step of the `before-quit` chain in main/index.ts, which force-exits
 * the app after 5000ms. flushAllWindows() ahead of it can already spend 2000ms
 * (flushWindow's default per-window timeout), and after this wait closeVault()
 * still has to stop the watcher, drain projections, stop the sync runtime and
 * close the databases. Claiming a third of the ~3000ms remainder keeps this
 * step from ever being the one that blows the budget.
 *
 * It is a backstop, not a throttle: a healthy start is a localhost HTTP bind,
 * one keychain read, a KDF and a few SQLite statements — orders of magnitude
 * under this — so the timeout only fires when the start is genuinely wedged.
 */
const AGENT_STARTUP_TEARDOWN_WAIT_MS = 1000
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

export function onVaultStatusChanged(listener: (status: VaultStatus) => void): () => void {
  statusListeners.add(listener)
  return () => {
    statusListeners.delete(listener)
  }
}

/**
 * Show native folder picker dialog
 */
async function showFolderPicker(): Promise<string | null> {
  const t = getMainI18n().getFixedT(null, 'system')
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
    title: t('dialog.vault.title'),
    buttonLabel: t('dialog.vault.button')
  })

  if (result.canceled || result.filePaths.length === 0) {
    return null
  }

  return result.filePaths[0]
}

/**
 * Show the native folder picker to the renderer (used by the multi-vault
 * linking picker to choose where adopted vaults are stored on disk).
 */
export const pickVaultFolder = (): Promise<string | null> => showFolderPicker()

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
export function createVaultInfo(vaultPath: string): VaultInfo {
  const config = readVaultConfig(vaultPath)
  const noteCount = countMarkdownFiles(vaultPath, config.excludePatterns)
  const existingVault = findVault(vaultPath)

  return {
    path: vaultPath,
    name: getVaultName(vaultPath),
    noteCount,
    taskCount: existingVault?.taskCount ?? 0,
    lastOpened: new Date().toISOString(),
    isDefault: existingVault?.isDefault ?? getVaults().length === 0,
    vaultUuid: existingVault?.vaultUuid
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
 * Emit indexing progress event to all windows
 */
export function emitIndexProgress(progress: number): void {
  updateStatus({ indexProgress: progress })
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
  // Automatic recovery from a corrupt/missing index (or a failed index
  // migration) is user-visible data-corruption recovery — count it in telemetry.
  trackMainLog('warn', {
    scope: 'vault',
    action: 'index_recovered',
    errorCode: event.reason,
    metrics: { durationMs: event.duration, itemCount: event.filesIndexed }
  })
  broadcastToAllWindows(VaultChannels.events.INDEX_RECOVERED, event)
}

/**
 * Open a vault: initialize structure, run migrations, start database, index notes
 */
async function openVault(vaultPath: string): Promise<void> {
  // Start from disk, never from whatever the previously open vault left behind.
  invalidateVaultConfigCache()

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

  // Create FTS5 virtual tables for tasks and inbox in data.db
  const dataDb = getDatabase()
  initializeFtsTasks(dataDb)
  initializeFtsInbox(dataDb)

  // Ensure task infrastructure expected by new vaults exists.
  ensureDefaultTaskProject(dataDb)

  // Migrate settings: config.json ↔ SQLite cache
  migrateSettingsToConfig(dataDb, vaultPath)

  // One-time: clear a collateral `spatialCanvas: false` left by pre-M7 writes.
  promoteSpatialCanvas(dataDb)

  // One-time import of pre-sync template files into the data DB. Settings
  // guarded, so deleted templates are never resurrected.
  migrateTemplateFilesToDb(dataDb, vaultPath)

  // Canvases are `.excalidraw` files in the vault: migrate any pre-file
  // encrypted snapshot, and adopt documents that arrived with the folder (USB,
  // git, Dropbox). Never blocks the open — a canvas failure must not cost the
  // user their notes.
  void reconcileCanvasFiles(dataDb, vaultPath).catch((error) => {
    logger.error('Canvas file reconcile failed:', error)
  })

  // Snapshot pre-frontmatter project links BEFORE the projection runtime can
  // reconcile any of them away. Only data.db is needed to read them; the write
  // half runs once the index cache is up (see below).
  snapshotProjectFrontmatterBackfill(dataDb)

  // Check index database health before proceeding
  const indexHealth: IndexHealth = checkIndexHealth(indexDbPath)
  if (indexHealth !== 'healthy') {
    logger.warn(`Index health check: ${indexHealth}`)
  }

  // Initialize property definitions service BEFORE indexing
  // so getPropertyType() finds correct types during note sync
  const propDefService = PropertyDefinitionsService.init(vaultPath)

  startProjectionRuntime([
    createNoteDerivedStateProjector(() => vaultPath),
    createSearchProjector(() => vaultPath),
    createEmbeddingProjector(
      () => vaultPath,
      () => currentStatus.isIndexing
    ),
    createInboxStatsProjector(),
    createNoteProjectLinksProjector()
  ])

  // Set the vault path before indexing so getConfig() (and the journal-config
  // holder) resolve the real config.json instead of the closed-vault fallback —
  // otherwise the initial index uses default journal config + empty excludes.
  updateStatus({ isIndexing: true, indexProgress: 0, path: vaultPath })

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

        // Reload property definitions into DB cache before indexing
        await propDefService.reload()

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
    trackMainError('vault', 'index_on_open', error)
    // Continue anyway - watcher will pick up files
  }

  // Write the snapshotted project links into note frontmatter. Here because
  // this is the first point the index cache `setEntityProperties` resolves
  // entities through is populated on both branches above, and still inside the
  // indexing window, so the embedding projector defers the notes it rewrites
  // instead of embedding each one inline (#803).
  try {
    await applyProjectFrontmatterBackfill(dataDb)
  } catch (error) {
    logger.error('Project frontmatter backfill failed:', error)
    trackMainError('vault', 'project_frontmatter_backfill', error)
  }

  updateStatus({ isIndexing: false, indexProgress: 100 })

  // Start file watcher for external changes
  await startWatcher(vaultPath)

  // Mark the vault open BEFORE the sync runtime starts: startSyncRuntime awaits
  // the engine's first fullSync, and on a freshly provisioned (downloaded or
  // linked) vault that pull writes notes/journals to disk via the current vault
  // path — which throws "No vault is currently open" if the status isn't set yet.
  //
  // Vault-open must NOT wait on embeddings: the renderer only needs the index
  // (built above) to render. Embedding is deferred out of the indexing pass —
  // the embedding projector no-ops while isIndexing and records the note ids —
  // so the ~23MB model load + per-note CPU inference never runs on the blocking
  // path (this stranded imported vaults on the picker for minutes; #803). The
  // backgrounded reconcileProjections() below embeds those deferred/missing
  // notes after isOpen; a slow or failed model load can no longer block open.
  updateStatus({
    isOpen: true,
    path: vaultPath,
    error: null
  })

  void reconcileProjections().catch((error) => {
    logger.error('Background projection reconcile failed:', error)
    trackMainError('vault', 'projection_reconcile', error)
  })

  // Register the agent IPC handlers before the sync runtime starts: agent chat
  // does not depend on sync, and if startSyncRuntime throws or stalls the agent
  // handlers would otherwise never register, leaving the pane stuck on
  // "Loading agent chat..." with "No handler registered".
  configureLazyAgentServices(startVaultAgentServices)
  registerLazyAgentHandlers()

  await startSyncRuntime()
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

    // Stamp the server vault uuid so the account vault directory can match
    // this vault without opening its data.db (best-effort: re-stamps next open)
    try {
      const { getOrCreateVaultUuid } = await import('../agent/storage/vault-id')
      const { getDatabase } = await import('../database/client')
      vaultInfo.vaultUuid = getOrCreateVaultUuid(getDatabase())
    } catch (err) {
      // vault opened without a data db (or uuid minting failed) — the registry
      // keeps any previously stored uuid (createVaultInfo carries it forward),
      // but a first-time stamp failure leaves this vault unmatched in the
      // account directory, so make it visible instead of swallowing it.
      logger.warn('Vault uuid stamp failed; account-directory match may be stale', {
        vaultPath,
        error: err instanceof Error ? err.message : String(err)
      })
    }

    // Store in electron-store
    setCurrentVaultPath(vaultPath)
    upsertVault(vaultInfo)
    touchVault(vaultPath)

    return { success: true, vault: vaultInfo }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to select vault'
    // The error envelope below is the only signal the IPC layer sees — the
    // handler never observes a throw — so report the failure here.
    trackMainError('vault', 'open', error)
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
    const fallback: VaultConfig = {
      excludePatterns: [],
      defaultNoteFolder: '',
      journalFolder: 'journal',
      journalDateFormat: 'YYYY-MM-DD',
      attachmentsFolder: 'attachments'
    }
    syncJournalConfig(fallback)
    return fallback
  }

  const config = readVaultConfig(currentStatus.path)
  const resolved: VaultConfig = {
    excludePatterns: config.excludePatterns,
    defaultNoteFolder: config.defaultNoteFolder,
    journalFolder: config.journalFolder,
    journalDateFormat: config.journalDateFormat,
    attachmentsFolder: config.attachmentsFolder
  }
  syncJournalConfig(resolved)
  return resolved
}

/**
 * Push journal settings into the process-wide holder, but only when they differ.
 *
 * getConfig() runs on most vault operations and many callers depend on it
 * keeping the holder fresh, so the side effect stays — writing an identical
 * value on every call is the part that was pure overhead.
 */
function syncJournalConfig(config: VaultConfig): void {
  const current = getJournalConfig()
  if (
    current.journalFolder === config.journalFolder &&
    current.journalDateFormat === config.journalDateFormat
  ) {
    return
  }
  setJournalConfig({
    journalFolder: config.journalFolder,
    journalDateFormat: config.journalDateFormat
  })
}

/**
 * Update vault configuration.
 * If excludePatterns change, the file watcher is restarted with the new patterns.
 */
/**
 * A full index pass runs with `isIndexing` set, and the embedding projector
 * defers every note it sees in that window instead of embedding it inline, to
 * keep the model load off the blocking path (#803). Only `openVault` reconciled
 * afterwards, so notes touched by a manual reindex or a structural config
 * rebuild kept a stale (or missing) vector — and their ids sat in the
 * projector's deferred set — until the next vault open.
 *
 * Backgrounded and scoped to the embedding projector: the caller must never
 * wait on a model load, and `stopProjectionRuntime` aborts the pass, so this
 * cannot hold vault close open.
 */
function drainDeferredEmbeddings(): void {
  void reconcileProjections(['embedding']).catch((error) => {
    logger.error('Deferred embedding drain failed:', error)
    trackMainError('vault', 'projection_reconcile', error)
  })
}

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

  // Re-index when config that affects note/journal classification changes, so the
  // collection/journal split and folder tree update live.
  const structuralChanged =
    oldConfig.journalFolder !== newConfig.journalFolder ||
    oldConfig.journalDateFormat !== newConfig.journalDateFormat ||
    oldConfig.defaultNoteFolder !== newConfig.defaultNoteFolder ||
    JSON.stringify(oldConfig.excludePatterns) !== JSON.stringify(newConfig.excludePatterns)

  if (structuralChanged) {
    logger.info('Structural vault config changed, rebuilding index...')
    updateStatus({ isIndexing: true, indexProgress: 0 })
    try {
      // Full rebuild, not incremental reindex: indexFile skips paths already in
      // cache, so re-classifying existing notes/journals needs a clean rebuild.
      await rebuildIndex(currentStatus.path)
    } finally {
      updateStatus({ isIndexing: false, indexProgress: 100 })
    }

    drainDeferredEmbeddings()
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

  await stopVaultAgentServices()

  // Stop file watcher
  await stopWatcher()

  await stopProjectionRuntime({ drain: true })

  await stopSyncRuntime()

  PropertyDefinitionsService.destroy()

  invalidateVaultConfigCache()

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

async function startVaultAgentServices(): Promise<void> {
  if (agentHandle) return
  if (agentStartupPromise) return agentStartupPromise

  agentStartupPromise = startVaultAgentServicesOnce().finally(() => {
    agentStartupPromise = null
  })
  return agentStartupPromise
}

async function startVaultAgentServicesOnce(): Promise<void> {
  try {
    const [{ startAgentMcpLifecycle }, { startAgent }] = await Promise.all([
      import('../agent/mcp/lifecycle'),
      import('../agent/bootstrap')
    ])

    await startAgentMcpLifecycle()
    agentMcpStarted = true
    agentHandle = await startAgent()
  } catch (error) {
    logger.warn('Agent runtime failed to start:', error)
    agentHandle = null
  }
}

async function stopVaultAgentServices(): Promise<void> {
  configureLazyAgentServices(null)
  unregisterLazyAgentHandlers()

  // A start that is still in flight owns this vault's db handles and calls
  // registerAgentHandlers() when it resolves. Dropping the promise here let it
  // land after the *next* vault had registered its own handlers, replacing them
  // with handlers closed over the previous vault's db/conversations/vaultId,
  // and left that runtime alive (vault key unzeroed, subprocesses running).
  // Waiting makes the handle read below the one to tear down.
  //
  // The wait is bounded because closeVault() also runs on the quit path, where
  // main/index.ts force-exits the app once its 5s budget is gone. A start
  // that never settles must not turn the leak into a hung quit — on timeout,
  // fall through to the teardown below and accept that the orphan may still
  // land late (the pre-fix behaviour), which is strictly better than freezing.
  if (agentStartupPromise) {
    let settleTimer: ReturnType<typeof setTimeout> | undefined
    const settled = await Promise.race([
      // startVaultAgentServicesOnce swallows its own failures, so this only
      // rejects if that ever changes; either way the start is over.
      agentStartupPromise.then(
        () => true,
        () => true
      ),
      new Promise<boolean>((resolve) => {
        settleTimer = setTimeout(() => resolve(false), AGENT_STARTUP_TEARDOWN_WAIT_MS)
      })
    ])
    clearTimeout(settleTimer)
    if (!settled) {
      logger.warn(
        `Agent startup did not settle within ${AGENT_STARTUP_TEARDOWN_WAIT_MS}ms; tearing down without it`
      )
    }
  }

  const currentAgentHandle = agentHandle
  const mcpStarted = agentMcpStarted
  agentHandle = null
  agentStartupPromise = null
  agentMcpStarted = false

  // Not `!currentAgentHandle` alone: startAgent() can throw after the MCP
  // server is listening, and skipping teardown then left a bearer-authenticated
  // localhost server holding the outgoing vault's database handles. Because
  // startAgentMcpLifecycle() early-returns while its handle is set, the next
  // vault inherited that server instead of binding one to its own databases.
  if (!currentAgentHandle && !mcpStarted) return

  const { stopAgentMcpLifecycle } = await import('../agent/mcp/lifecycle')
  // The agent runtime routes its tool calls through this server, so it goes
  // first; on the failed-start path there is no runtime left to stop.
  await currentAgentHandle?.shutdown()
  await stopAgentMcpLifecycle()
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
    drainDeferredEmbeddings()
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

  // Dev ergonomics: land on the vault picker instead of restoring the last
  // vault. Opt-in via MEMRY_FORCE_VAULT_PICKER=1 (wired into the dev scripts).
  if (process.env.MEMRY_FORCE_VAULT_PICKER === '1') {
    return
  }

  const lastVault = getCurrentVaultPath()

  if (lastVault && isVaultInitialized(lastVault)) {
    try {
      await openVault(lastVault)
      touchVault(lastVault)
      // The IPC handlers only track explicit select/switch/download-remote;
      // without this the most common open path (app launch) is never counted.
      trackMainEvent('vault_opened', {
        surface: 'vault',
        action: 'opened',
        source: 'auto',
        result: 'success'
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to open last vault'
      logger.error('Auto-open of last vault failed:', error)
      trackMainError('vault', 'auto_open', error)
      updateStatus({ error: message })
      // Clear the invalid vault path
      setCurrentVaultPath(null)
    }
  }
}
